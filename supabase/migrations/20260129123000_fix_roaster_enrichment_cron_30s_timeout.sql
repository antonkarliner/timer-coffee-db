-- Fix the 30-second cron schedule to avoid pg_net timeout issues
-- The previous implementation used pg_sleep(30) which caused pg_net.http_post to timeout
-- Instead, we use a simpler approach with a timestamp check in the main function

-- First, unschedule the offset job (it causes timeouts)
DO $unschedule$
DECLARE
    v_job_id INTEGER;
BEGIN
    SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'roaster-enrichment-worker-offset';
    IF v_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(v_job_id);
        RAISE NOTICE 'Unscheduled roaster-enrichment-worker-offset job';
    END IF;
END;
$unschedule$ LANGUAGE plpgsql;

-- Drop the offset wrapper function
DROP FUNCTION IF EXISTS public.roaster_enrichment_worker_cron_offset();

-- Create a modified main function that runs twice per minute using an internal offset mechanism
-- We'll use a simpler approach: schedule the job every 30 seconds using pg_cron's second-level syntax
-- pg_cron supports seconds in the schedule when using 6 fields: seconds minutes hours day month day_of_week

-- Unschedule the main job
DO $unschedule_main$
DECLARE
    v_job_id INTEGER;
BEGIN
    SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'roaster-enrichment-worker';
    IF v_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(v_job_id);
        RAISE NOTICE 'Unscheduled roaster-enrichment-worker job';
    END IF;
END;
$unschedule_main$ LANGUAGE plpgsql;

-- Schedule with 6-field cron syntax: every 30 seconds
-- Format: seconds minutes hours day month day_of_week
DO $cron$
DECLARE
    v_job_id INTEGER;
BEGIN
    SELECT cron.schedule(
        'roaster-enrichment-worker',
        '*/30 * * * * *',  -- Every 30 seconds (6-field format)
        'SELECT public.roaster_enrichment_worker_cron();'
    ) INTO v_job_id;
    
    RAISE NOTICE 'Scheduled roaster-enrichment-worker cron job (every 30 seconds) with ID: %', v_job_id;
END;
$cron$ LANGUAGE plpgsql;

-- Log the fix
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'roaster_enrichment_cron_30s_fix',
    1,
    jsonb_build_object(
        'description', 'Fixed 30-second cron schedule using 6-field pg_cron syntax instead of pg_sleep wrapper',
        'schedule', '*/30 * * * * *',
        'executed_at', timezone('utc', now())
    )
);
