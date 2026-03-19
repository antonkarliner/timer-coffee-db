-- Fix roaster enrichment worker cron schedule to use correct pg_cron seconds syntax
-- The previous migration used '*/30 * * * * *' (6-field format) which pg_cron doesn't support.
-- pg_cron only supports:
--   1. Standard 5-field cron syntax: * * * * * (minute-level)
--   2. Seconds syntax (pg_cron 1.5+): '30 seconds' (NOT 6-field format)
-- When given 6 fields, pg_cron ignores the 6th field and interprets '*/30 * * * * *' as '*/30 * * * *' (every 30 minutes).

-- First, unschedule the existing job with the incorrect schedule
DO $unschedule$
DECLARE
    v_job_id INTEGER;
BEGIN
    SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'roaster-enrichment-worker';
    IF v_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(v_job_id);
        RAISE NOTICE 'Unscheduled roaster-enrichment-worker job with incorrect schedule';
    END IF;
END;
$unschedule$ LANGUAGE plpgsql;

-- Schedule the job correctly using pg_cron's seconds syntax
-- Format: '30 seconds' means run every 30 seconds
DO $cron$
DECLARE
    v_job_id INTEGER;
BEGIN
    SELECT cron.schedule(
        'roaster-enrichment-worker',
        '30 seconds',  -- Run every 30 seconds (pg_cron 1.5+ syntax)
        'SELECT public.roaster_enrichment_worker_cron();'
    ) INTO v_job_id;
    
    RAISE NOTICE 'Scheduled roaster-enrichment-worker cron job (every 30 seconds) with ID: %', v_job_id;
END;
$cron$ LANGUAGE plpgsql;

-- Log the fix
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'roaster_enrichment_cron_seconds_fix',
    1,
    jsonb_build_object(
        'description', 'Fixed cron schedule to use correct pg_cron seconds syntax',
        'old_schedule', '*/30 * * * * *',
        'new_schedule', '30 seconds',
        'reason', 'pg_cron does not support 6-field cron syntax; use ''N seconds'' format instead',
        'executed_at', timezone('utc', now())
    )
);
