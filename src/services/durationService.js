"use strict";

// Scheduling estimates, NOT customer prices. All times are elapsed minutes for
// the full assigned crew. Real-world times should be calibrated after pilot jobs.
const BASE_SOLO_MINUTES = [
  { maxSqft: 800, minutes: 120 },
  { maxSqft: 1200, minutes: 150 },
  { maxSqft: 1600, minutes: 180 },
  { maxSqft: 2000, minutes: 210 },
  { maxSqft: 2500, minutes: 240 },
  { maxSqft: 3200, minutes: 300 },
  { maxSqft: 4000, minutes: 360 }
];
const SERVICE_FACTORS = Object.freeze({ standard: 1, deep: 1.5, move: 1.75 });
const ADDON_MINUTES = Object.freeze({
  oven: 30, fridge: 25, cabinets: 40, windows_floor: 25,
  laundry_load: 45, dishes: 20, patio: 25, basement: 45,
  pet_hair: 25, priority_48h: 0, same_day: 0, supplies: 0
});
const INCLUDED = Object.freeze({
  deep: new Set(["oven", "fridge", "cabinets"]),
  move: new Set(["oven", "fridge", "cabinets"])
});

class DurationError extends Error {}
function whole(n, low, high, label) {
  if (!Number.isSafeInteger(n) || n < low || n > high) {
    throw new DurationError(`${label} must be an integer between ${low} and ${high}`);
  }
}
function crewSizeForJob(service, sqft) {
  if (!Object.hasOwn(SERVICE_FACTORS, service)) throw new DurationError("Unknown cleaning service");
  whole(sqft, 1, 4000, "square_feet");
  if (service === "move") return 2;
  if (service === "deep") return sqft > 1200 ? 2 : 1;
  return sqft > 2000 ? 2 : 1;
}
function estimateJob({ square_feet, service_code, full_baths, half_baths = 0, addon_selections = [] }) {
  whole(square_feet, 1, 4000, "square_feet");
  whole(full_baths, 1, 30, "full_baths");
  whole(half_baths, 0, 30, "half_baths");
  if (!Object.hasOwn(SERVICE_FACTORS, service_code)) throw new DurationError("Unknown cleaning service");
  if (!Array.isArray(addon_selections) || addon_selections.length > 12) throw new DurationError("Invalid add-ons");
  const crewSize = crewSizeForJob(service_code, square_feet);
  const base = BASE_SOLO_MINUTES.find(b => square_feet <= b.maxSqft).minutes;
  const bathroom = Math.max(0, full_baths - 1) * 25 + half_baths * 15;
  const seen = new Set();
  let addons = 0;
  for (const item of addon_selections) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new DurationError("Invalid add-on selection");
    const { code, quantity = 1 } = item;
    if (typeof code !== "string" || !Object.hasOwn(ADDON_MINUTES, code) || seen.has(code)) throw new DurationError("Unknown or duplicate add-on");
    whole(quantity, 1, 20, "add-on quantity");
    seen.add(code);
    if (!INCLUDED[service_code]?.has(code)) addons += ADDON_MINUTES[code] * quantity;
  }
  const soloLaborMinutes = Math.ceil(base * SERVICE_FACTORS[service_code] + bathroom + addons);
  // Two cleaners share labor, but coordination reduces theoretical doubling of speed.
  const efficiency = crewSize === 2 ? 0.85 : 1;
  const estimate = Math.max(90, Math.ceil(soloLaborMinutes / (crewSize * efficiency) / 30) * 30);
  return {
    required_crew_size: crewSize,
    estimated_minutes: estimate,
    solo_labor_minutes: soloLaborMinutes,
    estimation_version: "crew-duration-v1"
  };
}
function scheduledEnd(start_time, estimated_minutes) {
  if (typeof start_time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start_time)) {
    throw new DurationError("Invalid start_time");
  }
  whole(estimated_minutes, 1, 1440, "estimated_minutes");
  const [hours, mins] = start_time.split(":").map(Number);
  const end = hours * 60 + mins + estimated_minutes;
  // The current schema has only one scheduled_date and time-only fields.
  // Reject cross-midnight jobs until we implement timestamp ranges.
  if (end >= 1440) throw new DurationError("Cleaning would extend past midnight; choose an earlier start");
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}
module.exports = { DurationError, estimateJob, crewSizeForJob, scheduledEnd };
