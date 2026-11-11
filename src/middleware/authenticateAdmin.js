"use strict";

const jwt = require("jsonwebtoken");
const pool = require("../db");
const { getJwtSecret, JWT_ISSUER, JWT_AUDIENCE } = require("./authenticate");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticate an administrator against the current users table.
 * Does not trust role claims in JWTs; checks the database on every request.
 */
async function authenticateAdmin(req, res, next) {
  const authorization = req.headers.authorization;
  const match = typeof authorization === "string"
    ? /^Bearer ([^\s]+)$/i.exec(authorization)
    : null;

  if (!match) {
    return res.status(401).json({ error: "Authentication required" });
  }

  let claims;
  try {
    claims = jwt.verify(match[1], getJwtSecret(), {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE
    });
  } catch (_error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  if (typeof claims.sub !== "string" || !UUID_PATTERN.test(claims.sub)) {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const result = await pool.query(`
      SELECT id, email, first_name, last_name, role, status
      FROM users
      WHERE id = $1
    `, [claims.sub]);

    const admin = result.rows[0];
    if (!admin || admin.role !== "admin" || admin.status !== "active") {
      return res.status(403).json({ error: "Active administrator account required" });
    }

    req.admin = admin;
    return next();
  } catch (error) {
    console.error("Admin authentication failed:", error);
    return res.status(503).json({ error: "Authentication temporarily unavailable" });
  }
}

module.exports = { authenticateAdmin };