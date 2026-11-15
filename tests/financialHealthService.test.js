"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getFinancialHealth, ISSUE_TYPES } = require("../src/services/financialHealthService");

function fakeDb(row, capture) {
  return { query: async sql => {
    capture.sql = sql;
    return { rows: [row] };
  }};
}
test("healthy local financial health report", async () => {
  const capture = {};
  const report = await getFinancialHealth(fakeDb({
    checked_at: "2026-11-15T00:00:00.000Z", total_issues: 0,
    counts: {}, issues: []
  }, capture));
  assert.equal(report.status, "ok");
  assert.equal(report.total_issues, 0);
  assert.equal(report.stripe_verified, false);
  assert.equal(report.read_only, true);
  assert.equal(report.issues_truncated, false);
  assert.deepEqual(Object.keys(report.counts), [...ISSUE_TYPES]);
  assert.match(capture.sql, /WITH issues AS MATERIALIZED/);
  assert.match(capture.sql, /LIMIT 100/);
  assert.doesNotMatch(capture.sql, /\b(?:UPDATE|DELETE|INSERT)\s+(?:INTO\s+)?public\./i);
});

test("reports issues without losing category counts", async () => {
  const report = await getFinancialHealth(fakeDb({
    checked_at: "2026-11-15T00:00:00.000Z", total_issues: 2,
    counts: { stale_refund: 1, unprocessed_webhook: 1 },
    issues: [{ issue_type: "stale_refund", record_id: "r1" }]
  }, {}));
  assert.equal(report.status, "attention_required");
  assert.equal(report.counts.stale_refund, 1);
  assert.equal(report.counts.unprocessed_webhook, 1);
});

test("marks truncated output with complete counts", async () => {
  const report = await getFinancialHealth(fakeDb({
    checked_at: "2026-11-15T00:00:00.000Z", total_issues: 101,
    counts: { stale_payment: 101 }, issues: []
  }, {}));
  assert.equal(report.issues_truncated, true);
  assert.equal(report.total_issues, 101);
});

test("fails closed on invalid or absent results", async () => {
  await assert.rejects(() => getFinancialHealth({query: async () => ({rows: []})}));
  await assert.rejects(() => getFinancialHealth(fakeDb({total_issues: -1, counts: {}, issues: []}, {})));
});