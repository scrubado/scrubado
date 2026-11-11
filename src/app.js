const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const pool = require("./db");
const quotesRouter = require("./routes/quotes");
const authRouter = require("./routes/auth");
const bookingsRouter = require("./routes/bookings");
const adminRouter = require("./routes/admin");
const cleanerJobsRouter = require("./routes/cleanerJobs");
const cleanerAvailabilityRouter = require("./routes/cleanerAvailability");
const cleanerAcceptanceRouter = require("./routes/cleanerAcceptance");

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Netlify Dev can pass an already-read JSON body as a Buffer instead of
// an ordinary object. Normalize auth, quote, and booking requests here.
function normalizeAuthBody(req, res, next) {
  const contentType = req.get("content-type") || "";
  const isJson = /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/i.test(contentType);
  if (!isJson) return next();

  let raw = null;
  if (Buffer.isBuffer(req.body) || req.body instanceof Uint8Array) {
    raw = Buffer.from(req.body);
  } else if (typeof req.body === "string") {
    raw = Buffer.from(req.body, "utf8");
  } else if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    // Accommodate a byte buffer converted into a numeric-keyed object.
    const keys = Object.keys(req.body);
    if (keys.length > 0 && keys.every((key, i) => key === String(i) &&
        Number.isInteger(req.body[key]) && req.body[key] >= 0 && req.body[key] <= 255)) {
      raw = Buffer.from(keys.map(key => req.body[key]));
    }
  }

  if (raw === null) return next(); // Already parsed by express.json().
  if (raw.length > 65536) return res.status(413).json({ error: "Request body too large" });

  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return res.status(400).json({ error: "JSON object required" });
    }
    req.body = value;
    return next();
  } catch {
    return res.status(400).json({ error: "Malformed JSON" });
  }
}

app.use(["/auth", "/api/auth"], normalizeAuthBody, authRouter);

app.get(["/health", "/api/health"], (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "scrubado-api"
  });
});

app.get(["/health/db", "/api/health/db"], async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.status(200).json({
      status: "ok",
      service: "scrubado-api",
      database: "connected",
      timestamp: result.rows[0].now
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    res.status(500).json({
      status: "error",
      service: "scrubado-api",
      database: "disconnected"
    });
  }
});

app.get(["/services", "/api/services"], async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, description, base_price, estimated_minutes
      FROM services
      WHERE is_active = true
      ORDER BY name ASC
    `);

    res.status(200).json({
      status: "ok",
      services: result.rows
    });
  } catch (error) {
    console.error("Services lookup failed:", error);

    res.status(500).json({
      status: "error",
      message: "Unable to retrieve services"
    });
  }
});

// Preliminary server-side quotes; does not create bookings or collect payment.
app.use(["/quotes", "/api/quotes"], normalizeAuthBody, quotesRouter);
app.use(["/bookings", "/api/bookings"], normalizeAuthBody, bookingsRouter);
app.use(["/admin", "/api/admin"], adminRouter);
app.use(["/cleaner", "/api/cleaner"], cleanerJobsRouter);
app.use(["/cleaner", "/api/cleaner"], normalizeAuthBody, cleanerAvailabilityRouter);
app.use(["/cleaner", "/api/cleaner"], normalizeAuthBody, cleanerAcceptanceRouter);

module.exports = app;