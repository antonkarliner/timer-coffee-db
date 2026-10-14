-- Plan 043 Phase 6.2: retain recipe draft captures for 12 months.
-- Daily at 03:30 UTC; applies to new consented-user captures and all existing
-- operator/tester test rows. Account deletion can remove captures earlier.
-- Plain SQL run as the pg_cron job owner: no new function or EXECUTE grants.
-- Unschedule an existing job before scheduling so this migration is re-runnable.

do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'delete-old-recipe-draft-captures'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'delete-old-recipe-draft-captures',
        '30 3 * * *',
        $job$delete from service.parse_user_recipe_draft_captures where captured_at < now() - interval '12 months'$job$
    );
end;
$cron$
language plpgsql;
