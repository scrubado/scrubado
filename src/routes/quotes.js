"use strict";
const express = require("express");
const { quote, PricingError } = require("../services/pricingService");
const router = express.Router();
router.post("/", (req, res) => {
  try { return res.status(200).json(quote(req.body)); }
  catch (err) {
    if (err instanceof PricingError) return res.status(err.status).json({ error: err.message });
    console.error("Quote calculation failed");
    return res.status(500).json({ error: "Unable to calculate quote" });
  }
});
module.exports = router;
