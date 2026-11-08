"use strict";
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const pool = require("../db");
const { authenticateCustomer, getJwtSecret, JWT_ISSUER, JWT_AUDIENCE } = require("../middleware/authenticate");

const router = express.Router();
// Netlify Dev can omit req.ip. Share a local-only limiter bucket in that case.
// In production, fail closed rather than silently bypass IP-based limiting.
function rateLimitKey(req) {
  if (typeof req.ip === "string" && req.ip.length > 0) {
    return ipKeyGenerator(req.ip);
  }
  if (process.env.NODE_ENV !== "production") {
    return "netlify-dev-local";
  }
  throw new Error("Missing client IP for authentication rate limiting");
}

const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: "Too many requests. Try again later." }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: "Too many requests. Try again later." }
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validName(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 100;
}
function validPassword(value) {
  // bcrypt truncates after 72 bytes; refuse ambiguous long passwords.
  return typeof value === "string" && value.length >= 12 && Buffer.byteLength(value, "utf8") <= 72;
}
function safeUser(row) {
  return { id: row.id, email: row.email, first_name: row.first_name,
    last_name: row.last_name, role: row.role, customer_profile_id: row.customer_profile_id };
}

router.post("/register", registrationLimiter, async (req, res) => {
  const { email, password, first_name, last_name } = req.body || {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalizedEmail.length > 254 || !emailPattern.test(normalizedEmail) ||
      !validPassword(password) || !validName(first_name) || !validName(last_name)) {
    return res.status(400).json({ error: "Valid email, names, and a password of 12–72 bytes are required" });
  }
  let client;
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    client = await pool.connect();
    await client.query("BEGIN");
    const userResult = await client.query(`
      INSERT INTO users (email, password_hash, first_name, last_name, role, status)
      VALUES ($1, $2, $3, $4, 'customer', 'active')
      RETURNING id, email, first_name, last_name, role
    `, [normalizedEmail, passwordHash, first_name.trim(), last_name.trim()]);
    const user = userResult.rows[0];
    const profileResult = await client.query(`
      INSERT INTO customer_profiles (user_id) VALUES ($1) RETURNING id
    `, [user.id]);
    await client.query("COMMIT");
    return res.status(201).json({ status: "created", user: {
      ...user, customer_profile_id: profileResult.rows[0].id
    }});
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { console.error("Registration rollback failed:", rollbackError); }
    }
    if (error.code === "23505") return res.status(409).json({ error: "Account could not be created with those details" });
    console.error("Registration failed:", error);
    return res.status(500).json({ error: "Unable to create account" });
  } finally {
    if (client) client.release();
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!emailPattern.test(normalizedEmail) || typeof password !== "string") {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.password_hash, u.first_name, u.last_name, u.role, u.status,
             cp.id AS customer_profile_id
      FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id
      WHERE u.email = $1
    `, [normalizedEmail]);
    const row = result.rows[0];
    // Compare even when no matching user exists, to reduce account-enumeration timing differences.
    const fallbackHash = "$2b$12$wUHl3tg87t92SgJmo1dQAO1q14WQGoUrN8bzw6nPDt0drsJnf2CyG";
    const matches = await bcrypt.compare(password, row?.password_hash || fallbackHash);
    if (!matches || row?.role !== "customer" || row?.status !== "active" ||
        !row?.customer_profile_id || !uuid.test(row.id)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({}, getJwtSecret(), {
      subject: row.id, algorithm: "HS256", expiresIn: "1h",
      issuer: JWT_ISSUER, audience: JWT_AUDIENCE
    });
    return res.status(200).json({ access_token: token, token_type: "Bearer",
      expires_in: 3600, user: safeUser(row) });
  } catch (error) {
    console.error("Customer login failed:", error);
    return res.status(503).json({ error: "Login temporarily unavailable" });
  }
});

router.get("/me", authenticateCustomer, (req, res) => {
  return res.status(200).json({ user: safeUser(req.customer) });
});

module.exports = router;