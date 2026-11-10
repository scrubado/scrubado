"use strict";
// Self-contained route tests; no database credentials or packages needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const quoteId = "834048a7-8bb5-449b-ba39-676fbcbda2ba";
const userId = "39b2ef83-4837-4159-8aa3-87a3f91c1140";
const profileId = "6f90c01c-6fa5-4286-b2c0-ad23d145a945";
const serviceId = "a0000000-0000-4000-8000-000000000000";
const validBody = {
  quote_id: quoteId, scheduled_date: "2099-06-15", start_time: "10:00",
  address_line1: "123 Test Street", city: "Pawtucket", state: "RI", postal_code: "02861"
};

function setup({ owner = userId, status = "active", expired = false } = {}) {
  const calls = [];
  const saved = { id: quoteId, customer_id: owner, service_id: serviceId,
    status, expires_at: expired ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
    postal_code: "02861", state: "RI", customer_total_cents: "24058",
    square_feet: 1500, full_baths: 2, half_baths: 1, service_code: "standard", addon_selections: [] };
  let used = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM public.quotes")) {
        return { rowCount: 1, rows: [{ ...saved, status: used ? "used" : saved.status }] };
      }
      if (sql.includes("AS future")) return { rows: [{ future: true }] };
      if (sql.includes("FROM public.customer_profiles")) return { rowCount: 1, rows: [{ id: profileId }] };
      if (sql.includes("INSERT INTO public.bookings")) return { rowCount: 1, rows: [{
        id: "b0000000-0000-4000-8000-000000000000", quote_id: quoteId,
        quoted_price_cents: "24058", status: "requested"
      }] };
      if (sql.includes("UPDATE public.quotes")) { used = true; return { rowCount: 1, rows: [{ id: quoteId }] }; }
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); }
  };
  let callback;
  const router = { post(_path, _auth, cb) { callback = cb; } };
  const source = fs.readFileSync(path.join(__dirname, "../src/routes/bookings.js"), "utf8");
  const mod = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports, process, console) {\n${source}\n})`, { Date })(
    (name) => {
      if (name === "express") return { Router: () => router };
      if (name === "../db") return { connect: async () => client };
      if (name === "../middleware/authenticate") return { authenticateCustomer() {} };
      if (name === "../services/durationService") return require(path.join(__dirname, "../src/services/durationService"));
      throw new Error(`Unexpected dependency: ${name}`);
    }, mod, mod.exports, { env: { ENABLE_DEV_BOOKINGS: "true", NODE_ENV: "development" } }, console
  );
  async function run(body = validBody) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; } };
    await callback({ body, customer: { id: userId, customer_profile_id: profileId } }, res);
    return res;
  }
  return { run, calls };
}

test("creates booking from owned quote and consumes quote in one transaction", async () => {
  const { run, calls } = setup();
  const result = await run();
  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.booking.quoted_price_cents, "24058");
  assert.equal(calls[0].sql, "BEGIN");
  const insertion = calls.find(c => c.sql.includes("INSERT INTO public.bookings"));
  assert.match(insertion.sql, /required_crew_size/);
  assert.equal(insertion.params[6], "14:00"); // 1500 sqft + bath adjustments = 240 minutes
  assert.equal(insertion.params[7], 1);
  assert.ok(calls.some(c => c.sql.includes("FOR UPDATE")));
  assert.ok(calls.some(c => c.sql.includes("INSERT INTO public.bookings")));
  assert.ok(calls.some(c => c.sql.includes("UPDATE public.quotes")));
  assert.ok(calls.some(c => c.sql === "COMMIT"));
});

test("rejects anonymous or foreign quote with rollback", async () => {
  for (const owner of [null, "d0000000-0000-4000-8000-000000000000"]) {
    const { run, calls } = setup({ owner });
    const result = await run();
    assert.equal(result.statusCode, 404);
    assert.ok(calls.some(c => c.sql === "ROLLBACK"));
    assert.ok(!calls.some(c => c.sql.includes("INSERT INTO public.bookings")));
  }
});

test("rejects used and expired quotes", async () => {
  for (const opts of [{ status: "used" }, { expired: true }]) {
    const { run, calls } = setup(opts);
    const result = await run();
    assert.equal(result.statusCode, 409);
    assert.ok(!calls.some(c => c.sql.includes("INSERT INTO public.bookings")));
  }
});

test("rejects invalid address before touching database", async () => {
  const { run, calls } = setup();
  const result = await run({ ...validBody, postal_code: "02807" });
  assert.equal(result.statusCode, 400);
  assert.equal(calls.length, 0);
});
