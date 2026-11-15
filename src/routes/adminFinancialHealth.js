"use strict";

// src/routes/adminFinancialHealth.js
// Admin-only, read-only local database financial health diagnostics.
// No Stripe API calls, refunds, status changes, or background jobs.

const express = require("express");
const pool = require("../db");
const { authenticateAdmin } = require("../middleware/authenticateAdmin");

const router = express.Router();

const ISSUE_TYPES = [
  "stale_refund",
  "failed_refund",
  "refunded_booking_not_cancelled",
  "stale_payment",
  "unprocessed_webhook"
];

router.get("/financial-health", authenticateAdmin, async (req, res) => {
  try {
    // Check current DB permissions; a previously issued JWT is not enough.
    const actor = await pool.query(`
      SELECT id FROM public.users
      WHERE id = $1 AND role = 'admin' AND status = 'active'
    `, [req.admin.id]);
    if (actor.rowCount !== 1) {
      return res.status(403).json({ error: "Administrator access required" });
    }

    // One read-only statement provides a consistent local-database snapshot.
    // Return complete counts, but cap detail rows to 100. No PII is selected.
    const result = await pool.query(`
      WITH issues AS MATERIALIZED (
        SELECT 'stale_refund'::text AS issue_type,
               r.id::text AS record_id,
               r.status::text AS current_status,
               r.updated_at AS last_updated
        FROM public.payment_refunds r
        WHERE r.status IN ('pending', 'processing')
          AND r.updated_at < NOW() - INTERVAL '15 minutes'

        UNION ALL

        SELECT 'failed_refund', r.id::text, r.status::text, r.updated_at
        FROM public.payment_refunds r
        WHERE r.status = 'failed'

        UNION ALL

        SELECT 'refunded_booking_not_cancelled', b.id::text,
               b.status::text, b.updated_at
        FROM public.payment_refunds r
        JOIN public.payments p ON p.id = r.payment_id
        JOIN public.bookings b ON b.id = p.booking_id
        WHERE r.status = 'succeeded' AND b.status <> 'cancelled'

        UNION ALL

        SELECT 'stale_payment', p.id::text, p.status::text, p.updated_at
        FROM public.payments p
        WHERE p.status IN (
          'pending', 'processing', 'requires_payment_method',
          'requires_action', 'requires_confirmation'
        )
          AND p.updated_at < NOW() - INTERVAL '30 minutes'

        UNION ALL

        SELECT 'unprocessed_webhook', e.id::text, e.event_type::text,
               e.created_at
        FROM public.stripe_webhook_events e
        WHERE e.processed_at IS NULL
          AND e.created_at < NOW() - INTERVAL '5 minutes'
      ),
      limited AS (
        SELECT issue_type, record_id, current_status, last_updated
        FROM issues
        ORDER BY last_updated ASC NULLS FIRST, issue_type, record_id
        LIMIT 100
      )
      SELECT NOW() AS checked_at,
             (SELECT COUNT(*)::integer FROM issues) AS total_issues,
             (SELECT COALESCE(jsonb_object_agg(issue_type, issue_count), '{}'::jsonb)
              FROM (
                SELECT issue_type, COUNT(*)::integer AS issue_count
                FROM issues GROUP BY issue_type
              ) summary) AS counts,
             (SELECT COALESCE(jsonb_agg(to_jsonb(limited)), '[]'::jsonb)
              FROM limited) AS issues
    `);

    const data = result.rows[0];
    const counts = Object.fromEntries(ISSUE_TYPES.map(type => [type, data.counts[type] || 0]));
    const total = Number(data.total_issues);
    return res.status(200).json({
      status: total === 0 ? "ok" : "attention_required",
      checked_at: data.checked_at,
      source: "neon_local_records_only",
      stripe_verified: false,
      thresholds_minutes: { stale_refund: 15, stale_payment: 30, unprocessed_webhook: 5 },
      total_issues: total,
      counts,
      issues: data.issues,
      issue_limit: 100,
      issues_truncated: total > 100,
      read_only: true
    });
  } catch (error) {
    console.error("Admin financial health check failed:", error.code || error.message);
    return res.status(503).json({ error: "Financial health temporarily unavailable" });
  }
});

module.exports = router;