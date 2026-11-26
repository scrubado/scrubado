-- 007-southern-ma-service-area.sql
-- Scrubado: permit Massachusetts quotes while preserving
-- historical Rhode Island quotes.
-- Applied manually to Neon before repository commit.

BEGIN;

ALTER TABLE public.quotes
DROP CONSTRAINT IF EXISTS quotes_state_check;

ALTER TABLE public.quotes
ADD CONSTRAINT quotes_state_check
CHECK (state IN ('RI', 'MA'));

COMMIT;
