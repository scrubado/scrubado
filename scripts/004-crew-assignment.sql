-- Scrubado migration 004: Crew assignment
-- Run once against the intended Neon database, after migration 003.
-- Existing bookings default to a one-cleaner crew; existing columns and rows are preserved.
-- Payout split policy for two-person crews: lead 60%, second cleaner 40%.
-- The API must compute and validate the split and only confirm fully staffed bookings.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS required_crew_size smallint NOT NULL DEFAULT 1;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_required_crew_size_check
  CHECK (required_crew_size IN (1, 2));

CREATE TABLE public.booking_cleaners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  cleaner_id uuid NOT NULL REFERENCES public.cleaner_profiles(id) ON DELETE RESTRICT,
  crew_role varchar(16) NOT NULL CHECK (crew_role IN ('lead', 'second')),
  assignment_status varchar(16) NOT NULL DEFAULT 'assigned'
    CHECK (assignment_status IN ('assigned', 'removed')),
  payout_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_cleaners_valid_payout CHECK (payout_cents IS NULL OR payout_cents >= 0)
);

-- Only active assignments must be unique; removed assignments remain as history.
CREATE UNIQUE INDEX booking_cleaners_active_booking_cleaner_uidx
  ON public.booking_cleaners(booking_id, cleaner_id)
  WHERE assignment_status = 'assigned';

CREATE UNIQUE INDEX booking_cleaners_active_booking_role_uidx
  ON public.booking_cleaners(booking_id, crew_role)
  WHERE assignment_status = 'assigned';

CREATE INDEX booking_cleaners_cleaner_id_idx
  ON public.booking_cleaners(cleaner_id);

CREATE INDEX booking_cleaners_booking_id_idx
  ON public.booking_cleaners(booking_id);

COMMENT ON COLUMN public.bookings.required_crew_size IS
  'Required crew size (1 or 2), chosen by Scrubado scheduling rules.';
COMMENT ON TABLE public.booking_cleaners IS
  'Cleaner assignments per booking; lead accepts a job and Scrubado assigns the second cleaner when required.';
COMMENT ON COLUMN public.booking_cleaners.payout_cents IS
  'Per-cleaner share in integer cents; API calculates 60% lead / 40% second for two-cleaner jobs.';

COMMIT;