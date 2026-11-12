"use strict";

const express = require("express");
const pool = require("../db");
const { authenticateCleaner } = require("../middleware/authenticateCleaner");

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Development-only MVP: solo and two-cleaner assignment claims.
// Crew payouts, checkout/payment, and confirmation are NOT implemented here.
router.post("/jobs/:id/accept", authenticateCleaner, async (req, res) => {
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_JOB_ACCEPTANCE !== "true") {
    return res.status(503).json({ error: "Job acceptance is not enabled" });
  }
  if (!UUID.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid booking ID" });
  }

  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;

    // Lock the cleaner profile first: this also serializes with PUT availability.
    const eligibility = await client.query(`
      SELECT cp.id, cp.is_verified, cp.accepts_new_jobs
      FROM cleaner_profiles cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.id = $1 AND cp.user_id = $2
        AND u.role = 'cleaner' AND u.status = 'active'
      FOR UPDATE OF cp
    `, [req.cleaner.cleaner_profile_id, req.cleaner.id]);
    if (eligibility.rowCount !== 1 || !eligibility.rows[0].is_verified ||
        !eligibility.rows[0].accepts_new_jobs) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(403).json({ error: "Verified cleaner with job acceptance enabled required" });
    }

    // Row lock means simultaneous cleaners cannot claim the same booking.
    const found = await client.query(`
      SELECT id, scheduled_date, start_time, end_time, status,
             cleaner_id, required_crew_size
      FROM bookings WHERE id = $1 FOR UPDATE
    `, [req.params.id]);
    if (!found.rowCount) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(404).json({ error: "Booking not found" });
    }
    const booking = found.rows[0];
    // Booking lock serializes claims for the same booking (including competing seconds).
    // Require a consistent lead record before a second cleaner can join.
    const active = await client.query(`
      SELECT cleaner_id, crew_role
      FROM booking_cleaners
      WHERE booking_id = $1 AND assignment_status = 'assigned'
    `, [booking.id]);
    const assignments = active.rows;
    const lead = assignments.find(row => row.crew_role === "lead");
    const second = assignments.find(row => row.crew_role === "second");
    let crewRole;

    if (booking.required_crew_size === 1) {
      if (booking.status !== "requested" || booking.cleaner_id !== null || assignments.length !== 0) {
        await client.query("ROLLBACK"); inTransaction = false;
        return res.status(409).json({ error: "Booking is no longer available" });
      }
      crewRole = "lead";
    } else if (booking.required_crew_size === 2) {
      if (booking.status === "requested" && booking.cleaner_id === null && assignments.length === 0) {
        crewRole = "lead";
      } else if (booking.status === "accepted" && lead && !second &&
                 assignments.length === 1 && booking.cleaner_id === lead.cleaner_id) {
        if (lead.cleaner_id === req.cleaner.cleaner_profile_id) {
          await client.query("ROLLBACK"); inTransaction = false;
          return res.status(409).json({ error: "Lead cleaner cannot also be second cleaner" });
        }
        crewRole = "second";
      } else {
        await client.query("ROLLBACK"); inTransaction = false;
        return res.status(409).json({ error: "Crew position is not available" });
      }
    } else {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Unsupported crew size" });
    }

    // No unknown-duration or past jobs may be accepted.
    const schedule = await client.query(`
      SELECT ($1::date + $2::time) AT TIME ZONE 'America/New_York' > NOW() AS in_future,
             ($3::time > $2::time) AS valid_interval
    `, [booking.scheduled_date, booking.start_time, booking.end_time]);
    if (!booking.end_time || !schedule.rows[0].in_future || !schedule.rows[0].valid_interval) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Booking needs a valid future start and end time" });
    }

    // A single availability window must cover the full appointment.
    const availability = await client.query(`
      SELECT 1 FROM cleaner_availability
      WHERE cleaner_id = $1 AND is_available = true
        AND available_date = $2::date
        AND start_time <= $3::time AND end_time >= $4::time
      LIMIT 1
    `, [req.cleaner.cleaner_profile_id, booking.scheduled_date, booking.start_time, booking.end_time]);
    if (!availability.rowCount) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Cleaner availability does not cover this appointment" });
    }

    // Check all currently live assignments; retain historic rows but ignore removed ones.
    const conflicts = await client.query(`
      SELECT 1 FROM booking_cleaners bc
      JOIN bookings b ON b.id = bc.booking_id
      WHERE bc.cleaner_id = $1
        AND bc.assignment_status = 'assigned'
        AND b.status IN ('requested','accepted','confirmed','in_progress')
        AND b.scheduled_date = $2::date
        AND b.start_time < $4::time AND b.end_time > $3::time
      LIMIT 1
    `, [req.cleaner.cleaner_profile_id, booking.scheduled_date, booking.start_time, booking.end_time]);
    if (conflicts.rowCount) {
      await client.query("ROLLBACK"); inTransaction = false;
      return res.status(409).json({ error: "Cleaner has a scheduling conflict" });
    }

    // Active-role uniqueness is enforced again by partial unique indexes in Neon.
    // Payouts stay NULL until an authoritative cleaner-share calculation is wired in.
    await client.query(`
      INSERT INTO booking_cleaners (booking_id, cleaner_id, crew_role, assignment_status)
      VALUES ($1, $2, $3, 'assigned')
    `, [booking.id, req.cleaner.cleaner_profile_id, crewRole]);

    let updated;
    if (crewRole === "lead") {
      // Legacy cleaner_id refers to the lead cleaner PROFILE (not users.id).
      updated = await client.query(`
        UPDATE bookings SET cleaner_id = $2, status = 'accepted', updated_at = NOW()
        WHERE id = $1 AND status = 'requested' AND cleaner_id IS NULL
        RETURNING id, status, scheduled_date, start_time, end_time, required_crew_size
      `, [booking.id, req.cleaner.cleaner_profile_id]);
    } else {
      // The second cleaner does not replace the lead or confirm the booking.
      updated = await client.query(`
        UPDATE bookings SET updated_at = NOW()
        WHERE id = $1 AND status = 'accepted' AND cleaner_id = $2
        RETURNING id, status, scheduled_date, start_time, end_time, required_crew_size
      `, [booking.id, lead.cleaner_id]);
    }
    if (updated.rowCount !== 1) throw new Error("Booking state changed during transaction");

    await client.query("COMMIT"); inTransaction = false;
    const assignedCount = assignments.length + 1;
    return res.status(200).json({
      status: "accepted",
      booking: updated.rows[0],
      crew: {
        role: crewRole,
        assigned_count: assignedCount,
        required_count: booking.required_crew_size,
        filled: assignedCount === booking.required_crew_size
      },
      note: "Development-only assignment. Not paid or confirmed. Crew payouts pending pricing integration."
    });
  } catch (error) {
    if (client && inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Acceptance rollback failed:", rollbackError); }
    }
    if (error.code === "23505") {
      return res.status(409).json({ error: "Assignment already exists" });
    }
    console.error("Cleaner job acceptance failed:", { code: error.code, message: error.message });
    return res.status(503).json({ error: "Unable to accept job" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;