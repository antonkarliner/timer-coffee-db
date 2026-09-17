-- A hold is a fixed 30-day pause, followed by one fresh enrichment pass.
alter table service.roaster_candidate_clusters
  add column hold_until timestamptz,
  add column hold_reason text,
  add column hold_notes text,
  add constraint roaster_cluster_hold_reason_check check (
    hold_reason is null or hold_reason in (
      'wrong_entity', 'ambiguous_identity', 'logo_missing',
      'location_mismatch', 'contaminated_data', 'stale_data', 'other'
    )
  ),
  add constraint roaster_cluster_hold_metadata_check check (
    status <> 'held' or (
      hold_until is not null and hold_reason is not null
      and hold_notes is not null and length(btrim(hold_notes)) > 0
    )
  );

create index roaster_clusters_due_hold_idx
  on service.roaster_candidate_clusters (hold_until) where status = 'held';

-- Serialize every enqueue/claim with the cluster lock, including older callers
-- which still insert jobs directly. A contribution may be saved during a hold,
-- but it must not start enrichment or shorten the pause.
create function service.guard_roaster_enrichment_hold()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  if new.state not in ('queued', 'running') then return new; end if;
  select status into v_status from service.roaster_candidate_clusters
    where id = new.cluster_id for update;
  if v_status = 'held' then
    if new.state = 'running' then
      raise exception 'Cluster is on hold' using errcode = '55000';
    end if;
    return null;
  end if;
  return new;
end;
$$;
create trigger guard_roaster_enrichment_hold
  before insert or update of state, cluster_id on service.roaster_enrichment_jobs
  for each row execute function service.guard_roaster_enrichment_hold();

-- This also protects direct admin status updates, not just the RPC below.
create function service.guard_roaster_cluster_hold()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'held' and old.status <> 'held' then
    if old.status <> 'pending' then
      raise exception 'Only pending clusters can be held' using errcode = '55000';
    end if;
    if exists (select 1 from service.roaster_enrichment_jobs
      where cluster_id = new.id and state = 'running') then
      raise exception 'Enrichment is running; retry the hold after it finishes'
        using errcode = '55000';
    end if;
    -- Stop incomplete queued stages; expiry always starts fresh at triage.
    update service.roaster_enrichment_jobs
      set state = 'failed', locked_at = null, locked_by = null,
          last_error = 'Cancelled by reviewer hold; a fresh pass will run at expiry'
      where cluster_id = new.id and state = 'queued';
  end if;
  return new;
end;
$$;
create trigger guard_roaster_cluster_hold
  before update of status on service.roaster_candidate_clusters
  for each row execute function service.guard_roaster_cluster_hold();

create function service.hold_roaster_candidate_cluster(
  p_cluster_id uuid, p_reason text, p_notes text
)
returns service.roaster_candidate_clusters
language plpgsql security definer set search_path = '' as $$
declare v_cluster service.roaster_candidate_clusters;
begin
  if not (coalesce(auth.role() = 'service_role', false)
    or coalesce(public.is_admin(), false) or session_user = 'postgres') then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in (
    'wrong_entity', 'ambiguous_identity', 'logo_missing', 'location_mismatch',
    'contaminated_data', 'stale_data', 'other'
  ) or p_notes is null or length(btrim(p_notes)) = 0 or length(p_notes) > 400 then
    raise exception 'A valid reason and notes (1-400 characters) are required'
      using errcode = '22023';
  end if;
  select * into v_cluster from service.roaster_candidate_clusters
    where id = p_cluster_id for update;
  if not found then raise exception 'Cluster not found' using errcode = 'P0002'; end if;
  -- Retried requests do not extend a hold or silently change its context.
  if v_cluster.status = 'held' then return v_cluster; end if;
  update service.roaster_candidate_clusters
    set status = 'held', hold_until = now() + interval '30 days',
        hold_reason = p_reason, hold_notes = btrim(p_notes), updated_at = now()
    where id = p_cluster_id returning * into v_cluster;
  return v_cluster;
end;
$$;

-- The common enqueue primitive deduplicates under the same cluster lock used
-- for holds and claims. A held/closed cluster returns NULL without queueing.
create function service.enqueue_roaster_enrichment(
  p_cluster_id uuid, p_reason text default null, p_notes text default null,
  p_prior_result_id uuid default null
)
returns bigint language plpgsql set search_path = '' as $$
declare v_status text; v_job_id bigint;
begin
  select status into v_status from service.roaster_candidate_clusters
    where id = p_cluster_id for update;
  if not found then raise exception 'Cluster not found' using errcode = 'P0002'; end if;
  if v_status <> 'pending' then return null; end if;
  select id into v_job_id from service.roaster_enrichment_jobs
    where cluster_id = p_cluster_id and state in ('queued', 'running')
    order by id limit 1;
  if found then return v_job_id; end if;
  insert into service.roaster_enrichment_jobs (
    cluster_id, state, stage, run_after, rejection_reason, reviewer_notes, prior_result_id
  ) values (p_cluster_id, 'queued', 'triage', now(), p_reason, p_notes, p_prior_result_id)
  returning id into v_job_id;
  return v_job_id;
end;
$$;

-- Explicit admin re-enrichment may end a hold early. Automatic enqueues never do.
create function service.re_enrich_roaster_candidate_cluster(
  p_cluster_id uuid, p_reason text default null, p_notes text default null
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_cluster service.roaster_candidate_clusters; v_prior uuid;
begin
  if not (coalesce(auth.role() = 'service_role', false)
    or coalesce(public.is_admin(), false) or session_user = 'postgres') then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  select * into v_cluster from service.roaster_candidate_clusters
    where id = p_cluster_id for update;
  if not found then raise exception 'Cluster not found' using errcode = 'P0002'; end if;
  if v_cluster.status not in ('pending', 'held') then
    raise exception 'Only pending or held clusters can be re-enriched' using errcode = '55000';
  end if;
  if exists (select 1 from service.roaster_enrichment_jobs
    where cluster_id = p_cluster_id and state in ('queued', 'running')) then
    raise exception 'Active job already exists' using errcode = '55000';
  end if;
  select id into v_prior from service.roaster_enrichment_results
    where cluster_id = p_cluster_id order by updated_at desc, id limit 1;
  update service.roaster_candidate_clusters set status = 'pending', updated_at = now()
    where id = p_cluster_id;
  return service.enqueue_roaster_enrichment(p_cluster_id,
    coalesce(p_reason, case when v_cluster.status = 'held' then v_cluster.hold_reason end),
    coalesce(p_notes, case when v_cluster.status = 'held' then v_cluster.hold_notes end), v_prior);
end;
$$;

create function service.release_due_roaster_holds(p_limit integer default 100)
returns integer language plpgsql set search_path = '' as $$
declare v_cluster service.roaster_candidate_clusters; v_prior uuid; v_count integer := 0;
begin
  if p_limit < 1 or p_limit > 1000 or p_limit is null then
    raise exception 'Limit must be 1-1000' using errcode = '22023';
  end if;
  for v_cluster in select * from service.roaster_candidate_clusters
    where status = 'held' and hold_until <= now()
    order by hold_until, id limit p_limit for update skip locked
  loop
    select id into v_prior from service.roaster_enrichment_results
      where cluster_id = v_cluster.id order by updated_at desc, id limit 1;
    update service.roaster_candidate_clusters set status = 'pending', updated_at = now()
      where id = v_cluster.id;
    perform service.enqueue_roaster_enrichment(
      v_cluster.id, v_cluster.hold_reason, v_cluster.hold_notes, v_prior
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Lock cluster before job throughout this workflow. SKIP LOCKED allows another
-- invocation to move to the next eligible cluster without racing a hold.
create function service.claim_roaster_enrichment_job(p_locked_by text)
returns setof service.roaster_enrichment_jobs
language plpgsql set search_path = '' as $$
declare v_cluster_id uuid; v_job_id bigint;
begin
  select c.id into v_cluster_id from service.roaster_candidate_clusters c
    where c.status = 'pending' and exists (
      select 1 from service.roaster_enrichment_jobs j
      where j.cluster_id = c.id and j.state = 'queued' and j.run_after <= now()
    ) and not exists (
      select 1 from service.roaster_enrichment_jobs j
      where j.cluster_id = c.id and j.state = 'running'
    )
    order by (select min(j.id) from service.roaster_enrichment_jobs j
      where j.cluster_id = c.id and j.state = 'queued' and j.run_after <= now())
    limit 1 for update of c skip locked;
  if not found then return; end if;
  select id into v_job_id from service.roaster_enrichment_jobs
    where cluster_id = v_cluster_id and state = 'queued' and run_after <= now()
    order by id limit 1 for update skip locked;
  if not found then return; end if;
  return query update service.roaster_enrichment_jobs
    set state = 'running', locked_at = now(), locked_by = p_locked_by
    where id = v_job_id returning *;
end;
$$;

-- Existing raw candidates still accumulate during holds; only pending clusters
-- may enqueue, so new scans also cannot reopen approved or rejected clusters.
create or replace function service.assign_roaster_candidate_cluster()
returns trigger language plpgsql
set search_path = service, public, extensions, pg_catalog as $$
declare
  v_name text; v_cluster service.roaster_candidate_clusters; v_last timestamptz;
begin
  v_name := service.normalize_roaster_name(new.roaster);
  insert into service.roaster_candidate_clusters (
    normalized_name, display_name, sample_names, candidate_count, occurrences, updated_at
  ) values (v_name, new.roaster, jsonb_build_array(new.roaster), 1, 1, now())
  on conflict (normalized_name) do update set
    display_name = excluded.display_name,
    sample_names = coalesce(service.roaster_candidate_clusters.sample_names, '[]'::jsonb) || excluded.sample_names,
    candidate_count = coalesce(service.roaster_candidate_clusters.candidate_count, 0) + 1,
    occurrences = coalesce(service.roaster_candidate_clusters.occurrences, 0) + 1,
    updated_at = now()
  returning * into v_cluster;
  new.cluster_id := v_cluster.id;
  if v_cluster.status = 'pending' then
    select max(updated_at) into v_last from service.roaster_enrichment_results
      where cluster_id = v_cluster.id;
    if v_cluster.created_at = v_cluster.updated_at or v_last is null
      or v_last < now() - interval '7 days' then
      perform service.enqueue_roaster_enrichment(v_cluster.id);
    end if;
  end if;
  return new;
end;
$$;

-- Default EXECUTE grants include named roles in this project: revoke all three.
revoke execute on function service.guard_roaster_enrichment_hold() from public, anon, authenticated;
revoke execute on function service.guard_roaster_cluster_hold() from public, anon, authenticated;
revoke execute on function service.hold_roaster_candidate_cluster(uuid, text, text) from public, anon;
revoke execute on function service.re_enrich_roaster_candidate_cluster(uuid, text, text) from public, anon;
revoke execute on function service.enqueue_roaster_enrichment(uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function service.release_due_roaster_holds(integer) from public, anon, authenticated;
revoke execute on function service.claim_roaster_enrichment_job(text) from public, anon, authenticated;
grant execute on function service.hold_roaster_candidate_cluster(uuid, text, text) to authenticated, service_role;
grant execute on function service.re_enrich_roaster_candidate_cluster(uuid, text, text) to authenticated, service_role;
grant execute on function service.guard_roaster_enrichment_hold(), service.guard_roaster_cluster_hold(),
  service.enqueue_roaster_enrichment(uuid, text, text, uuid),
  service.release_due_roaster_holds(integer), service.claim_roaster_enrichment_job(text) to service_role;

select cron.schedule('release-roaster-candidate-holds', '*/5 * * * *',
  'select service.release_due_roaster_holds(100);');
