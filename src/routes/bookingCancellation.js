"use strict";

// Save this file as src/routes/bookingCancellation.js.
// DEVELOPMENT ONLY. Customer-initiated cancellation of an uncaptured booking.
// Uses a durable cancellation operation and a stable Stripe idempotency key.
// Allocated cleaner amounts are retained for later accounting review.

const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");
const { authenticateCustomer } = require("../middleware/authenticate");

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cancellableBookings = new Set(["requested", "accepted", "confirmed"]);
const cancellableIntents = new Set([
  "requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"
]);

router.post("/:id/cancel", authenticateCustomer, async (req, res) => {
  if (process.env.NODE_ENV === "production" ||
      process.env.ENABLE_DEV_PAYMENT_INTENTS !== "true") {
    return res.status(503).json({ error: "Booking cancellation is not enabled" });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith("sk_test_")) {
    return res.status(503).json({ error: "Stripe test mode is not configured" });
  }
  if (!UUID.test(req.params.id || "")) {
    return res.status(400).json({ error: "Invalid booking ID" });
  }

  const bookingId = req.params.id;
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();

    // The operation row is committed BEFORE the external Stripe call. A failed
    // database commit after Stripe cancels can therefore be retried safely.
    await client.query("BEGIN");
    inTransaction = true;
    const first = await client.query(`
      SELECT b.id, b.customer_id, b.status
      FROM public.bookings b
      WHERE b.id = $1 FOR UPDATE
    `, [bookingId]);
    const booking = first.rows[0];
    if (!booking || booking.customer_id !== req.customer.customer_profile_id) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(404).json({ error: "Booking not found" });
    }
    if (!cancellableBookings.has(booking.status) && booking.status !== "cancelled") {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Booking cannot be cancelled in its current state" });
    }
    const paymentCheck = await client.query(`
      SELECT status FROM public.payments WHERE booking_id = $1 FOR UPDATE
    `, [bookingId]);
    if (paymentCheck.rows[0] && ["succeeded", "processing"].includes(paymentCheck.rows[0].status)) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Payment needs separate refund or reconciliation" });
    }
    await client.query(`
      INSERT INTO public.booking_cancellation_operations
        (booking_id, requested_by, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (booking_id) DO NOTHING
    `, [bookingId, req.customer.id]);
    const opFound = await client.query(`
      SELECT id, requested_by, status
      FROM public.booking_cancellation_operations
      WHERE booking_id = $1 FOR UPDATE
    `, [bookingId]);
    const op = opFound.rows[0];
    if (op.requested_by !== req.customer.id) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Cancellation ownership requires review" });
    }
    if (op.status === "completed") {
      await client.query("COMMIT"); inTransaction = false;
      return res.status(200).json({ status: "cancelled", booking_id: bookingId, duplicate: true });
    }
    if (booking.status === "cancelled") {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Cancellation state requires review" });
    }
    await client.query("COMMIT"); inTransaction = false;

    // Lock the same booking row as create-intent. This serializes booking
    // cancellation with concurrent PaymentIntent creation and crew actions.
    await client.query("BEGIN"); inTransaction = true;
    const second = await client.query(`
      SELECT id, customer_id, status FROM public.bookings
      WHERE id = $1 FOR UPDATE
    `, [bookingId]);
    if (!second.rows[0] || second.rows[0].customer_id !== req.customer.customer_profile_id ||
        !cancellableBookings.has(second.rows[0].status)) {
      throw new Error("Booking state changed during cancellation");
    }
    const paymentResult = await client.query(`
      SELECT id, status, amount_cents, currency, stripe_payment_intent_id
      FROM public.payments WHERE booking_id = $1 FOR UPDATE
    `, [bookingId]);
    const payment = paymentResult.rows[0];
    if (payment && ["succeeded", "processing"].includes(payment.status)) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Captured or processing payment needs separate review" });
    }
    const operationResult = await client.query(`
      SELECT id, status, stripe_idempotency_key
      FROM public.booking_cancellation_operations
      WHERE booking_id = $1 FOR UPDATE
    `, [bookingId]);
    const operation = operationResult.rows[0];
    if (!operation) throw new Error("Cancellation operation missing");
    if (operation.status === "completed") {
      await client.query("COMMIT"); inTransaction = false;
      return res.status(200).json({ status: "cancelled", booking_id: bookingId, duplicate: true });
    }

    if (payment && payment.stripe_payment_intent_id) {
      const stripe = new Stripe(key, { timeout: 12000, maxNetworkRetries: 1 });
      let intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
      if (intent.livemode || intent.id !== payment.stripe_payment_intent_id ||
          intent.amount !== Number(payment.amount_cents) ||
          intent.currency !== payment.currency ||
          intent.metadata?.booking_id !== bookingId ||
          intent.metadata?.payment_id !== payment.id) {
        await client.query("ROLLBACK"); inTransaction = false;
        return res.status(409).json({ error: "Stripe payment details require investigation" });
      }
      if (intent.status !== "canceled") {
        if (!cancellableIntents.has(intent.status)) {
          await client.query("ROLLBACK"); inTransaction = false;
          return res.status(409).json({ error: "Stripe payment cannot be cancelled; review required" });
        }
        intent = await stripe.paymentIntents.cancel(intent.id, {}, {
          idempotencyKey: `scrubado-cancel-${operation.stripe_idempotency_key}`
        });
      }
      if (intent.status !== "canceled") throw new Error("Stripe cancellation was not confirmed");
      await client.query(`
        UPDATE public.payments
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1
      `, [payment.id]);
      await client.query(`
        UPDATE public.booking_cancellation_operations
        SET stripe_cancelled_at = COALESCE(stripe_cancelled_at, NOW()), updated_at = NOW()
        WHERE id = $1
      `, [operation.id]);
    }

    const allocation = await client.query(`
      SELECT COUNT(*)::integer AS allocated_count
      FROM public.booking_cleaners
      WHERE booking_id = $1 AND assignment_status = 'assigned' AND payout_cents IS NOT NULL
    `, [bookingId]);
    await client.query(`
      UPDATE public.booking_cleaners
      SET assignment_status = 'removed', updated_at = NOW()
      WHERE booking_id = $1 AND assignment_status = 'assigned'
    `, [bookingId]);
    await client.query(`
      UPDATE public.bookings
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
    `, [bookingId]);
    await client.query(`
      INSERT INTO public.audit_logs
        (actor_user_id, action, entity_type, entity_id, old_values, new_values)
      VALUES ($1, 'booking.cancelled', 'booking', $2,
              jsonb_build_object('status', $3::text),
              jsonb_build_object('status', 'cancelled', 'allocated_cleaner_records_preserved', $4::integer))
    `, [req.customer.id, bookingId, second.rows[0].status, allocation.rows[0].allocated_count]);
    await client.query(`
      UPDATE public.booking_cancellation_operations
      SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error = NULL
      WHERE id = $1
    `, [operation.id]);
    await client.query("COMMIT"); inTransaction = false;
    return res.status(200).json({
      status: "cancelled", booking_id: bookingId,
      stripe_authorization_released: Boolean(payment && payment.stripe_payment_intent_id),
      cleaner_compensation_review_required: allocation.rows[0].allocated_count > 0,
      note: "Sandbox only. Allocation amounts retained for accounting review; no transfers made."
    });
  } catch (error) {
    if (client && inTransaction) {
      try { await client.query("ROLLBACK"); } catch (_) { /* best effort */ }
    }
    console.error("Development booking cancellation failed:", error.type || error.code || error.message);
    return res.status(503).json({ error: "Cancellation incomplete; retry or reconcile before further action" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;