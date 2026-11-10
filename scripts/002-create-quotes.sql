-- Scrubado MVP: persistent price quotes
-- Run once in the Neon SQL Editor after reviewing.
-- This migration adds a new table; it does not modify existing tables.
BEGIN;

CREATE TABLE public.quotes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
    service_code varchar(32) NOT NULL,
    pricing_version varchar(32) NOT NULL DEFAULT '1.0',
    currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    state char(2) NOT NULL CHECK (state = 'RI'),
    postal_code varchar(10) NOT NULL CHECK (postal_code ~ '^[0-9]{5}$' AND postal_code <> '02807'),
    square_feet integer NOT NULL CHECK (square_feet BETWEEN 1 AND 4000),
    full_baths integer NOT NULL CHECK (full_baths >= 1),
    half_baths integer NOT NULL DEFAULT 0 CHECK (half_baths >= 0),
    frequency varchar(16) NOT NULL CHECK (frequency IN ('once', 'weekly', 'biweekly', 'monthly')),
    addon_selections jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(addon_selections) = 'array'),
    drive_surcharge_applied boolean NOT NULL DEFAULT false,
    pricing_breakdown jsonb NOT NULL CHECK (jsonb_typeof(pricing_breakdown) = 'object'),
    customer_total_cents bigint NOT NULL CHECK (customer_total_cents >= 0),
    cleaner_total_cents bigint NOT NULL CHECK (cleaner_total_cents >= 0),
    status varchar(16) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'used', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
    used_at timestamptz NULL,
    CONSTRAINT quotes_expiry_after_creation CHECK (expires_at > created_at),
    CONSTRAINT quotes_used_timestamp_consistency CHECK (
      (status = 'used' AND used_at IS NOT NULL)
      OR (status <> 'used' AND used_at IS NULL)
    )
);

CREATE INDEX quotes_customer_created_idx
    ON public.quotes (customer_id, created_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE INDEX quotes_active_expiry_idx
    ON public.quotes (expires_at)
    WHERE status = 'active';

COMMENT ON TABLE public.quotes IS
  'Server-calculated price snapshots. Expired means status=active and expires_at <= now(); no automatic status change is required.';

COMMIT;