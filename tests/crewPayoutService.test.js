"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateCrewShares, CrewPayoutError } = require("../src/services/crewPayoutService");

test("solo crew receives full cleaner compensation", () => {
  assert.deepEqual(calculateCrewShares("18284", 1), { lead: "18284", second: null });
});

test("two-cleaner crew receives 60/40 of cleaner compensation", () => {
  assert.deepEqual(calculateCrewShares("18284", 2), { lead: "10970", second: "7314" });
});

test("odd cents produce an exact, no-loss split", () => {
  const result = calculateCrewShares("101", 2);
  assert.deepEqual(result, { lead: "61", second: "40" });
  assert.equal(BigInt(result.lead) + BigInt(result.second), 101n);
});

test("missing and invalid monetary values are rejected", () => {
  for (const value of [null, undefined, -1, "4.50", "abc", "0"]) {
    assert.throws(() => calculateCrewShares(value, 2), CrewPayoutError);
  }
  assert.throws(() => calculateCrewShares("100", 3), CrewPayoutError);
});
