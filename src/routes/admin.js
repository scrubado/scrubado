"use strict";

const express = require("express");
const pool = require("../db");
const { authenticateAdmin } = require("../middleware/authenticateAdmin");
const { allocateCrewPayouts, CrewPayoutError } = require("../services/crewPayoutService");

const router = express.Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Administrator-only authentication smoke test.
// Uses current DB role/status; never exposes hashes or access tokens.
router.get("/me", authenticateAdmin, (req, res) => {
  const { id, email, first_name, last_name, role } = req.admin;
  return res.status(200).json({
    status: "ok",
    user: { id, email, first_name, last_name, role }
  });
});

// Approve a cleaner profile. :id is cleaner_profiles.id, not users.id.
// Approval does NOT enable accepts_new_jobs; job eligibility is separate.
router.patch("/cleaners/:id/verify", authenticateAdmin, async (req, res) => {
  const cleanerProfileId = req.params.id;
  if (!UUID_PATTERN.test(cleanerProfileId)) {
    return res.status(400).json({ error: "Invalid cleaner profile ID" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Recheck administrative authority inside the transaction. The share lock
    // prevents concurrent role/status changes until this transaction completes.
    const actorResult = await client.query(`
      SELECT id FROM users
      WHERE id = $1 AND role = 'admin' AND status = 'active'
      FOR SHARE
    `, [req.admin.id]);

    if (actorResult.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Administrator access required" });
    }

    // Lock both the cleaner account and profile to serialize approvals and
    // ensure the cleaner is still active when the approval is applied.
    const cleanerResult = await client.query(`
      SELECT cp.id, cp.user_id, cp.is_verified, cp.accepts_new_jobs,
             u.role, u.status
      FROM cleaner_profiles AS cp
      JOIN users AS u ON u.id = cp.user_id
      WHERE cp.id = $1
      FOR UPDATE OF cp, u
    `, [cleanerProfileId]);

    if (cleanerResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cleaner profile not found" });
    }

    const cleaner = cleanerResult.rows[0];
    if (cleaner.role !== "cleaner" || cleaner.status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cleaner account is not eligible for verification" });
    }

    if (cleaner.is_verified === true) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cleaner is already verified" });
    }

    const result = await client.query(`
      UPDATE cleaner_profiles
      SET is_verified = true
      WHERE id = $1
      RETURNING id, user_id, is_verified, accepts_new_jobs
    `, [cleanerProfileId]);

    // Audit entry is part of the SAME transaction as the verification change.
    // If writing the audit fails, the verification is rolled back too.
    await client.query(`
      INSERT INTO audit_logs
        (actor_user_id, action, entity_type, entity_id,
         old_values, new_values, ip_address, user_agent)
      VALUES
        ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::inet, $8)
    `, [
      req.admin.id,
      "cleaner.verify",
      "cleaner_profile",
      cleanerProfileId,
      JSON.stringify({ is_verified: false, accepts_new_jobs: cleaner.accepts_new_jobs }),
      JSON.stringify({ is_verified: true, accepts_new_jobs: cleaner.accepts_new_jobs }),
      req.ip || null,
      req.get("user-agent") || null
    ]);

    await client.query("COMMIT");
    return res.status(200).json({
      status: "verified",
      cleaner: result.rows[0]
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Cleaner verification rollback failed:", rollbackError);
      }
    }
    console.error("Cleaner verification failed:", error);
    return res.status(500).json({ error: "Unable to verify cleaner" });
  } finally {
    if (client) client.release();
  }
});


// Development-only accounting allocation. No Stripe charge, transfer, or confirmation.
// :id is bookings.id. Only an active administrator may trigger the service.
router.post("/bookings/:id/allocate-payouts", authenticateAdmin, async (req, res) => {
  if (process.env.NODE_ENV === "production" ||
      process.env.ENABLE_DEV_PAYOUT_ALLOCATION !== "true") {
    return res.status(503).json({ error: "Payout allocation is not enabled" });
  }
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid booking ID" });
  }

  try {
    // AuthenticateAdmin verifies the token. Recheck the live user record too.
    const actor = await pool.query(`
      SELECT id FROM public.users
      WHERE id = $1 AND role = 'admin' AND status = 'active'
    `, [req.admin.id]);
    if (actor.rowCount !== 1) {
      return res.status(403).json({ error: "Administrator access required" });
    }

    const result = await allocateCrewPayouts(req.params.id);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof CrewPayoutError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Payout allocation failed:", {
      code: error.code,
      message: error.message
    });
    return res.status(503).json({ error: "Unable to allocate crew payouts" });
  }
});

module.exports = router;