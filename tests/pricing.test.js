"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { quote } = require("../src/services/pricingService");
const base = { state: "RI", postal_code: "02860", drive_miles: 0, addons: [] };
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
test("reject excluded ZIP", () => assert.throws(() => quote({ ...base, postal_code: "02807", sqft: 1200, full_baths: 1, half_baths: 0, service: "standard", frequency: "once" }), /excluded/));
test("manual review beyond 4000 sq ft", () => assert.equal(quote({ ...base, sqft: 4500, full_baths: 1, half_baths: 0, service: "standard", frequency: "once" }).status, "manual_review_required"));
