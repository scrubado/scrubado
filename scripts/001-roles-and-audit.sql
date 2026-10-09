
-- SCRUBADO
-- Migration 001: User Roles and Audit Logging
--
-- Existing user records are preserved.
-- Existing lowercase roles are converted to uppercase.
-- Administrative audit records are append-only.

-- 1. Expand supported roles.

ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_role_check;

UPDATE users
SET role = UPPER(role)
WHERE role <> UPPER(role);

ALTER TABLE users
ADD CONSTRAINT users_role_check
CHECK (
    role IN (
        'CUSTOMER',
        'CLEANER',
        'ADMIN',
        'SUPPORT',
        'SUPER_ADMIN'
    )
);

-- 2. Create administrative audit log.

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    actor_user_id UUID REFERENCES users(id)
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

-- 3. Audit log lookup indexes.

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
ON audit_logs(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
ON audit_logs(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
ON audit_logs(created_at DESC);

-- 4. Prevent existing audit records from being
-- updated or deleted through normal SQL operations.

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Scrubado audit logs are append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_immutable
ON audit_logs;

CREATE TRIGGER audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_mutation();