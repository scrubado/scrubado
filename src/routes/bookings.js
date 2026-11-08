"use strict";

const express = require("express");
const pool = require("../db");
const { authenticateCustomer } = require("../middleware/authenticate");

const router = express.Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zipPattern = /^\d{5}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isDate(value) {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const actual = new Date(Date.UTC(year, month - 1, day));
  return actual.getUTCFullYear() === year && actual.getUTCMonth() === month - 1 && actual.getUTCDate() === day;
}
function textField(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}
function optionalText(value, max) {
  return value == null || (typeof value === "string" && value.trim().length <= max);
}

// Until address verification, cleaner scheduling and checkout are implemented,
// this route is intentionally available only in explicit LOCAL development mode.
router.post("/", authenticateCustomer, async (req, res) => {
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_BOOKINGS !== "true") {
    return res.status(503).json({ error: "Booking creation is not enabled yet" });
  }

  const body = req.body || {};
  const { quote_id, scheduled_date, start_time, address_line1, address_line2,
    city, state, postal_code, customer_notes } = body;

  if (!uuidPattern.test(quote_id || "") || !isDate(scheduled_date) ||
      !timePattern.test(start_time || "") || !textField(address_line1, 200) ||
      !optionalText(address_line2, 200) || !textField(city, 100) ||
      state !== "RI" || typeof postal_code !== "string" ||
      !zipPattern.test(postal_code) || postal_code === "02807" ||
      !optionalText(customer_notes, 2000)) {
    return res.status(400).json({ error: "Invalid booking details" });
  }

  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    // Serialize concurrent booking attempts for the same quote.
    const found = await client.query(`
      SELECT id, customer_id, service_id, status, expires_at,
             postal_code, state, customer_total_cents
      FROM public.quotes
      WHERE id = $1
      FOR UPDATE
    `, [quote_id]);
    const savedQuote = found.rows[0];
    if (!savedQuote || savedQuote.customer_id !== req.customer.id) {
      await client.query("ROLLBACK"); transactionStarted = false;
      return res.status(404).json({ error: "Quote not found" });
    }
    if (savedQuote.status !== "active" ||
        new Date(savedQuote.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK"); transactionStarted = false;
      return res.status(409).json({ error: "Quote is expired or already used. Request a new quote." });
    }
    if (savedQuote.postal_code !== postal_code || savedQuote.state.trim() !== state) {
      await client.query("ROLLBACK"); transactionStarted = false;
      return res.status(422).json({ error: "Booking address must match the quoted service area" });
    }

    // PostgreSQL interprets scheduled local wall-clock values in Rhode Island time.
    const timeCheck = await client.query(`
      SELECT (($1::date + $2::time) AT TIME ZONE 'America/New_York') > NOW() AS future
    `, [scheduled_date, start_time]);
    if (!timeCheck.rows[0].future) {
      await client.query("ROLLBACK"); transactionStarted = false;
      return res.status(422).json({ error: "Scheduled start must be in the future" });
    }

    // Resolve the profile from the trusted authenticated identity.
    const customerProfile = await client.query(`
      SELECT id FROM public.customer_profiles
      WHERE user_id = $1
    `, [req.customer.id]);
    if (customerProfile.rowCount !== 1 ||
        customerProfile.rows[0].id !== req.customer.customer_profile_id) {
      throw new Error("Authenticated customer profile missing or inconsistent");
    }

    const created = await client.query(`
      INSERT INTO public.bookings (
        customer_id, service_id, quote_id, quoted_price_cents,
        scheduled_date, start_time, address_line1, address_line2,
        city, state, postal_code, customer_notes, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'RI', $10, $11, 'requested'
      )
      RETURNING id, quote_id, status, scheduled_date, start_time,
                quoted_price_cents, created_at
    `, [customerProfile.rows[0].id, savedQuote.service_id, savedQuote.id,
        savedQuote.customer_total_cents, scheduled_date, start_time,
        address_line1.trim(), address_line2?.trim() || null, city.trim(),
        postal_code, customer_notes?.trim() || null]);

    const consumed = await client.query(`
      UPDATE public.quotes SET status = 'used', used_at = NOW()
      WHERE id = $1 AND status = 'active' AND expires_at > NOW()
      RETURNING id
    `, [savedQuote.id]);
    if (consumed.rowCount !== 1) {
      await client.query("ROLLBACK"); transactionStarted = false;
      return res.status(409).json({ error: "Quote expired during booking. Request a new quote." });
    }
    await client.query("COMMIT"); transactionStarted = false;
    return res.status(201).json({
      status: "created",
      booking: created.rows[0],
      disclaimer: "Development-only booking request. Address, cleaner availability, and payment have not been verified."
    });
  } catch (error) {
    if (client && transactionStarted) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) {
        console.error("Booking rollback failed:", rollbackError);
      }
    }
    if (error.code === "23505") {
      return res.status(409).json({ error: "Quote already has a booking" });
    }
    console.error("Booking creation failed:", error);
    return res.status(500).json({ error: "Unable to create booking" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
