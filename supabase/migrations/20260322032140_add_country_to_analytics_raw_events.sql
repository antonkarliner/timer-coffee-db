-- Add country field to raw_events for geo-segmented analytics
alter table "analytics"."raw_events" add column "country" text;

-- Update insert_analytics_events to capture country from incoming events
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
  INSERT INTO analytics.raw_events (event_name, category, session_id, install_id, platform, app_version, properties, client_ts, country)
  SELECT
    e->>'event_name',
    e->>'category',
    (e->>'session_id')::uuid,
    e->>'install_id',
    e->>'platform',
    e->>'app_version',
    COALESCE(e->'properties', '{}'::jsonb),
    (e->>'client_ts')::timestamptz,
    NULLIF(e->>'country', '')
  FROM jsonb_array_elements(events) AS e;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  RETURN jsonb_build_object('inserted', inserted_count);
END;
$function$;

-- Add country index on partition parent (inherited by all partitions)
CREATE INDEX idx_raw_events_country ON ONLY analytics.raw_events USING btree (country, server_ts);
