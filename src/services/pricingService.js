"use strict";
const config = require("../config/pricing.json");

class PricingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const cents = dollars => Math.round((dollars + Number.EPSILON) * 100);
const roundShare = (amountCents, share) => Math.round(amountCents * share);
const dollars = value => Number((value / 100).toFixed(2));

function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PricingError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function quote(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PricingError("JSON object required");
  const { sqft, full_baths, half_baths, service, frequency, state, postal_code, drive_miles = 0, addons = [] } = input;
  integer(sqft, "sqft", 1, 6000);
  integer(full_baths, "full_baths", 0, 30);
  integer(half_baths, "half_baths", 0, 30);
  if (typeof state !== "string" || state.toUpperCase() !== "RI") throw new PricingError("Only Rhode Island addresses are supported");
  if (typeof postal_code !== "string" || !/^0(28|29)\d{2}$/.test(postal_code) || postal_code === "02807") {
    throw new PricingError("Valid Rhode Island ZIP code required; 02807 is excluded");
  }
  if (typeof drive_miles !== "number" || !Number.isFinite(drive_miles) || drive_miles < 0 || drive_miles > 1000) {
    throw new PricingError("drive_miles must be between 0 and 1000");
  }
  const svc = config.services.find(x => x.code === service);
  const freq = config.frequencies.find(x => x.code === frequency);
  if (!svc) throw new PricingError("Unknown service");
  if (!freq) throw new PricingError("Unknown frequency");
  if (!Array.isArray(addons) || addons.length > 12) throw new PricingError("addons must be an array of at most 12 items");
  const band = config.bands.find(x => sqft >= x.from_sqft && sqft <= x.to_sqft);
  if (!band) throw new PricingError("Square footage outside supported range");
  // >4,000 sq ft requires human review; never issue a final automated amount.
  if (sqft > 4000) return { status: "manual_review_required", reason: "Properties over 4,000 sq ft require a custom quote", currency: "USD" };

  const baseStandardCents = Math.max(cents(sqft * band.rate_per_sqft), cents(band.floor), cents(config.settings.minimum_standard_job));
  const serviceBaseCents = Math.round(baseStandardCents * svc.multiplier);
  const bathroomCents = cents(Math.max(0, full_baths - config.settings.included_full_baths) * config.settings.extra_full_bath + half_baths * config.settings.extra_half_bath);
  const discountRate = svc.discount_allowed ? freq.discount : 0;
  const discountedCoreCents = Math.round((serviceBaseCents + bathroomCents) * (1 - discountRate));
  let addonCents = 0;
  const addonBreakdown = [];
  const seen = new Set();
  for (const selected of addons) {
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new PricingError("Invalid addon entry");
    const { code, quantity = 1 } = selected;
    const addon = config.addons.find(x => x.code === code);
    if (!addon) throw new PricingError(`Unknown addon: ${String(code)}`);
    if (seen.has(code)) throw new PricingError(`Duplicate addon: ${code}`);
    seen.add(code);
    integer(quantity, `quantity for ${code}`, 1, 20);
    const included = addon.included_in.includes(service);
    const priceCents = included ? 0 : cents(addon.price * quantity);
    addonCents += priceCents;
    addonBreakdown.push({ code, quantity, included, amount_cents: priceCents });
  }
  // IMPORTANT: Client-supplied drive_miles must be independently verified before charging.
  const driveCents = drive_miles > config.settings.drive_adder_miles ? cents(config.settings.drive_adder) : 0;
  const totalCents = discountedCoreCents + addonCents + driveCents;
  const cleanerCoreCents = roundShare(discountedCoreCents, config.settings.cleaner_share);
  const cleanerAddonCents = roundShare(addonCents, config.settings.addon_cleaner_share);
  const cleanerDriveCents = roundShare(driveCents, config.settings.drive_cleaner_share);
  const cleanerTotalCents = cleanerCoreCents + cleanerAddonCents + cleanerDriveCents;
  const feeCents = roundShare(totalCents, config.settings.processing_rate) + cents(config.settings.processing_fixed);
  const reserveCents = roundShare(totalCents, config.settings.reserve_rate);
  return {
    status: "estimate", currency: "USD", service, frequency, sqft,
    amounts_cents: {
      standard_base: baseStandardCents, service_base: serviceBaseCents,
      bathrooms: bathroomCents,
      recurring_discount: serviceBaseCents + bathroomCents - discountedCoreCents,
      addons: addonCents, drive: driveCents,
      customer_total: totalCents, cleaner_total: cleanerTotalCents,
      processing_estimate: feeCents, reserve_estimate: reserveCents,
      platform_remainder_estimate: totalCents - cleanerTotalCents - feeCents - reserveCents,
    },
    addons: addonBreakdown,
    // Not a stored or authenticated booking quote. Caller must verify location, availability, user and drive distance.
    disclaimer: "Indicative server-calculated estimate; not a booking or price guarantee",
  };
}
module.exports = { quote, PricingError, dollars };
