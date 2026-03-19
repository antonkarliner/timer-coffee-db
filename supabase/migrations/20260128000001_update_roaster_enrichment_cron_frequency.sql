-- Update cron schedule to run every minute for multi-stage pipeline processing
-- With 5 stages (triage → evidence → summary → extract → validate), 
-- we need more frequent invocations to progress jobs through the pipeline

-- First, unschedule the existing cron job (if it exists with the old schedule)
SELECT cron.unschedule('roaster-enrichment-worker');

-- Schedule the new cron job to run every minute
-- This allows jobs to progress through pipeline stages faster
SELECT cron.schedule(
  'roaster-enrichment-worker',
  '* * * * *', -- Every minute (was every 5 minutes)
  $$SELECT net.http_post(
    url:=current_setting('app.settings.supabase_url') || '/functions/v1/roaster-enrichment-worker',
    headers:=jsonb_build_object(
      'Content-Type', 'application/json',
      'x-system-token', current_setting('app.settings.cron_job_secret')
    ),
    body:='{}'::jsonb
  ) AS request_id;$$
);
