-- Update roaster enrichment worker to run every 30 seconds
-- Since pg_cron uses standard cron syntax (minute granularity), we create two jobs:
-- - Job 1: Runs every minute at :00 seconds
-- - Job 2: Runs every minute at :30 seconds (achieved via a sleep wrapper)

-- First, unschedule the existing cron jobs (safely handle non-existent jobs)
DO $unschedule$
DECLARE
    v_job_id INTEGER;
BEGIN
    -- Unschedule main job if exists
    SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'roaster-enrichment-worker';
    IF v_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(v_job_id);
        RAISE NOTICE 'Unscheduled existing roaster-enrichment-worker job';
    END IF;
    
    -- Unschedule offset job if exists
    SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'roaster-enrichment-worker-offset';
    IF v_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(v_job_id);
        RAISE NOTICE 'Unscheduled existing roaster-enrichment-worker-offset job';
    END IF;
END;
$unschedule$ LANGUAGE plpgsql;

-- Create a wrapper function for the offset job that sleeps 30 seconds before executing
CREATE OR REPLACE FUNCTION public.roaster_enrichment_worker_cron_offset()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    -- Sleep for 30 seconds to offset this execution
    PERFORM pg_sleep(30);
    -- Then call the main cron function
    PERFORM public.roaster_enrichment_worker_cron();
END;
$function$;

COMMENT ON FUNCTION public.roaster_enrichment_worker_cron_offset() IS
  'Wrapper that delays 30 seconds then invokes roaster-enrichment-worker for 30-second scheduling.';

-- Schedule the main job (runs every minute at :00)
DO $cron1$
DECLARE
    v_job_id INTEGER;
BEGIN
    SELECT cron.schedule(
        'roaster-enrichment-worker',
        '* * * * *',  -- Every minute at :00
        'SELECT public.roaster_enrichment_worker_cron();'
    ) INTO v_job_id;
    
    RAISE NOTICE 'Scheduled roaster-enrichment-worker cron job (every minute at :00) with ID: %', v_job_id;
END;
$cron1$ LANGUAGE plpgsql;

-- Schedule the offset job (runs every minute at :30)
DO $cron2$
DECLARE
    v_job_id INTEGER;
BEGIN
    SELECT cron.schedule(
        'roaster-enrichment-worker-offset',
        '* * * * *',  -- Every minute at :00, but function adds 30s delay
        'SELECT public.roaster_enrichment_worker_cron_offset();'
    ) INTO v_job_id;
    
    RAISE NOTICE 'Scheduled roaster-enrichment-worker-offset cron job (every minute at :30) with ID: %', v_job_id;
END;
$cron2$ LANGUAGE plpgsql;

-- Log the change
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'roaster_enrichment_cron_30s',
    2,
    jsonb_build_object(
        'description', 'Updated roaster enrichment worker to run every 30 seconds using two offset cron jobs',
        'job_1', 'roaster-enrichment-worker (every minute at :00)',
        'job_2', 'roaster-enrichment-worker-offset (every minute at :30, via pg_sleep)',
        'executed_at', timezone('utc', now())
    )
);
