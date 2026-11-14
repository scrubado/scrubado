"use strict";

// Save as src/routes/stripeWebhook.js.
// DEVELOPMENT/STRIPE TEST MODE ONLY.
// Must be mounted BEFORE express.json() so Stripe receives the signed raw body.
// A verified succeeded PaymentIntent and booking confirmation share ONE DB transaction.

const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");

const router = express.Router();
const trackedTypes = new Set([
  "payment_intent.created",
  "payment_intent.requires_action",
  "payment_intent.amount_capturable_updated",
  "payment_intent.processing",
  "payment_intent.payment_failed",
  "payment_intent.succeeded",
  "payment_intent.canceled",
  "refund.created",
  "refund.updated",
  "refund.failed"
]);
const states = new Set([
  "requires_payment_method", "requires_action", "processing",
  "requires_capture", "succeeded", "canceled"
]);

// A refund event can reach this handler before bookingRefund.js has persisted
// stripe_refund_id. The refund's own operation metadata identifies our durable
// database row; never match only on amount or customer-provided information.
async function processRefundEvent(stripe, event, res) {
  const eventRefund = event.data && event.data.object;
  if (!eventRefund || eventRefund.object !== "refund" ||
      typeof eventRefund.id !== "string") {
    return res.status(400).json({ error: "Unexpected refund event object" });
  }

  let refund;
  try {
    // Read the current status, not the possibly stale event payload.
    refund = await stripe.refunds.retrieve(eventRefund.id);
  } catch (error) {
    console.error("Stripe refund retrieval failed:", error.type || error.message);
    return res.status(503).json({ error: "Unable to verify Stripe refund" });
  }
  const paymentIntentId = typeof refund.payment_intent === "string"
    ? refund.payment_intent : refund.payment_intent?.id;
  if (refund.livemode || typeof paymentIntentId !== "string" ||
      !Number.isSafeInteger(refund.amount) || refund.amount <= 0 ||
      refund.currency !== "usd" ||
      !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(refund.status)) {
    return res.status(422).json({ error: "Unexpected Stripe refund state" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const claimed = await client.query(`
      INSERT INTO public.stripe_webhook_events
        (stripe_event_id, event_type, stripe_payment_intent_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id
    `, [event.id, event.type, paymentIntentId]);
    if (!claimed.rowCount) {
      await client.query("COMMIT");
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Locate records without acquiring row locks, then acquire locks in the
    // same booking -> payment -> refund order as the refund request route.
    const located = await client.query(`
      SELECT pr.id AS refund_id, p.id AS payment_id, p.booking_id
      FROM public.payment_refunds pr
      JOIN public.payments p ON p.id = pr.payment_id
      WHERE pr.id::text = $1
        AND p.stripe_payment_intent_id = $2
    `, [refund.metadata?.refund_operation_id || "", paymentIntentId]);
    if (!located.rowCount) {
      // A signed event for a different Stripe payment is not our refund.
      // Never infer ownership based solely on the Stripe refund ID.
      await client.query(`
        UPDATE public.stripe_webhook_events SET processed_at = NOW() WHERE id = $1
      `, [claimed.rows[0].id]);
      await client.query("COMMIT");
      return res.status(200).json({ received: true, ignored: true });
    }
    const { refund_id: refundId, payment_id: paymentId, booking_id: bookingId } = located.rows[0];

    const bookingFound = await client.query(`
      SELECT id, status, customer_id, quoted_price_cents
      FROM public.bookings WHERE id = $1 FOR UPDATE
    `, [bookingId]);
    const paymentFound = await client.query(`
      SELECT id, booking_id, customer_id, status, amount_cents, currency,
             stripe_payment_intent_id
      FROM public.payments WHERE id = $1 FOR UPDATE
    `, [paymentId]);
    const refundFound = await client.query(`
      SELECT id, payment_id, requested_by, amount_cents, currency, status, stripe_refund_id
      FROM public.payment_refunds WHERE id = $1 FOR UPDATE
    `, [refundId]);
    const booking = bookingFound.rows[0];
    const payment = paymentFound.rows[0];
    const record = refundFound.rows[0];
    if (!booking || !payment || !record ||
        payment.booking_id !== bookingId ||
        payment.customer_id !== booking.customer_id ||
        payment.status !== "succeeded" ||
        record.payment_id !== payment.id ||
        record.currency !== "usd" || payment.currency !== "usd" ||
        Number(payment.amount_cents) !== refund.amount ||
        Number(record.amount_cents) !== refund.amount ||
        String(booking.quoted_price_cents) !== String(record.amount_cents) ||
        record.stripe_refund_id && record.stripe_refund_id !== refund.id ||
        refund.metadata?.booking_id !== bookingId ||
        refund.metadata?.payment_id !== payment.id ||
        refund.metadata?.refund_operation_id !== record.id) {
      throw new Error("Refund identity, amount, or booking mismatch; review required");
    }

    // Verify the Stripe payment is the original successfully collected amount.
    // This prevents a refund object alone from authorizing a cancellation.
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.livemode || intent.id !== payment.stripe_payment_intent_id ||
        intent.status !== "succeeded" || intent.currency !== "usd" ||
        intent.amount !== refund.amount || intent.amount_received !== refund.amount ||
        intent.metadata?.booking_id !== bookingId ||
        intent.metadata?.payment_id !== payment.id) {
      throw new Error("Original Stripe payment requires reconciliation");
    }

    const status = refund.status === "pending" || refund.status === "requires_action"
      ? "processing" : refund.status;
    await client.query(`
      UPDATE public.payment_refunds
      SET stripe_refund_id = COALESCE(stripe_refund_id, $1),
          status = $2::varchar,
          completed_at = CASE WHEN $2::varchar = 'succeeded'
                              THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
          last_error = CASE WHEN $2::varchar = 'failed'
                            THEN 'Stripe reported refund failure; investigate'
                            WHEN $2::varchar = 'succeeded' THEN NULL
                            ELSE last_error END,
          updated_at = NOW()
      WHERE id = $3
    `, [refund.id, status, record.id]);

    let bookingCancelled = false;
    let reconciliationRequired = false;
    if (refund.status === "succeeded" && booking.status === "confirmed") {
      // The refund is verified. Keep original payment succeeded for accounting.
      const allocations = await client.query(`
        SELECT COUNT(*)::integer AS allocated_count
        FROM public.booking_cleaners
        WHERE booking_id = $1 AND assignment_status = 'assigned'
          AND payout_cents IS NOT NULL
      `, [bookingId]);
      await client.query(`
        UPDATE public.booking_cleaners
        SET assignment_status = 'removed', updated_at = NOW()
        WHERE booking_id = $1 AND assignment_status = 'assigned'
      `, [bookingId]);
      const changed = await client.query(`
        UPDATE public.bookings SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND status = 'confirmed' RETURNING id
      `, [bookingId]);
      if (changed.rowCount !== 1) throw new Error("Refund cancellation race; retry event");
      await client.query(`
        INSERT INTO public.audit_logs
          (actor_user_id, action, entity_type, entity_id, old_values, new_values)
        VALUES ($1, 'booking.cancelled', 'booking', $2,
                jsonb_build_object('status', 'confirmed'),
                jsonb_build_object('status', 'cancelled',
                                   'reason', 'customer_cancellation_full_refund',
                                   'refund_id', $3::text,
                                   'stripe_event_id', $4::text,
                                   'allocated_cleaner_records_preserved', $5::integer))
      `, [record.requested_by, bookingId, record.id, event.id, allocations.rows[0].allocated_count]);
      bookingCancelled = true;
    } else if (refund.status === "succeeded" && booking.status !== "cancelled") {
      // Never force in-progress/completed jobs into cancelled.
      await client.query(`
        INSERT INTO public.audit_logs
          (actor_user_id, action, entity_type, entity_id, old_values, new_values)
        VALUES (NULL, 'refund.cancellation_review_required', 'payment', $1,
                jsonb_build_object('booking_status', $2::text),
                jsonb_build_object('stripe_status', 'succeeded',
                                   'refund_id', $3::text, 'booking_id', $4::text,
                                   'stripe_event_id', $5::text))
      `, [payment.id, booking.status, record.id, bookingId, event.id]);
      reconciliationRequired = true;
    }

    await client.query(`
      UPDATE public.stripe_webhook_events SET processed_at = NOW() WHERE id = $1
    `, [claimed.rows[0].id]);
    await client.query("COMMIT");
    if (reconciliationRequired) {
      console.error("REFUND REQUIRES REVIEW:", { bookingId, refundId, stripeEventId: event.id });
    }
    return res.status(200).json({
      received: true, refund_status: status,
      booking_cancelled: bookingCancelled, reconciliation_required: reconciliationRequired
    });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* best effort */ }
    }
    console.error("Refund webhook processing failed:", error.message);
    return res.status(500).json({ error: "Refund webhook processing failed" });
  } finally {
    if (client) client.release();
  }
}

router.post("/", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  if (process.env.NODE_ENV === "production" ||
      process.env.ENABLE_DEV_PAYMENT_INTENTS !== "true") {
    return res.status(503).json({ error: "Payment webhooks are not enabled" });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  const signingSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !key.startsWith("sk_test_") ||
      !signingSecret || !signingSecret.startsWith("whsec_")) {
    return res.status(503).json({ error: "Stripe test webhook is not configured" });
  }
  const signature = req.get("stripe-signature");
  if (!signature || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: "Raw signed webhook body required" });
  }

  const stripe = new Stripe(key, { timeout: 12000, maxNetworkRetries: 1 });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, signingSecret);
  } catch {
    return res.status(400).json({ error: "Invalid Stripe webhook signature" });
  }
  if (event.livemode) {
    return res.status(400).json({ error: "Live Stripe events are disabled" });
  }
  if (!trackedTypes.has(event.type)) {
    return res.status(200).json({ received: true, ignored: true });
  }
  if (event.type.startsWith("refund.")) {
    return processRefundEvent(stripe, event, res);
  }
  const eventIntent = event.data && event.data.object;
  if (!eventIntent || eventIntent.object !== "payment_intent" ||
      typeof eventIntent.id !== "string") {
    return res.status(400).json({ error: "Unexpected Stripe event object" });
  }

  // Re-fetch CURRENT Stripe state. Webhooks can arrive late or out of order.
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(eventIntent.id);
  } catch (error) {
    console.error("Stripe webhook intent lookup failed:", error.type || error.message);
    return res.status(503).json({ error: "Unable to verify Stripe payment state" });
  }
  if (intent.livemode || !states.has(intent.status) ||
      !Number.isSafeInteger(intent.amount) || intent.amount <= 0 ||
      intent.currency !== "usd") {
    return res.status(422).json({ error: "Unexpected Stripe payment state" });
  }
  const dbStatus = intent.status === "canceled" ? "cancelled" : intent.status;

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Claim each delivery once, in the transaction that processes it.
    const claimed = await client.query(`
      INSERT INTO public.stripe_webhook_events
        (stripe_event_id, event_type, stripe_payment_intent_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING id
    `, [event.id, event.type, intent.id]);
    if (!claimed.rowCount) {
      await client.query("COMMIT");
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Find booking ID WITHOUT locking payment first. Locking order is always
    // booking -> payment, matching create-intent and bookingCancellation routes.
    const located = await client.query(`
      SELECT booking_id FROM public.payments
      WHERE stripe_payment_intent_id = $1
    `, [intent.id]);
    if (!located.rowCount) {
      // Other Stripe CLI fixture intents are not Scrubado payments.
      await client.query(`
        UPDATE public.stripe_webhook_events SET processed_at = NOW() WHERE id = $1
      `, [claimed.rows[0].id]);
      await client.query("COMMIT");
      return res.status(200).json({ received: true, ignored: true });
    }

    const bookingId = located.rows[0].booking_id;
    const bookingResult = await client.query(`
      SELECT b.id, b.status, b.customer_id, b.quoted_price_cents,
             b.required_crew_size, q.status AS quote_status,
             (SELECT COUNT(*)::integer FROM public.booking_cleaners bc
               WHERE bc.booking_id = b.id AND bc.assignment_status = 'assigned') AS crew_count,
             (SELECT COUNT(*)::integer FROM public.booking_cleaners bc
               WHERE bc.booking_id = b.id AND bc.assignment_status = 'assigned'
                 AND bc.crew_role = 'lead') AS leads,
             (SELECT COUNT(*)::integer FROM public.booking_cleaners bc
               WHERE bc.booking_id = b.id AND bc.assignment_status = 'assigned'
                 AND bc.crew_role = 'second') AS seconds
      FROM public.bookings b
      JOIN public.quotes q ON q.id = b.quote_id
      WHERE b.id = $1 FOR UPDATE OF b
    `, [bookingId]);
    const booking = bookingResult.rows[0];
    if (!booking) throw new Error("Webhook booking missing; manual reconciliation required");

    const paymentResult = await client.query(`
      SELECT id, booking_id, customer_id, amount_cents, currency, status
      FROM public.payments
      WHERE stripe_payment_intent_id = $1 FOR UPDATE
    `, [intent.id]);
    const payment = paymentResult.rows[0];
    if (!payment || payment.booking_id !== bookingId ||
        payment.customer_id !== booking.customer_id ||
        Number(payment.amount_cents) !== intent.amount ||
        String(booking.quoted_price_cents) !== String(payment.amount_cents) ||
        payment.currency !== intent.currency ||
        intent.metadata?.booking_id !== bookingId ||
        intent.metadata?.payment_id !== payment.id) {
      throw new Error("Webhook booking/payment/Stripe amount or metadata mismatch");
    }

    // Protect against stale Stripe events downgrading a terminal record.
    // If Stripe reports a captured payment on a cancelled booking, retain
    // the cancelled booking, record the money received and flag refund review.
    if ((booking.status === "cancelled" && intent.status !== "succeeded") ||
        (payment.status === "succeeded" && intent.status !== "succeeded")) {
      await client.query(`
        UPDATE public.stripe_webhook_events SET processed_at = NOW() WHERE id = $1
      `, [claimed.rows[0].id]);
      await client.query("COMMIT");
      return res.status(200).json({ received: true, ignored_stale_state: true });
    }

    await client.query(`
      UPDATE public.payments
      SET status = $1::varchar,
          stripe_last_event_id = $2,
          paid_at = CASE WHEN $1::varchar = 'succeeded'
                         THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
          updated_at = NOW()
      WHERE id = $3
    `, [dbStatus, event.id, payment.id]);

    let bookingConfirmed = false;
    let reconciliationRequired = false;
    if (intent.status === "succeeded") {
      const eligibleCrew = (booking.required_crew_size === 1 || booking.required_crew_size === 2) &&
        booking.crew_count === booking.required_crew_size && booking.leads === 1 &&
        booking.seconds === (booking.required_crew_size === 2 ? 1 : 0);
      const autoCapture = intent.capture_method === "automatic_async";

      if (booking.status === "accepted" && booking.quote_status === "used" &&
          eligibleCrew && autoCapture) {
        const changed = await client.query(`
          UPDATE public.bookings
          SET status = 'confirmed', updated_at = NOW()
          WHERE id = $1 AND status = 'accepted'
          RETURNING id
        `, [bookingId]);
        if (changed.rowCount !== 1) throw new Error("Booking confirmation race; retry webhook");
        await client.query(`
          INSERT INTO public.audit_logs
            (actor_user_id, action, entity_type, entity_id, old_values, new_values)
          VALUES (NULL, 'booking.confirmed', 'booking', $1,
                  jsonb_build_object('status', 'accepted'),
                  jsonb_build_object('status', 'confirmed',
                                     'payment_id', $2::text,
                                     'stripe_event_id', $3::text))
        `, [bookingId, payment.id, event.id]);
        bookingConfirmed = true;
      } else if (booking.status !== "confirmed") {
        // Do NOT confirm canceled or otherwise ineligible bookings.
        // A real charge can still exist and needs explicit refund/review.
        await client.query(`
          INSERT INTO public.audit_logs
            (actor_user_id, action, entity_type, entity_id, old_values, new_values)
          VALUES (NULL, 'payment.confirmation_review_required', 'payment', $1,
                  jsonb_build_object('booking_status', $2::text),
                  jsonb_build_object('stripe_status', 'succeeded',
                                     'booking_id', $3::text,
                                     'stripe_event_id', $4::text,
                                     'capture_method', $5::text))
        `, [payment.id, booking.status, bookingId, event.id, intent.capture_method]);
        reconciliationRequired = true;
      }
    }

    await client.query(`
      UPDATE public.stripe_webhook_events SET processed_at = NOW() WHERE id = $1
    `, [claimed.rows[0].id]);
    await client.query("COMMIT");
    if (reconciliationRequired) {
      console.error("PAYMENT REQUIRES REVIEW: captured payment with ineligible booking", {
        bookingId, paymentId: payment.id, stripeEventId: event.id
      });
    }
    return res.status(200).json({
      received: true,
      booking_confirmed: bookingConfirmed,
      reconciliation_required: reconciliationRequired
    });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be gone */ }
    }
    console.error("Stripe webhook processing failed:", error.message);
    return res.status(500).json({ error: "Webhook processing failed" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;