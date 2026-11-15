"use strict";

// Scrubado — development-only, admin-only payment reconciliation diagnostic.
// GET /api/admin/payments/:id/recovery-status
// :id is the local public.payments UUID, NOT the Stripe PaymentIntent ID.
// READ ONLY: never creates, captures, cancels, refunds, or mutates payments.

const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");
const { authenticateAdmin } = require("../middleware/authenticateAdmin");
const { evaluatePaymentReconciliation } = require("../services/paymentReconciliationChecks");

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/payments/:id/recovery-status", authenticateAdmin, async (req, res) => {
  if (process.env.NODE_ENV === "production" ||
      process.env.ENABLE_DEV_PAYMENT_INTENTS !== "true") {
    return res.status(503).json({ error: "Test payment diagnostics are disabled" });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith("sk_test_")) {
    return res.status(503).json({ error: "Stripe sandbox is not configured" });
  }
  if (!UUID.test(req.params.id || "")) {
    return res.status(400).json({ error: "Invalid local payment ID" });
  }

  try {
    // Recheck current DB authority, not just the JWT's historical role.
    const actor = await pool.query(`
      SELECT id FROM public.users
      WHERE id = $1 AND role = 'admin' AND status = 'active'
    `, [req.admin.id]);
    if (actor.rowCount !== 1) {
      return res.status(403).json({ error: "Administrator access required" });
    }

    const result = await pool.query(`
      SELECT p.id AS payment_id, p.booking_id, p.customer_id,
             p.status AS payment_status, p.amount_cents AS payment_amount_cents,
             p.currency AS payment_currency, p.stripe_payment_intent_id,
             p.paid_at, p.updated_at AS payment_updated_at,
             b.status AS booking_status, b.customer_id AS booking_customer_id,
             b.quoted_price_cents,
             r.id AS refund_operation_id, r.status AS refund_status,
             r.stripe_refund_id, r.amount_cents AS refund_amount_cents
      FROM public.payments p
      JOIN public.bookings b ON b.id = p.booking_id
      LEFT JOIN public.payment_refunds r ON r.payment_id = p.id
      WHERE p.id = $1
    `, [req.params.id]);
    if (result.rowCount !== 1) {
      return res.status(404).json({ error: "Payment not found or has inconsistent records" });
    }
    const p = result.rows[0];
    if (!p.stripe_payment_intent_id) {
      return res.status(409).json({
        error: "Missing Stripe PaymentIntent; manual review required",
        payment_id: p.payment_id,
        read_only: true
      });
    }

    const stripe = new Stripe(key, { timeout: 12000, maxNetworkRetries: 1 });
    const intent = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);
    // Compare current Stripe state using the separately testable pure rules.
    const assessment = evaluatePaymentReconciliation(p, intent);
    const cents = Number(p.payment_amount_cents);

    return res.status(200).json({
      status: assessment.status,
      checked_at: new Date().toISOString(),
      payment_id: p.payment_id,
      booking_id: p.booking_id,
      local: {
        payment_status: p.payment_status,
        booking_status: p.booking_status,
        amount_cents: cents,
        currency: p.payment_currency,
        stripe_payment_intent_id: p.stripe_payment_intent_id,
        refund_operation_id: p.refund_operation_id,
        refund_status: p.refund_status
      },
      stripe: {
        payment_intent_id: intent.id,
        status: intent.status,
        amount_cents: intent.amount,
        amount_received_cents: intent.amount_received,
        currency: intent.currency,
        capture_method: intent.capture_method,
        livemode: intent.livemode
      },
      ...assessment,
      read_only: true
    });
  } catch (error) {
    console.error("Admin payment diagnostic failed:", error.type || error.code || error.message);
    return res.status(503).json({ error: "Payment diagnostic unavailable; investigate before retrying" });
  }
});

module.exports = router;