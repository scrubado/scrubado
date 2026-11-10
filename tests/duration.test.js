"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateJob, crewSizeForJob, scheduledEnd, DurationError } = require("../src/services/durationService");
const params = { square_feet: 1500, service_code: "standard", full_baths: 2, half_baths: 1, addon_selections: [] };
test("standard 1500 sqft defaults to solo; 240-minute slot including bathrooms", () => {
  assert.deepEqual(estimateJob(params), { required_crew_size: 1, estimated_minutes: 240, solo_labor_minutes: 220, estimation_version: "crew-duration-v1" });
  assert.equal(scheduledEnd("10:00", 240), "14:00");
});
test("automatic crew threshold rules", () => {
  assert.equal(crewSizeForJob("standard", 2000), 1);
  assert.equal(crewSizeForJob("standard", 2001), 2);
  assert.equal(crewSizeForJob("deep", 1200), 1);
  assert.equal(crewSizeForJob("deep", 1201), 2);
  assert.equal(crewSizeForJob("move", 600), 2);
});
test("two-cleaner duration includes coordination factor", () => {
  const result = estimateJob({ square_feet: 2200, full_baths: 1, service_code: "standard" });
  assert.equal(result.required_crew_size, 2);
  assert.equal(result.estimated_minutes, 150);
});
test("included add-ons do not double-count deep-cleaning time", () => {
  const x = estimateJob({ square_feet: 1000, service_code: "deep", full_baths: 1, addon_selections: [{ code: "oven" }] });
  const y = estimateJob({ square_feet: 1000, service_code: "deep", full_baths: 1, addon_selections: [] });
  assert.equal(x.estimated_minutes, y.estimated_minutes);
});
test("paid add-ons and quantities increase required duration", () => {
  const x = estimateJob({ square_feet: 800, service_code: "standard", full_baths: 1, addon_selections: [{ code: "laundry_load", quantity: 2 }] });
  assert.equal(x.estimated_minutes, 210);
});
test("rejects invalid job metadata and duplicate add-ons", () => {
  assert.throws(() => estimateJob({ ...params, square_feet: 4001 }), DurationError);
  assert.throws(() => estimateJob({ ...params, addon_selections: [{ code: "oven" }, { code: "oven" }] }), DurationError);
  assert.throws(() => estimateJob({ ...params, full_baths: 0 }), DurationError);
});
test("rejects end of day overflow", () => {
  assert.throws(() => scheduledEnd("22:00", 180), DurationError);
  assert.throws(() => scheduledEnd("10:00", 0), DurationError);
});
