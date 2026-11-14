-- Scrubado migration 006: full-refund ledger (development milestone)
-- Requires public.users and public.payments to exist.
-- Safe to apply where the table was already created manually in Neon.
-- IMPORTANT: IF NOT EXISTS does not validate an existing table's schema.
-- Compare existing constraints before relying on this migration in a new environment.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payment_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES public.payments(id),
    requested_by UUID NOT NULL REFERENCES public.users(id),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
    stripe_refund_id TEXT UNIQUE,
    idempotency_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
    reason TEXT NOT NULL DEFAULT 'customer_cancellation',
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT payment_refunds_one_full_refund UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS payment_refunds_status_idx
    ON public.payment_refunds(status);

COMMIT;