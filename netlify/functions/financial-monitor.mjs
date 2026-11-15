// Netlify scheduled function: financial-monitor.
// Schedule is hourly UTC, but monitoring is OFF until explicitly enabled.
// This function does NOT contact Stripe or mutate financial records.
// Requires ENABLE_FINANCIAL_MONITOR=true and DATABASE_URL to run.
import financialHealthService from "../../src/services/financialHealthService.js";

export default async function handler() {
  if (process.env.ENABLE_FINANCIAL_MONITOR !== "true") {
    console.info("SCRUBADO_FINANCIAL_MONITOR_DISABLED");
    return;
  }
  try {
    const report = await financialHealthService.getFinancialHealth();
    // Avoid exposing IDs in platform logs; no PII or Stripe secrets logged.
    console.info("SCRUBADO_FINANCIAL_MONITOR_RESULT", JSON.stringify({
      checked_at: report.checked_at,
      status: report.status,
      total_issues: report.total_issues,
      counts: report.counts,
      issues_truncated: report.issues_truncated,
      source: report.source,
      stripe_verified: report.stripe_verified
    }));
  } catch (error) {
    console.error("SCRUBADO_FINANCIAL_MONITOR_FAILED", error.code || error.message);
    throw error; // Surface run failures in Netlify logs.
  }
}

export const config = { schedule: "@hourly" };