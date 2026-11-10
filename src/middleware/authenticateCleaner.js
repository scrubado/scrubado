"use strict";
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { getJwtSecret, JWT_ISSUER, JWT_AUDIENCE } = require("./authenticate");

// Authenticate a cleaner. Verification is a separate authorization requirement.
async function authenticateCleaner(req, res, next) {
  const header = req.headers.authorization;
  const match = typeof header === "string" && /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return res.status(401).json({ error: "Authentication required" });
  let decoded;
  try {
    decoded = jwt.verify(match[1], getJwtSecret(), {
      algorithms: ["HS256"], issuer: JWT_ISSUER, audience: JWT_AUDIENCE
    });
  } catch (_) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  if (typeof decoded.sub !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.sub)) {
    return res.status(401).json({ error: "Invalid token" });
  }
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.status,
             cp.id AS cleaner_profile_id, cp.is_verified, cp.accepts_new_jobs
      FROM users u JOIN cleaner_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1
    `, [decoded.sub]);
    const row = result.rows[0];
    if (!row || row.role !== "cleaner" || row.status !== "active") {
      return res.status(403).json({ error: "Active cleaner account required" });
    }
    req.cleaner = row;
    return next();
  } catch (error) {
    console.error("Cleaner authentication failed:", error);
    return res.status(503).json({ error: "Authentication temporarily unavailable" });
  }
}

function requireVerifiedCleaner(req, res, next) {
  if (!req.cleaner || req.cleaner.is_verified !== true || req.cleaner.accepts_new_jobs !== true) {
    return res.status(403).json({ error: "Verified, eligible cleaner required" });
  }
  next();
}

module.exports = { authenticateCleaner, requireVerifiedCleaner };
