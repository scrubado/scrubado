"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { quote } = require("../src/services/pricingService");
const base = { state: "MA", postal_code: "02766", drive_miles: 0, addons: [] };
const cases = [
  [{ sqft: 1500, full_baths: 2, half_baths: 1, service: "standard", frequency: "biweekly" }, 24058, 18284],
  [{ sqft: 1200, full_baths: 1, half_baths: 0, service: "standard", frequency: "once" }, 18600, 14136],
  [{ sqft: 600, full_baths: 1, half_baths: 0, service: "standard", frequency: "once" }, 15900, 12084],
  [{ sqft: 2000, full_baths: 1, half_baths: 0, service: "deep", frequency: "once" }, 46920, 35659],
  [{ sqft: 1600, full_baths: 1, half_baths: 0, service: "move", frequency: "once" }, 44080, 33501],
];
for (const [scenario, customer, cleaner] of cases) {
  test(`quote ${scenario.service} ${scenario.sqft} sq ft`, () => {
    const result = quote({ ...base, ...scenario });
    assert.equal(result.amounts_cents.customer_total, customer);
    assert.equal(result.amounts_cents.cleaner_total, cleaner);
  });
}
test("one full bathroom included", () => {
  const r = quote({ ...base, sqft: 1000, full_baths: 1, half_baths: 0, service: "standard", frequency: "once" });
  assert.equal(r.amounts_cents.bathrooms, 0);
});
test("additional bathrooms charged", () => {
  const r = quote({ ...base, sqft: 1000, full_baths: 3, half_baths: 2, service: "standard", frequency: "once" });
  assert.equal(r.amounts_cents.bathrooms, 8800);
});
test("only standard receives weekly discount", () => {
  const common = { ...base, sqft: 1200, full_baths: 1, half_baths: 0 };
  const once = quote({ ...common, service: "deep", frequency: "once" });
  const weekly = quote({ ...common, service: "deep", frequency: "weekly" });
  assert.equal(once.amounts_cents.customer_total, weekly.amounts_cents.customer_total);
});
test("included addons are free for deep", () => {
  const r = quote({ ...base, sqft: 1200, full_baths: 1, half_baths: 0, service: "deep", frequency: "once", addons: [{ code: "oven" }] });
  assert.equal(r.amounts_cents.addons, 0);
});
const sample = { sqft: 1200, full_baths: 1, half_baths: 0, service: "standard", frequency: "once" };
for (const zip of ["02067", "02072", "02356", "02375", "02766"]) {
  test(`accept initial MA service ZIP ${zip}`, () => {
    assert.equal(quote({ ...base, ...sample, postal_code: zip }).status, "estimate");
  });
}
for (const [state, zip] of [["RI", "02860"], ["MA", "02860"], ["MA", "02108"], ["MA", "02334"], ["MA", "abcde"], ["NY", "02766"]]) {
  test(`reject unsupported service area ${state} ${zip}`, () => {
    assert.throws(() => quote({ ...base, ...sample, state, postal_code: zip }), /outside Scrubado/);
  });
}
test("manual review beyond 4000 sq ft", () => assert.equal(quote({ ...base, sqft: 4500, full_baths: 1, half_baths: 0, service: "standard", frequency: "once" }).status, "manual_review_required"));
