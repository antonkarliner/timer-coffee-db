-- Function to automatically manage monthly partitions for analytics.raw_events.
-- Creates next month's partition (2 months ahead) and drops partitions older than 90 days.
CREATE OR REPLACE FUNCTION analytics.maintain_partitions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  next_month_start date := date_trunc('month', now() + interval '2 months')::date;
  next_month_end   date := (date_trunc('month', now() + interval '2 months') + interval '1 month')::date;
  partition_suffix text := 'y' || to_char(next_month_start, 'YYYY') || 'm' || to_char(next_month_start, 'MM');
  old_month        date := date_trunc('month', now() - interval '3 months')::date;
  old_suffix       text := 'y' || to_char(old_month, 'YYYY') || 'm' || to_char(old_month, 'MM');
BEGIN
  -- Create next month's partition if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'analytics'
    AND tablename = 'raw_events_' || partition_suffix
  ) THEN
    EXECUTE format(
      'CREATE TABLE analytics.raw_events_%s PARTITION OF analytics.raw_events FOR VALUES FROM (%L) TO (%L)',
      partition_suffix, next_month_start, next_month_end
    );
  END IF;

  -- Drop partitions older than 90 days
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'analytics'
    AND tablename = 'raw_events_' || old_suffix
  ) THEN
    EXECUTE format('DROP TABLE analytics.raw_events_%s', old_suffix);
  END IF;
END
$function$;

-- Schedule monthly partition maintenance on the 1st of each month at midnight UTC
SELECT cron.schedule(
  'analytics-partition-maintenance',
  '0 0 1 * *',
  'SELECT analytics.maintain_partitions()'
);
