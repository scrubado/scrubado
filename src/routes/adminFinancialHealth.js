"use strict";

// Admin-only, read-only local database financial health diagnostics.
const express = require("express");
const pool = require("../db");
const { authenticateAdmin } = require("../middleware/authenticateAdmin");
const { getFinancialHealth } = require("../services/financialHealthService");
const router = express.Router();

router.get("/financial-health", authenticateAdmin, async (req, res) => {
  try {
    const actor = await pool.query(`
      SELECT id FROM public.users
      WHERE id = $1 AND role = 'admin' AND status = 'active'
    `, [req.admin.id]);
    if (actor.rowCount !== 1) {
      return res.status(403).json({ error: "Administrator access required" });
    }
    const report = await getFinancialHealth();
    return res.status(200).json(report);
  } catch (error) {
    console.error("Admin financial health check failed:", error.code || error.message);
    return res.status(503).json({ error: "Financial health temporarily unavailable" });
  }
});

module.exports = router;