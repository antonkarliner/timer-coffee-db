-- Migration: fire roaster-logo-mirror when a roaster's logo URL is changed.
--
-- Previously the trigger only fired on INSERT, so updating an existing
-- roaster's logo URL left the mirror and its pre-baked size variants stale.
-- This trigger fires on UPDATE whenever roaster_logo_url changes to a
-- non-null value, re-running the full mirror + variant generation pipeline.
--
-- The http_request call uses pg_net (fire-and-forget async). The 5000 ms
-- value is a connection timeout, not an execution limit — the edge function
-- continues running to completion regardless.

CREATE OR REPLACE TRIGGER process_updated_coffee_roaster_logo
  AFTER UPDATE ON public.coffee_roasters
  FOR EACH ROW
  WHEN (
    OLD.roaster_logo_url IS DISTINCT FROM NEW.roaster_logo_url
    AND NEW.roaster_logo_url IS NOT NULL
  )
  EXECUTE FUNCTION supabase_functions.http_request(
    'https://mprokbemdullwezwwscn.supabase.co/functions/v1/roaster-logo-mirror',
    'POST',
    '{"Content-type":"application/json"}',
    '{}',
    '5000'
  );
