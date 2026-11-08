

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const pool = require("./db");

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

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

module.exports = app;