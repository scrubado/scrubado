"use strict";

const express = require("express");
const pool = require("../db");
const { authenticateCleaner } = require("../middleware/authenticateCleaner");

const router = express.Router();

// Read-only job discovery. No payment, membership, or unlock requirement.
// Do not expose the customer's identity, street address, or private notes.
router.get("/jobs", authenticateCleaner, async (req, res) => {
  const cleanerUserId = req.cleaner && req.cleaner.id;
  if (!cleanerUserId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    // Recheck database state rather than relying on claims inside a JWT.
    // Verification controls access to this initial discovery endpoint;
    // accepts_new_jobs is checked later when implementing job acceptance.
    const eligibility = await pool.query(`
      SELECT cp.id, cp.is_verified, cp.accepts_new_jobs
      FROM cleaner_profiles cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.user_id = $1
        AND u.role = 'cleaner'
        AND u.status = 'active'
      LIMIT 1
    `, [cleanerUserId]);

    if (eligibility.rowCount === 0) {
      return res.status(403).json({ error: "Cleaner account unavailable" });
    }
    if (eligibility.rows[0].is_verified !== true) {
      return res.status(403).json({ error: "Cleaner verification required" });
    }

    // Display only unassigned, upcoming requests.
    // Availability, coverage/radius, conflicts, and financial eligibility
    // must be validated independently before a cleaner can accept a job.
    const result = await pool.query(`
      SELECT
        b.id,
        b.service_id,
        s.name AS service_name,
        TO_CHAR(b.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
        TO_CHAR(b.start_time, 'HH24:MI') AS start_time,
        CASE WHEN b.end_time IS NULL THEN NULL
             ELSE TO_CHAR(b.end_time, 'HH24:MI') END AS end_time,
        b.city,
        b.state,
        b.required_crew_size,
        b.status
      FROM bookings b
      JOIN services s ON s.id = b.service_id
      WHERE b.status = 'requested'
        AND b.cleaner_id IS NULL
        AND b.scheduled_date >= CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM booking_cleaners bc
          WHERE bc.booking_id = b.id
        )
      ORDER BY b.scheduled_date ASC, b.start_time ASC, b.id ASC
      LIMIT 50
    `);

    return res.status(200).json({
      status: "ok",
      cleaner: {
        is_verified: true,
        accepts_new_jobs: eligibility.rows[0].accepts_new_jobs === true
      },
      jobs: result.rows,
      count: result.rows.length,
      note: "Viewing a job does not reserve it. Availability and eligibility are checked before acceptance."
    });
  } catch (error) {
    console.error("Cleaner job discovery failed:", {
      code: error.code,
      message: error.message
    });
    return res.status(503).json({ error: "Unable to retrieve available jobs" });
  }
});

module.exports = router;