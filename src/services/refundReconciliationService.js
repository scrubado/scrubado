"use strict";

// Shared refund reconciliation used by signed Stripe webhooks and (later)
// an administrator-only recovery endpoint. This service NEVER creates a refund.
// Caller must retrieve the current Refund from Stripe before invoking.
const pool = require("../db");

const allowedStatuses = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);

async function reconcileRefund({ stripe, refund, event = null, adminUserId = null }) {
  const paymentIntentId = typeof refund?.payment_intent === "string"
    ? refund.payment_intent : refund?.payment_intent?.id;
  if (!stripe || !refund || refund.livemode === true ||
      typeof refund.id !== "string" || typeof paymentIntentId !== "string" ||
      !Number.isSafeInteger(refund.amount) || refund.amount <= 0 ||
      refund.currency !== "usd" || !allowedStatuses.has(refund.status)) {
    throw new Error("Invalid Stripe test refund for reconciliation");
  }
  if (event && (!event.id || !event.type?.startsWith("refund."))) {
    throw new Error("Invalid refund webhook event");
  }

  // Validate the current Stripe PaymentIntent outside the database transaction.
  // All database changes below occur atomically under consistent row locks.
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (intent.livemode !== false || intent.id !== paymentIntentId ||
      intent.status !== "succeeded" || intent.currency !== "usd" ||
      intent.amount !== refund.amount || intent.amount_received !== refund.amount) {
    throw new Error("Original Stripe payment requires reconciliation");
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    let eventRowId = null;
    if (event) {
      const claim = await client.query(`
        INSERT INTO public.stripe_webhook_events
          (stripe_event_id, event_type, stripe_payment_intent_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id
      `, [event.id, event.type, paymentIntentId]);
      if (!claim.rowCount) {
        await client.query("COMMIT");
        return { received: true, duplicate: true };
      }
      eventRowId = claim.rows[0].id;
    }

    const located = await client.query(`
      SELECT pr.id AS refund_id, p.id AS payment_id, p.booking_id
      FROM public.payment_refunds pr
      JOIN public.payments p ON p.id = pr.payment_id
      WHERE pr.id::text = $1
        AND p.stripe_payment_intent_id = $2
    `, [refund.metadata?.refund_operation_id || "", paymentIntentId]);

    if (!located.rowCount) {
      if (eventRowId) {
        await client.query(`UPDATE public.stripe_webhook_events
          SET processed_at = NOW() WHERE id = $1`, [eventRowId]);
      }
      await client.query("COMMIT");
      return { received: true, ignored: true };
    }

    const { refund_id: refundId, payment_id: paymentId, booking_id: bookingId } = located.rows[0];
    const b = await client.query(`
      SELECT id, status, customer_id, quoted_price_cents
      FROM public.bookings WHERE id = $1 FOR UPDATE
    `, [bookingId]);
    const p = await client.query(`
      SELECT id, booking_id, customer_id, status, amount_cents, currency,
             stripe_payment_intent_id
      FROM public.payments WHERE id = $1 FOR UPDATE
    `, [paymentId]);
    const r = await client.query(`
      SELECT id, payment_id, requested_by, amount_cents, currency, status,
             stripe_refund_id
      FROM public.payment_refunds WHERE id = $1 FOR UPDATE
    `, [refundId]);
    const booking = b.rows[0];
    const payment = p.rows[0];
    const record = r.rows[0];
    if (!booking || !payment || !record ||
        payment.booking_id !== bookingId ||
        payment.customer_id !== booking.customer_id ||
        payment.status !== "succeeded" || record.payment_id !== payment.id ||
        record.currency !== "usd" || payment.currency !== "usd" ||
        Number(payment.amount_cents) !== refund.amount ||
        Number(record.amount_cents) !== refund.amount ||
        String(booking.quoted_price_cents) !== String(record.amount_cents) ||
        (record.stripe_refund_id && record.stripe_refund_id !== refund.id) ||
        refund.metadata?.booking_id !== bookingId ||
        refund.metadata?.payment_id !== payment.id ||
        refund.metadata?.refund_operation_id !== record.id ||
        intent.metadata?.booking_id !== bookingId ||
        intent.metadata?.payment_id !== payment.id) {
      throw new Error("Refund identity, amount, or booking mismatch; manual review required");
    }

    const status = ["pending", "requires_action"].includes(refund.status)
      ? "processing" : refund.status;
    // Never downgrade a terminal success on later/out-of-order Stripe events.
    if (record.status === "succeeded" && status !== "succeeded") {
      throw new Error("Stripe state contradicts previously successful refund; manual review required");
    }
    // A fully reconciled operation is a no-op, including on repeated admin calls.
    // Record a new webhook delivery, but don't mutate payment, booking, or audit history.
    if (record.status === status && record.stripe_refund_id === refund.id &&
        (status !== "succeeded" || booking.status === "cancelled")) {
      if (eventRowId) {
        await client.query(`UPDATE public.stripe_webhook_events
          SET processed_at = NOW() WHERE id = $1`, [eventRowId]);
      }
      await client.query("COMMIT");
      return { received: true, already_reconciled: true,
        refund_status: status, booking_cancelled: false, reconciliation_required: false };
    }
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
      if (changed.rowCount !== 1) throw new Error("Refund cancellation race; retry reconciliation");
      await client.query(`
        INSERT INTO public.audit_logs
          (actor_user_id, action, entity_type, entity_id, old_values, new_values)
        VALUES ($1, 'booking.cancelled', 'booking', $2,
                jsonb_build_object('status', 'confirmed'),
                jsonb_build_object('status', 'cancelled',
                                   'reason', 'customer_cancellation_full_refund',
                                   'refund_id', $3::text,
                                   'stripe_event_id', $4::text,
                                   'reconciliation_source', $5::text,
                                   'allocated_cleaner_records_preserved', $6::integer))
      `, [record.requested_by, bookingId, record.id, event?.id || null,
          event ? "stripe_webhook" : "admin_recovery",
          allocations.rows[0].allocated_count]);
      bookingCancelled = true;
    } else if (refund.status === "succeeded" && booking.status !== "cancelled") {
      await client.query(`
        INSERT INTO public.audit_logs
          (actor_user_id, action, entity_type, entity_id, old_values, new_values)
        VALUES ($1, 'refund.cancellation_review_required', 'payment', $2,
                jsonb_build_object('booking_status', $3::text),
                jsonb_build_object('stripe_status', 'succeeded',
                                   'refund_id', $4::text, 'booking_id', $5::text,
                                   'stripe_event_id', $6::text))
      `, [adminUserId, payment.id, booking.status, record.id, bookingId, event?.id || null]);
      reconciliationRequired = true;
    }

    if (eventRowId) {
      await client.query(`UPDATE public.stripe_webhook_events
        SET processed_at = NOW() WHERE id = $1`, [eventRowId]);
    }
    if (!event && adminUserId) {
      await client.query(`
        INSERT INTO public.audit_logs
          (actor_user_id, action, entity_type, entity_id, old_values, new_values)
        VALUES ($1, 'refund.admin_reconciled', 'payment', $2,
                jsonb_build_object('refund_status', $3::text),
                jsonb_build_object('refund_status', $4::text,
                                   'refund_id', $5::text,
                                   'booking_cancelled', $6::boolean))
      `, [adminUserId, payment.id, record.status, status, record.id, bookingCancelled]);
    }
    await client.query("COMMIT");
    return { received: true, refund_status: status,
      booking_cancelled: bookingCancelled, reconciliation_required: reconciliationRequired };
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* best effort */ }
    }
    throw error;
  } finally {
    if (client) client.release();
  }
}

module.exports = { reconcileRefund };