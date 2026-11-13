"use strict";

// Install as src/routes/stripeWebhook.js.
// IMPORTANT: Mount BEFORE app.use(express.json()) in src/app.js.
// Stripe webhook signatures must be checked against the original raw body.

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
  "payment_intent.canceled"
]);
const states = new Set([
  "requires_payment_method", "requires_action", "processing",
  "requires_capture", "succeeded", "canceled"
]);

router.post("/", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  // Local/test only until production payment policies are complete.
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
  const eventIntent = event.data && event.data.object;
  if (!eventIntent || eventIntent.object !== "payment_intent" ||
      typeof eventIntent.id !== "string") {
    return res.status(400).json({ error: "Unexpected Stripe event object" });
  }

  // Re-fetch CURRENT intent state so delayed/out-of-order events cannot
  // downgrade the payment record. Do not trust the client to report success.
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

    // Claim the event atomically; a repeated delivery is acknowledged only
    // after the first delivery's database transaction has committed.
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

    const result = await client.query(`
      SELECT id, booking_id, customer_id, amount_cents, currency
      FROM public.payments
      WHERE stripe_payment_intent_id = $1
      FOR UPDATE
    `, [intent.id]);
    const payment = result.rows[0];

    // Stripe CLI test fixtures may create PaymentIntents unrelated to Scrubado.
    // Acknowledge valid, unrelated events without changing any payment record.
    if (!payment) {
      await client.query(`
        UPDATE public.stripe_webhook_events
        SET processed_at = NOW()
        WHERE id = $1
      `, [claimed.rows[0].id]);

      await client.query("COMMIT");
      return res.status(200).json({ received: true, ignored: true });
    }

    // A known payment must match the Stripe amount and identifying metadata.
    // Roll back the event claim on mismatch so it can be investigated/retried.
    if (Number(payment.amount_cents) !== intent.amount ||
        payment.currency !== intent.currency ||
        intent.metadata?.booking_id !== payment.booking_id ||
        intent.metadata?.payment_id !== payment.id) {
      throw new Error("Webhook payment record or amount mismatch");
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
    await client.query(`
      UPDATE public.stripe_webhook_events
      SET processed_at = NOW()
      WHERE id = $1
    `, [claimed.rows[0].id]);

    await client.query("COMMIT");
    return res.status(200).json({ received: true });
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