-- Fix roaster enrichment worker cron job
-- The previous update (20260128000001_update_roaster_enrichment_cron_frequency.sql) changed to using
-- current_setting('app.settings.supabase_url') which doesn't work because app.settings.* configuration
-- parameters don't exist in the database.
-- This migration restores the function-based approach with the every-minute schedule.

-- First, unschedule the broken cron job
SELECT cron.unschedule('roaster-enrichment-worker');

-- Schedule using the existing function that properly reads from vault
DO $cron$
DECLARE
    v_job_id INTEGER;
BEGIN
    -- Schedule the roaster enrichment worker cron job to run every minute
    SELECT cron.schedule(
        'roaster-enrichment-worker',
        '* * * * *',  -- Every minute (for multi-stage pipeline processing)
        'SELECT public.roaster_enrichment_worker_cron();'
    ) INTO v_job_id;
    
    RAISE NOTICE 'Scheduled roaster-enrichment-worker cron job (every minute) with ID: %', v_job_id;
END;
$cron$ LANGUAGE plpgsql;

-- Log the fix
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'roaster_enrichment_cron_fix',
    1,
    jsonb_build_object(
        'fix_description', 'Restored function-based cron job using vault secrets instead of current_setting()',
        'schedule', '* * * * *',
        'executed_at', timezone('utc', now())
    )
);
