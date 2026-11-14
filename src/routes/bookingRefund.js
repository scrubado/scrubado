"use strict";

// Save as src/routes/bookingRefund.js
// DEVELOPMENT / STRIPE TEST MODE ONLY.
// POST /api/bookings/:id/refund requests ONE FULL refund for a confirmed booking.
// Does NOT mark a booking cancelled or declare the refund completed.
// A verified Stripe refund webhook/reconciliation process must finalize both.

const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");
const { authenticateCustomer } = require("../middleware/authenticate");

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post("/:id/refund", authenticateCustomer, async (req, res) => {
  if (process.env.NODE_ENV === "production" ||
      process.env.ENABLE_DEV_PAYMENT_INTENTS !== "true") {
    return res.status(503).json({ error: "Test refunds are not enabled" });
  }
  if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return res.status(503).json({ error: "Stripe test mode is not configured" });
  }
  const bookingId = req.params.id;
  if (!UUID.test(bookingId || "")) {
    return res.status(400).json({ error: "Invalid booking ID" });
  }
  // This test-only endpoint implements a full customer-cancellation refund.
  // Do not accept arbitrary refund amounts or reasons from the client.
  if (req.body && Object.keys(req.body).length !== 0) {
    return res.status(400).json({ error: "Refund request must have an empty JSON body" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    timeout: 12000, maxNetworkRetries: 1
  });
  let client;
  let tx = false;
  let row;
  try {
    client = await pool.connect();
    await client.query("BEGIN"); tx = true;

    // Match existing lock hierarchy: booking -> payment -> refund operation.
    const foundBooking = await client.query(`
      SELECT id, customer_id, status, quoted_price_cents
      FROM public.bookings WHERE id = $1 FOR UPDATE
    `, [bookingId]);
    const booking = foundBooking.rows[0];
    if (!booking || booking.customer_id !== req.customer.customer_profile_id) {
      await client.query("ROLLBACK"); tx = false;
      return res.status(404).json({ error: "Booking not found" });
    }
    if (booking.status !== "confirmed") {
      await client.query("ROLLBACK"); tx = false;
      return res.status(409).json({ error: "Only confirmed bookings qualify for this test refund" });
    }

    const foundPayment = await client.query(`
      SELECT id, booking_id, customer_id, amount_cents, currency,
             status, stripe_payment_intent_id
      FROM public.payments WHERE booking_id = $1 FOR UPDATE
    `, [bookingId]);
    const payment = foundPayment.rows[0];
    if (!payment || payment.customer_id !== req.customer.customer_profile_id ||
        payment.status !== "succeeded" || !payment.stripe_payment_intent_id ||
        payment.currency !== "usd" ||
        String(payment.amount_cents) !== String(booking.quoted_price_cents) ||
        !Number.isSafeInteger(Number(payment.amount_cents))) {
      await client.query("ROLLBACK"); tx = false;
      return res.status(409).json({ error: "Payment needs reconciliation before refund" });
    }

    // A pending cancellation operation for an uncaptured intent conflicts with
    // the paid-refund flow. Fail closed rather than mixing the workflows.
    const existingCancel = await client.query(`
      SELECT status FROM public.booking_cancellation_operations
      WHERE booking_id = $1
    `, [bookingId]);
    if (existingCancel.rowCount) {
      await client.query("ROLLBACK"); tx = false;
      return res.status(409).json({ error: "Existing cancellation operation needs review" });
    }

    await client.query(`
      INSERT INTO public.payment_refunds
        (payment_id, requested_by, amount_cents, currency, status, reason)
      VALUES ($1, $2, $3, 'usd', 'pending', 'customer_cancellation')
      ON CONFLICT (payment_id) DO NOTHING
    `, [payment.id, req.customer.id, payment.amount_cents]);

    const existing = await client.query(`
      SELECT id, payment_id, requested_by, amount_cents, currency, status,
             stripe_refund_id, idempotency_key
      FROM public.payment_refunds WHERE payment_id = $1 FOR UPDATE
    `, [payment.id]);
    row = existing.rows[0];
    if (!row || row.requested_by !== req.customer.id ||
        String(row.amount_cents) !== String(payment.amount_cents) ||
        row.currency !== "usd") {
      await client.query("ROLLBACK"); tx = false;
      return res.status(409).json({ error: "Refund operation does not match payment" });
    }
    if (row.status === "succeeded" || row.status === "canceled" || row.status === "failed") {
      await client.query("COMMIT"); tx = false;
      return res.status(200).json({
        booking_id: bookingId, refund_id: row.id, status: row.status,
        duplicate: true, note: "Existing refund result; booking status requires separate verification"
      });
    }
    await client.query("COMMIT"); tx = false;

    // Never infer success solely from local DB state. Validate the current
    // PaymentIntent in Stripe before initiating any refund.
    const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
    if (intent.livemode || intent.id !== payment.stripe_payment_intent_id ||
        intent.status !== "succeeded" || intent.currency !== "usd" ||
        intent.amount !== Number(payment.amount_cents) ||
        intent.amount_received !== Number(payment.amount_cents) ||
        intent.metadata?.booking_id !== bookingId ||
        intent.metadata?.payment_id !== payment.id) {
      return res.status(409).json({ error: "Stripe payment requires investigation before refund" });
    }

    // A stable operation idempotency key prevents multiple refunds on retries.
    // Even if an earlier request succeeded but the DB response was lost,
    // retrying uses the same key and the same amount and parameters.
    let refund;
    if (row.stripe_refund_id) {
      refund = await stripe.refunds.retrieve(row.stripe_refund_id);
    } else {
      refund = await stripe.refunds.create({
        payment_intent: intent.id,
        amount: Number(payment.amount_cents),
        reason: "requested_by_customer",
        metadata: { booking_id: bookingId, payment_id: payment.id, refund_operation_id: row.id }
      }, { idempotencyKey: `scrubado-full-refund-${row.idempotency_key}` });
    }
    if (refund.livemode || refund.payment_intent !== intent.id ||
        refund.amount !== Number(payment.amount_cents) ||
        refund.currency !== "usd" ||
        !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(refund.status)) {
      return res.status(503).json({ error: "Refund requires manual reconciliation" });
    }

    // Refund event may have arrived before this local update. Never downgrade
    // a terminal state. Do NOT cancel the booking in this request handler.
    await client.query("BEGIN"); tx = true;
    const changed = await client.query(`
      UPDATE public.payment_refunds
      SET stripe_refund_id = COALESCE(stripe_refund_id, $1),
          status = CASE WHEN status IN ('succeeded', 'failed', 'canceled')
                        THEN status ELSE 'processing' END,
          updated_at = NOW(), last_error = NULL
      WHERE id = $2 AND (stripe_refund_id IS NULL OR stripe_refund_id = $1)
      RETURNING id, status
    `, [refund.id, row.id]);
    if (!changed.rowCount) throw new Error("Refund ID conflict; reconciliation required");
    await client.query("COMMIT"); tx = false;

    return res.status(202).json({
      booking_id: bookingId, refund_id: row.id,
      stripe_refund_id: refund.id, stripe_status: refund.status,
      status: changed.rows[0].status,
      note: "Sandbox refund requested. Finalization and booking cancellation require verified refund reconciliation."
    });
  } catch (error) {
    if (client && tx) {
      try { await client.query("ROLLBACK"); } catch { /* best effort */ }
    }
    console.error("Test refund request failed:", error.type || error.code || error.message);
    return res.status(503).json({ error: "Refund state uncertain; retry with same operation or reconcile" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;