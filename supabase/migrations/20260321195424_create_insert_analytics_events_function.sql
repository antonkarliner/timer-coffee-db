-- Security-definer function called by the ingest-analytics edge function.
-- Accepts a JSON array of events and bulk-inserts them into analytics.raw_events.
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.insert_analytics_events(events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO analytics.raw_events (event_name, category, session_id, install_id, platform, app_version, properties, client_ts)
  SELECT
    e->>'event_name',
    e->>'category',
    (e->>'session_id')::uuid,
    e->>'install_id',
    e->>'platform',
    e->>'app_version',
    COALESCE(e->'properties', '{}'::jsonb),
    (e->>'client_ts')::timestamptz
  FROM jsonb_array_elements(events) AS e;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  RETURN jsonb_build_object('inserted', inserted_count);
END;
$function$;
