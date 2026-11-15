"use strict";

// Run: node --test tests/paymentReconciliationChecks.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePaymentReconciliation } = require("../src/services/paymentReconciliationChecks");

function fixture() {
  const p = {
    payment_id: "payment-1", booking_id: "booking-1", customer_id: "customer-1",
    booking_customer_id: "customer-1", payment_status: "succeeded",
    booking_status: "confirmed", payment_amount_cents: "24058",
    quoted_price_cents: "24058", payment_currency: "usd",
    stripe_payment_intent_id: "pi_test_1", refund_status: null,
    stripe_refund_id: null, refund_amount_cents: null
  };
  const intent = {
    id: "pi_test_1", livemode: false, status: "succeeded",
    currency: "usd", amount: 24058, amount_received: 24058,
    capture_method: "automatic_async",
    metadata: { booking_id: "booking-1", payment_id: "payment-1" }
  };
  return { p, intent };
}

function issue(mutator, expectedIssue) {
  const { p, intent } = fixture();
  mutator(p, intent);
  const result = evaluatePaymentReconciliation(p, intent);
  assert.equal(result.status, "review_required");
  assert.equal(result.reconciliation_required, true);
  assert.ok(result.issues.includes(expectedIssue), JSON.stringify(result.issues));
}

test("healthy current captured payment", () => {
  const { p, intent } = fixture();
  const result = evaluatePaymentReconciliation(p, intent);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.issues, []);
  assert.equal(result.expected_booking_status, "confirmed");
});

test("healthy paid and refunded payment keeps Stripe payment succeeded", () => {
  const { p, intent } = fixture();
  Object.assign(p, { booking_status: "cancelled", refund_status: "succeeded",
    stripe_refund_id: "re_test_1", refund_amount_cents: "24058" });
  const result = evaluatePaymentReconciliation(p, intent);
  assert.equal(result.status, "ok");
  assert.equal(result.expected_booking_status, "cancelled");
});

test("healthy uncaptured, cancelled legacy manual-capture payment", () => {
  const { p, intent } = fixture();
  Object.assign(p, { payment_status: "cancelled", booking_status: "cancelled" });
  Object.assign(intent, { status: "canceled", amount_received: 0, capture_method: "manual" });
  const result = evaluatePaymentReconciliation(p, intent);
  assert.equal(result.status, "ok");
  assert.equal(result.legacy_capture_method, true);
});

test("detect different amounts", () => issue((p, intent) => { intent.amount = 24059; }, "identity_amount"));
test("detect incorrect booking metadata", () => issue((p, intent) => { intent.metadata.booking_id = "wrong"; }, "identity_booking_metadata"));
test("detect incorrect payment metadata", () => issue((p, intent) => { intent.metadata.payment_id = "wrong"; }, "identity_payment_metadata"));
test("detect stale local payment status", () => issue((p) => { p.payment_status = "processing"; }, "payment_status_mismatch"));
test("detect active booking after successful payment refund", () => issue((p) => {
  p.refund_status = "succeeded";
  p.stripe_refund_id = "re_test_1";
  p.refund_amount_cents = "24058";
}, "booking_status_mismatch"));
test("detect active booking after canceled intent", () => issue((p, intent) => {
  p.payment_status = "cancelled";
  intent.status = "canceled";
  intent.amount_received = 0;
}, "booking_status_mismatch"));
test("detect unexpected manual capture on an active payment", () => issue((p, intent) => {
  intent.capture_method = "manual";
}, "identity_capture_method"));
test("detect captured amount mismatch", () => issue((p, intent) => {
  intent.amount_received = 100;
}, "identity_captured_amount"));
test("detect uncaptured status reporting received funds", () => issue((p, intent) => {
  p.payment_status = "cancelled";
  p.booking_status = "cancelled";
  intent.status = "canceled";
  intent.amount_received = 100;
}, "identity_captured_amount"));
test("detect inconsistent local refund", () => issue((p) => {
  p.booking_status = "cancelled";
  p.refund_status = "succeeded";
  p.stripe_refund_id = null;
  p.refund_amount_cents = "24058";
}, "local_refund_record_inconsistent"));
test("detect live-mode intent", () => issue((p, intent) => { intent.livemode = true; }, "identity_test_mode"));