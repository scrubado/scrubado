"use strict";

// Save as src/routes/adminRefundRecovery.js
// DEV/STRIPE TEST MODE ONLY. READ-ONLY financial reconciliation diagnostic.
// This route NEVER creates a refund, updates Neon, or changes a booking.

const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");
const { authenticateAdmin } = require("../middleware/authenticateAdmin");

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/refunds/:id/recovery-status", authenticateAdmin, async (req, res) => {
  if (process.env.NODE_ENV === "production" ||
      process.env.ENABLE_DEV_PAYMENT_INTENTS !== "true") {
    return res.status(503).json({ error: "Test refund diagnostics are disabled" });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith("sk_test_")) {
    return res.status(503).json({ error: "Stripe sandbox is not configured" });
  }
  if (!UUID.test(req.params.id || "")) {
    return res.status(400).json({ error: "Invalid refund operation ID" });
  }

  try {
    // Check current admin authority again, as with existing financial admin routes.
    const actor = await pool.query(`
      SELECT id FROM public.users
      WHERE id = $1 AND role = 'admin' AND status = 'active'
    `, [req.admin.id]);
    if (actor.rowCount !== 1) {
      return res.status(403).json({ error: "Administrator access required" });
    }

    const result = await pool.query(`
      SELECT r.id AS refund_id, r.status AS refund_status,
             r.amount_cents AS refund_amount_cents, r.currency AS refund_currency,
             r.stripe_refund_id, r.completed_at,
             p.id AS payment_id, p.booking_id, p.status AS payment_status,
             p.amount_cents AS payment_amount_cents,
             p.stripe_payment_intent_id,
             b.status AS booking_status
      FROM public.payment_refunds r
      JOIN public.payments p ON p.id = r.payment_id
      JOIN public.bookings b ON b.id = p.booking_id
      WHERE r.id = $1
    `, [req.params.id]);
    if (result.rowCount !== 1) {
      return res.status(404).json({ error: "Refund operation not found" });
    }
    const r = result.rows[0];
    if (!r.stripe_payment_intent_id) {
      return res.status(409).json({ error: "PaymentIntent missing; manual review required" });
    }

    const stripe = new Stripe(key, { timeout: 12000, maxNetworkRetries: 1 });
    const intent = await stripe.paymentIntents.retrieve(r.stripe_payment_intent_id);
    if (intent.livemode || intent.id !== r.stripe_payment_intent_id) {
      return res.status(409).json({ error: "Stripe payment identity mismatch" });
    }

    // When the request was interrupted before storing stripe_refund_id, search
    // Stripe by the PaymentIntent and our durable refund operation metadata.
    let refund;
    if (r.stripe_refund_id) {
      refund = await stripe.refunds.retrieve(r.stripe_refund_id);
    } else {
      const candidates = await stripe.refunds.list({
        payment_intent: intent.id,
        limit: 100
      });
      const matches = candidates.data.filter(x =>
        x.metadata?.refund_operation_id === r.refund_id
      );
      // Never assume absence is final if Stripe has additional pages.
      if (candidates.has_more || matches.length > 1) {
        return res.status(409).json({
          error: "Refund listing needs manual reconciliation",
          has_more: Boolean(candidates.has_more),
          matching_refunds: matches.length
        });
      }
      refund = matches[0] || null;
    }

    const intentValid = intent.currency === "usd" &&
      intent.amount === Number(r.payment_amount_cents) &&
      intent.amount_received === Number(r.payment_amount_cents) &&
      intent.metadata?.booking_id === r.booking_id &&
      intent.metadata?.payment_id === r.payment_id;

    const refundValid = refund ? (
      !refund.livemode &&
      refund.payment_intent === intent.id &&
      refund.amount === Number(r.refund_amount_cents) &&
      refund.currency === r.refund_currency &&
      refund.metadata?.booking_id === r.booking_id &&
      refund.metadata?.payment_id === r.payment_id &&
      refund.metadata?.refund_operation_id === r.refund_id &&
      (!r.stripe_refund_id || r.stripe_refund_id === refund.id)
    ) : null;

    const matches = intentValid && refundValid === true &&
      r.payment_status === "succeeded" &&
      Number(r.refund_amount_cents) === Number(r.payment_amount_cents);

    return res.status(200).json({
      refund_operation_id: r.refund_id,
      booking_id: r.booking_id,
      local: {
        booking_status: r.booking_status,
        payment_status: r.payment_status,
        refund_status: r.refund_status,
        refund_amount_cents: Number(r.refund_amount_cents),
        stripe_refund_id: r.stripe_refund_id,
        completed_at: r.completed_at
      },
      stripe: {
        payment_intent_status: intent.status,
        refund_found: Boolean(refund),
        refund_id: refund?.id || null,
        refund_status: refund?.status || null
      },
      identities_match: matches,
      reconciliation_required: !matches || (
        refund?.status === "succeeded" &&
        (r.refund_status !== "succeeded" || r.booking_status !== "cancelled")
      ),
      read_only: true,
      note: "No Stripe or database changes were made. A separate audited reconciliation operation is required."
    });
  } catch (error) {
    console.error("Refund recovery diagnosis failed:", error.type || error.code || error.message);
    return res.status(503).json({ error: "Refund diagnosis unavailable; do not retry the refund blindly" });
  }
});

module.exports = router;