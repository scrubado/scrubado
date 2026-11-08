"use strict";

const express = require("express");
const pool = require("../db");
const { quote, PricingError } = require("../services/pricingService");
const pricingConfig = require("../config/pricing.json");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const input = req.body;
    const estimate = quote(input);

    // The calculator deliberately stops automated pricing above 4,000 sq ft.
    // Do not store a quote without final calculated amounts.
    if (estimate.status === "manual_review_required") {
      return res.status(200).json(estimate);
    }

    // We have no trusted driving-distance provider yet. A client-supplied
    // distance cannot be relied on to create a persistent price snapshot.
    if (input.drive_miles !== undefined && input.drive_miles !== 0) {
      return res.status(422).json({
        error: "Driving distance must be verified by the server before saving a quote",
      });
    }

    // The database requires >= 1 full bathroom; enforce it before INSERT.
    if (input.full_baths < 1) {
      return res.status(400).json({
        error: "full_baths must be at least 1 for a saved quote",
      });
    }

    // Resolve UUID and confirm the service is active, using the server's
    // catalog rather than accepting a service ID from the client.
    const serviceResult = await pool.query(
      `SELECT id, code, multiplier
         FROM public.services
        WHERE code = $1 AND is_active = true
        LIMIT 1`,
      [estimate.service]
    );
    if (serviceResult.rowCount !== 1) {
      return res.status(422).json({ error: "Service is currently unavailable" });
    }

    // Fail closed if the DB catalog and the approved pricing seed disagree.
    const configuredService = pricingConfig.services.find((s) => s.code === estimate.service);
    if (!configuredService ||
        Number(serviceResult.rows[0].multiplier) !== configuredService.multiplier) {
      console.error("Pricing configuration differs from the active service catalog");
      return res.status(503).json({ error: "Pricing temporarily unavailable" });
    }

    // Customer identity must come from verified authentication later, NOT
    // from a customer_id posted in the request body. For now it remains NULL.
    const insertResult = await pool.query(
      `INSERT INTO public.quotes (
          customer_id, service_id, service_code, pricing_version,
          currency, state, postal_code, square_feet, full_baths,
          half_baths, frequency, addon_selections,
          drive_surcharge_applied, pricing_breakdown,
          customer_total_cents, cleaner_total_cents
        ) VALUES (
          NULL, $1, $2, $3,
          'USD', 'RI', $4, $5, $6,
          $7, $8, $9::jsonb,
          false, $10::jsonb,
          $11, $12
        )
        RETURNING id, status, created_at, expires_at`,
      [
        serviceResult.rows[0].id,
        estimate.service,
        String(pricingConfig.version || "1.0"),
        input.postal_code,
        input.sqft,
        input.full_baths,
        input.half_baths,
        estimate.frequency,
        JSON.stringify(estimate.addons),
        JSON.stringify(estimate.amounts_cents),
        estimate.amounts_cents.customer_total,
        estimate.amounts_cents.cleaner_total,
      ]
    );

    const saved = insertResult.rows[0];
    return res.status(201).json({
      ...estimate,
      quote_id: saved.id,
      quote_status: saved.status,
      created_at: saved.created_at,
      expires_at: saved.expires_at,
      persisted: true,
      disclaimer: "Saved preliminary estimate. Address, availability, authentication, and any travel charges require verification before booking.",
    });
  } catch (err) {
    if (err instanceof PricingError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Quote storage failed:", err);
    return res.status(500).json({ error: "Unable to save quote" });
  }
});

module.exports = router;