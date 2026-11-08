-- Scrubado migration 003: link bookings to persisted quotes.
-- Run once in the intended Neon database, after migration 002.
-- Existing bookings.quoted_price remains unchanged for compatibility.
-- New fields are nullable during rollout; the booking API must always populate both.

BEGIN;

ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS quote_id uuid,
    ADD COLUMN IF NOT EXISTS quoted_price_cents bigint;

-- One booking per quote. PostgreSQL UNIQUE permits multiple NULL values,
-- so pre-existing or non-quote bookings remain possible during rollout.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_quote_id_unique_idx
    ON public.bookings (quote_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.bookings'::regclass
          AND conname = 'bookings_quote_id_fkey'
    ) THEN
        ALTER TABLE public.bookings
            ADD CONSTRAINT bookings_quote_id_fkey
            FOREIGN KEY (quote_id) REFERENCES public.quotes(id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.bookings'::regclass
          AND conname = 'bookings_quoted_price_cents_nonnegative'
    ) THEN
        ALTER TABLE public.bookings
            ADD CONSTRAINT bookings_quoted_price_cents_nonnegative
            CHECK (quoted_price_cents IS NULL OR quoted_price_cents >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.bookings'::regclass
          AND conname = 'bookings_quote_price_paired'
    ) THEN
        ALTER TABLE public.bookings
            ADD CONSTRAINT bookings_quote_price_paired
            CHECK ((quote_id IS NULL) = (quoted_price_cents IS NULL));
    END IF;
END
$$;

COMMENT ON COLUMN public.bookings.quote_id IS
    'Persisted quote consumed to create this booking; unique per booking.';
COMMENT ON COLUMN public.bookings.quoted_price_cents IS
    'Customer total from the locked, unexpired quote, stored as integer USD cents.';

COMMIT;

-- Optional read-only verification (run separately):
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'bookings'
--   AND column_name IN ('quote_id', 'quoted_price_cents');