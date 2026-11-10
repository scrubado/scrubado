-- =====================================================
-- SCRUBADO
-- Migration 005: Restore Audit Logging
-- =====================================================
--
-- Purpose:
-- Restore the administrative audit logging system.
--
-- IMPORTANT:
-- Does NOT modify users or their role constraints.
-- Preserves all existing records.
-- Audit logs are append-only.
-- =====================================================

BEGIN;

-- 1. Create audit_logs table if it does not exist.

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    actor_user_id UUID
        REFERENCES public.users(id)
        ON DELETE RESTRICT,

    action VARCHAR(120) NOT NULL,
    entity_type VARCHAR(120) NOT NULL,
    entity_id UUID,

    old_values JSONB,
    new_values JSONB,

    ip_address INET,
    user_agent TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Create lookup indexes.

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
ON public.audit_logs(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
ON public.audit_logs(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
ON public.audit_logs(created_at DESC);

-- 3. Create append-only protection function.

CREATE OR REPLACE FUNCTION
public.prevent_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Scrubado audit logs are append-only';
END;
$$;

-- 4. Install protection trigger.

DROP TRIGGER IF EXISTS audit_logs_immutable
ON public.audit_logs;

CREATE TRIGGER audit_logs_immutable
BEFORE UPDATE OR DELETE
ON public.audit_logs
FOR EACH ROW
EXECUTE FUNCTION public.prevent_audit_log_mutation();

COMMIT;