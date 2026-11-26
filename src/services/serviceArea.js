"use strict";

// Initial Scrubado coverage: deliverable residential ZIP codes only.
// ZIP membership is a preliminary service-area check, not address geocoding.
const ALLOWED_ZIPS = Object.freeze([
  "02067", // Sharon
  "02072", // Stoughton
  "02356", // North Easton
  "02375", // South Easton
  "02766"  // Norton
]);
const ZIP_SET = new Set(ALLOWED_ZIPS);
function isServedAddress(state, postalCode) {
  return state === "MA" && typeof postalCode === "string" && ZIP_SET.has(postalCode);
}
module.exports = { ALLOWED_ZIPS, isServedAddress };
