"use strict";

const express = require("express");
const pool = require("../db");
const { authenticateCleaner } = require("../middleware/authenticateCleaner");

const router = express.Router();
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function localDate() {
  // Scrubado's current launch market is Southern Massachusetts (Eastern Time).
  // UTC dates can roll over early compared with the local appointment day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function dateOffset(dateString, days) {
  const date = new Date(dateString + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// A cleaner may view or maintain their own calendar without being verified;
// verification and accepts_new_jobs are enforced separately when accepting work.
router.get("/availability", authenticateCleaner, async (req, res) => {
  try {
    const today = localDate();
    const endDate = dateOffset(today, 90);
    const result = await pool.query(`
      SELECT TO_CHAR(available_date, 'YYYY-MM-DD') AS date,
             TO_CHAR(start_time, 'HH24:MI') AS start_time,
             TO_CHAR(end_time, 'HH24:MI') AS end_time,
             is_available
      FROM cleaner_availability
      WHERE cleaner_id = $1
        AND available_date >= $2::date
        AND available_date <= $3::date
      ORDER BY available_date, start_time, id
    `, [req.cleaner.cleaner_profile_id, today, endDate]);
    return res.status(200).json({ status: "ok", availability: result.rows });
  } catch (error) {
    console.error("Cleaner availability lookup failed:", { code: error.code, message: error.message });
    return res.status(503).json({ error: "Unable to retrieve availability" });
  }
});

// Replace this cleaner's windows for ONE date, atomically.
// {"date":"2026-11-20","windows":[{"start_time":"09:00","end_time":"13:00"}]}
// An empty windows array clears that day. No schema migration required.
router.put("/availability", authenticateCleaner, async (req, res) => {
  const { date, windows } = req.body || {};
  const today = localDate();
  const lastDate = dateOffset(today, 90);
  if (!validDate(date) || date < today || date > lastDate) {
    return res.status(400).json({ error: "Date must be a valid YYYY-MM-DD within the next 90 days" });
  }
  if (!Array.isArray(windows) || windows.length > 4) {
    return res.status(400).json({ error: "Provide windows as an array of up to four time ranges" });
  }

  const normalized = [];
  for (const window of windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) ||
        !TIME_PATTERN.test(window.start_time) || !TIME_PATTERN.test(window.end_time) ||
        window.start_time >= window.end_time) {
      return res.status(400).json({ error: "Each window needs start_time and end_time in HH:MM format, start before end" });
    }
    normalized.push({ start_time: window.start_time, end_time: window.end_time });
  }
  normalized.sort((a, b) => a.start_time.localeCompare(b.start_time));
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].start_time < normalized[i - 1].end_time) {
      return res.status(400).json({ error: "Availability windows cannot overlap" });
    }
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    // Serialize updates for the same cleaner, even when no rows yet exist for a date.
    const profile = await client.query(`
      SELECT cp.id FROM cleaner_profiles cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.id = $1 AND cp.user_id = $2
        AND u.role = 'cleaner' AND u.status = 'active'
      FOR UPDATE OF cp
    `, [req.cleaner.cleaner_profile_id, req.cleaner.id]);
    if (profile.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Active cleaner account required" });
    }

    // Keep accepted/confirmed/in-progress assignments covered by one of the
    // proposed windows. The cleaner-profile row lock coordinates with the
    // existing job-acceptance transaction, preventing acceptance/edit races.
    // Also include legacy solo assignments stored only in bookings.cleaner_id.
    const assigned = await client.query(`
      SELECT DISTINCT b.id, b.start_time, b.end_time
      FROM bookings b
      LEFT JOIN booking_cleaners bc
        ON bc.booking_id = b.id
       AND bc.cleaner_id = $1
       AND bc.assignment_status = 'assigned'
      WHERE b.scheduled_date = $2::date
        AND b.status IN ('accepted', 'confirmed', 'in_progress')
        AND (bc.id IS NOT NULL OR b.cleaner_id = $1)
    `, [req.cleaner.cleaner_profile_id, date]);

    for (const booking of assigned.rows) {
      // Fail closed for unknown/invalid durations: a cleaner must not erase
      // availability while an existing assignment cannot be evaluated.
      const start = typeof booking.start_time === "string" ? booking.start_time.slice(0, 5) : null;
      const end = typeof booking.end_time === "string" ? booking.end_time.slice(0, 5) : null;
      const covered = start && end && start < end && normalized.some(
        (window) => window.start_time <= start && window.end_time >= end
      );
      if (!covered) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Availability must continue to cover existing accepted assignments",
          booking_id: booking.id
        });
      }
    }

    await client.query(`
      DELETE FROM cleaner_availability
      WHERE cleaner_id = $1 AND available_date = $2::date
    `, [req.cleaner.cleaner_profile_id, date]);

    for (const window of normalized) {
      await client.query(`
        INSERT INTO cleaner_availability
          (cleaner_id, available_date, start_time, end_time, is_available)
        VALUES ($1, $2::date, $3::time, $4::time, true)
      `, [req.cleaner.cleaner_profile_id, date, window.start_time, window.end_time]);
    }
    await client.query("COMMIT");
    return res.status(200).json({
      status: "ok", date, windows: normalized,
      message: normalized.length ? "Availability updated" : "Availability cleared for date"
    });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Availability rollback failed:", rollbackError); }
    }
    console.error("Cleaner availability update failed:", { code: error.code, message: error.message });
    return res.status(503).json({ error: "Unable to update availability" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
