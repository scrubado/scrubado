"use strict";
const jwt = require("jsonwebtoken");
const pool = require("../db");

const JWT_ISSUER = "scrubado-api";
const JWT_AUDIENCE = "scrubado-customer";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_SECRET must contain at least 32 bytes");
  }
  return secret;
}

async function authenticateCustomer(req, res, next) {
  const header = req.get("authorization") || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) return res.status(401).json({ error: "Authentication required" });
  let payload;
  try {
    payload = jwt.verify(match[1], getJwtSecret(), {
      algorithms: ["HS256"], issuer: JWT_ISSUER, audience: JWT_AUDIENCE
    });
    if (typeof payload.sub !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub)) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  } catch (error) {
    if (!(error instanceof jwt.JsonWebTokenError) && !(error instanceof jwt.TokenExpiredError)) {
      console.error("Authentication configuration error:", error.message);
      return res.status(503).json({ error: "Authentication unavailable" });
    }
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.status,
             cp.id AS customer_profile_id
      FROM users u
      JOIN customer_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1 AND u.role = 'customer' AND u.status = 'active'
    `, [payload.sub]);
    if (result.rowCount !== 1) return res.status(401).json({ error: "Account unavailable" });
    req.customer = result.rows[0];
    return next();
  } catch (error) {
    console.error("Customer authentication database check failed:", error);
    return res.status(503).json({ error: "Authentication unavailable" });
  }
}

module.exports = { authenticateCustomer, getJwtSecret, JWT_ISSUER, JWT_AUDIENCE };
