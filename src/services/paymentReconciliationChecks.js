"use strict";

// Pure Stripe <-> Neon diagnostic rules. No DB access, Stripe calls, or writes.
const stripeStates = new Set([
  "requires_payment_method", "requires_confirmation", "requires_action",
  "processing", "requires_capture", "canceled", "succeeded"
]);

function evaluatePaymentReconciliation(p, intent) {
  const expectedDbStatus = intent.status === "canceled" ? "cancelled" : intent.status;
  const cents = Number(p.payment_amount_cents);
  const hasSuccessfulRefund = p.refund_status === "succeeded";
  const legacyCancelled = intent.capture_method === "manual" &&
    intent.status === "canceled" && p.payment_status === "cancelled" &&
    p.booking_status === "cancelled" && intent.amount_received === 0 &&
    p.refund_status == null;

  const identityChecks = {
    test_mode: intent.livemode === false,
    payment_intent_id: intent.id === p.stripe_payment_intent_id,
    recognized_stripe_status: stripeStates.has(intent.status),
    currency: intent.currency === "usd" && p.payment_currency === "usd",
    amount: Number.isSafeInteger(cents) && cents > 0 && intent.amount === cents,
    booking_quote_amount: String(p.quoted_price_cents) === String(p.payment_amount_cents),
    customer: p.customer_id === p.booking_customer_id,
    booking_metadata: intent.metadata?.booking_id === p.booking_id,
    payment_metadata: intent.metadata?.payment_id === p.payment_id,
    capture_method: intent.capture_method === "automatic_async" || legacyCancelled,
    captured_amount: intent.status === "succeeded"
      ? intent.amount_received === cents
      : intent.status === "canceled"
        ? intent.amount_received === 0
        : true
  };
  const identitiesMatch = Object.values(identityChecks).every(Boolean);

  // Stripe retains 'succeeded' on the PaymentIntent after a separate refund.
  // A cancelled PaymentIntent should never leave its booking active.
  const expectedBookingStatus = intent.status === "succeeded"
    ? (hasSuccessfulRefund ? "cancelled" : "confirmed")
    : intent.status === "canceled" ? "cancelled" : null;
  const paymentStatusMatch = p.payment_status === expectedDbStatus;
  const bookingStatusMatch = expectedBookingStatus === null ||
    p.booking_status === expectedBookingStatus;
  const refundConsistency = !hasSuccessfulRefund || (
    p.stripe_refund_id != null &&
    Number(p.refund_amount_cents) === cents
  );

  const issues = [];
  for (const [name, passes] of Object.entries(identityChecks)) {
    if (!passes) issues.push(`identity_${name}`);
  }
  if (!paymentStatusMatch) issues.push("payment_status_mismatch");
  if (!bookingStatusMatch) issues.push("booking_status_mismatch");
  if (!refundConsistency) issues.push("local_refund_record_inconsistent");

  return {
    status: issues.length ? "review_required" : "ok",
    identity_checks: identityChecks,
    identities_match: identitiesMatch,
    legacy_capture_method: intent.capture_method === "manual",
    expected_local_payment_status: expectedDbStatus,
    expected_booking_status: expectedBookingStatus,
    payment_status_match: paymentStatusMatch,
    booking_status_match: bookingStatusMatch,
    reconciliation_required: issues.length > 0,
    issues
  };
}

module.exports = { evaluatePaymentReconciliation };