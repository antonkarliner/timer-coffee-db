-- Plan 079 Phase 3 / plan 080 D4: the AI-review diagnostics are deleted no
-- later than 2027-04-09.
--
-- "Verify recipe with AI" was retired on 2026-10-09 (plan 079; the function is
-- an echo stub since 5185c38, deployed as version 33), so no new rows arrive:
-- 707 diagnostics rows, the last from 2026-10-09 01:13 UTC. Plan 080 uses them
-- as a converter test bed and may delete them earlier by hand (its Phase 5);
-- this job is the backstop for the agreed date.
--
-- The job fires at 03:00 UTC on 9 April each year. The date guard makes any
-- run before 2027-04-09 a no-op, and a repeat run is a no-op once the table is
-- empty, so the job is idempotent. It deletes diagnostics rows only;
-- service.user_recipe_verification_invocations is kept for the stub's traffic
-- count (079 D4) and dropped with the stub.
--
-- The command is plain SQL run by pg_cron as the job owner, so no new function
-- (and no EXECUTE grant) is involved. Plan 079 Phase 4 drops the diagnostics
-- table; unschedule 'delete-verification-diagnostics' in that same migration,
-- or the job will fail every 9 April afterwards.

do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'delete-verification-diagnostics'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'delete-verification-diagnostics',
        '0 3 9 4 *',
        $job$delete from service.user_recipe_verification_diagnostics where now() >= timestamptz '2027-04-09 00:00:00+00'$job$
    );
end;
$cron$
language plpgsql;
