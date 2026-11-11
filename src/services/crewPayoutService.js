"use strict";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BIGINT = 9223372036854775807n;

class CrewPayoutError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "CrewPayoutError";
    this.status = status;
  }
}

function positiveCents(value, name, allowZero = false) {
  if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
      !/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new CrewPayoutError(`${name} must be a nonnegative whole-cent amount`);
  }
  const amount = BigInt(value);
  if ((allowZero ? amount < 0n : amount <= 0n) || amount > MAX_BIGINT) {
    throw new CrewPayoutError(`${name} is outside the supported range`);
  }
  return amount;
}

// Integer-only money arithmetic; the second share gets the exact remainder.
function calculateCrewShares(cleanerTotalCents, crewSize) {
  const total = positiveCents(cleanerTotalCents, "Cleaner total");
  if (crewSize === 1) return { lead: total.toString(), second: null };
  if (crewSize !== 2) throw new CrewPayoutError("Only one- or two-cleaner bookings are supported");
  const lead = (total * 60n + 50n) / 100n; // nearest cent, half-up
  return { lead: lead.toString(), second: (total - lead).toString() };
}

/**
 * Allocate, but NEVER transfer, cleaner compensation.
 *
 * Only call this from a trusted server-side workflow AFTER a booking is
 * accepted and its crew is fully assigned. This service is not an HTTP route.
 * It owns its transaction and locks the booking and its assignment rows.
 * No payout is written when a quote is missing, a crew is incomplete, or
 * compensation data is inconsistent.
 */
async function allocateCrewPayouts(bookingId) {
  if (typeof bookingId !== "string" || !UUID.test(bookingId)) {
    throw new CrewPayoutError("Invalid booking ID", 400);
  }

  // Load the database only when allocation is requested; arithmetic remains independently testable.
  const pool = require("../db");
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;

    const bookingResult = await client.query(`
      SELECT id, customer_id, service_id, cleaner_id, status,
             required_crew_size, quote_id, quoted_price_cents
      FROM public.bookings
      WHERE id = $1
      FOR UPDATE
    `, [bookingId]);
    if (bookingResult.rowCount !== 1) throw new CrewPayoutError("Booking not found", 404);
    const booking = bookingResult.rows[0];

    // Do not allocate for test requests, cancelled jobs or completed jobs.
    // Confirmation and payment belong to separate, later workflows.
    if (booking.status !== "accepted") {
      throw new CrewPayoutError("Payout allocation requires an accepted booking");
    }
    if (!booking.quote_id || booking.quoted_price_cents == null) {
      throw new CrewPayoutError("Booking has no linked confirmed quote amount");
    }

    // Quote ownership is users.id; booking ownership is customer_profiles.id.
    // Resolve through the profile instead of comparing unlike identifiers.
    const quoteResult = await client.query(`
      SELECT q.id, q.customer_id, cp.id AS customer_profile_id,
             q.service_id, q.currency, q.status,
             q.customer_total_cents, q.cleaner_total_cents
      FROM public.quotes AS q
      LEFT JOIN public.customer_profiles AS cp
        ON cp.user_id = q.customer_id
      WHERE q.id = $1
      FOR SHARE OF q
    `, [booking.quote_id]);
    if (quoteResult.rowCount !== 1) throw new CrewPayoutError("Linked quote not found");
    const quote = quoteResult.rows[0];
    if (quote.status !== "used" || String(quote.currency).trim() !== "USD" ||
        quote.customer_profile_id !== booking.customer_id || quote.service_id !== booking.service_id) {
      throw new CrewPayoutError("Booking and linked quote do not match");
    }

    const customerTotal = positiveCents(quote.customer_total_cents, "Customer total");
    const cleanerTotal = positiveCents(quote.cleaner_total_cents, "Cleaner total");
    const bookingTotal = positiveCents(booking.quoted_price_cents, "Booking total");
    if (customerTotal !== bookingTotal || cleanerTotal > customerTotal) {
      throw new CrewPayoutError("Stored booking and quote totals are inconsistent");
    }

    const assignmentsResult = await client.query(`
      SELECT id, cleaner_id, crew_role, assignment_status, payout_cents
      FROM public.booking_cleaners
      WHERE booking_id = $1
      ORDER BY id
      FOR UPDATE
    `, [bookingId]);
    const active = assignmentsResult.rows.filter(row => row.assignment_status === "assigned");
    const crewSize = booking.required_crew_size;
    if (![1, 2].includes(crewSize) || active.length !== crewSize) {
      throw new CrewPayoutError("Booking crew is not complete");
    }
    const leads = active.filter(row => row.crew_role === "lead");
    const seconds = active.filter(row => row.crew_role === "second");
    if (leads.length !== 1 || seconds.length !== crewSize - 1 ||
        new Set(active.map(row => row.cleaner_id)).size !== crewSize ||
        booking.cleaner_id !== leads[0].cleaner_id) {
      throw new CrewPayoutError("Booking crew assignments are inconsistent");
    }

    // One-time allocation: reject even if existing amounts match the new calculation.
    // Also reject partially allocated crews so we never overwrite financial records.
    // These assignment rows are locked FOR UPDATE within this transaction.
    if (active.some(row => row.payout_cents !== null)) {
      throw new CrewPayoutError("Payouts already allocated");
    }
    // Excluded historical assignments should never carry an active payout.
    if (assignmentsResult.rows.some(row => row.assignment_status === "removed" && row.payout_cents !== null)) {
      throw new CrewPayoutError("Removed assignment has a payout; review required");
    }

    const shares = calculateCrewShares(cleanerTotal.toString(), crewSize);
    const intended = new Map([[leads[0].id, shares.lead]]);
    if (crewSize === 2) intended.set(seconds[0].id, shares.second);

    for (const assignment of active) {
      // Defense in depth: no update may overwrite an existing payout.
      const updated = await client.query(`
        UPDATE public.booking_cleaners
        SET payout_cents = $2::bigint, updated_at = NOW()
        WHERE id = $1 AND assignment_status = 'assigned' AND payout_cents IS NULL
      `, [assignment.id, intended.get(assignment.id)]);
      if (updated.rowCount !== 1) {
        throw new CrewPayoutError("Payouts already allocated");
      }
    }
    await client.query("COMMIT");
    inTransaction = false;
    return {
      status: "allocated",
      booking_id: bookingId,
      cleaner_total_cents: cleanerTotal.toString(),
      crew_size: crewSize,
      payouts: active.map(a => ({
        cleaner_id: a.cleaner_id,
        crew_role: a.crew_role,
        payout_cents: intended.get(a.id)
      })),
      note: "Accounting allocation only. No funds transferred or payment confirmed."
    };
  } catch (error) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Payout allocation rollback failed:", rollbackError); }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { calculateCrewShares, allocateCrewPayouts, CrewPayoutError };