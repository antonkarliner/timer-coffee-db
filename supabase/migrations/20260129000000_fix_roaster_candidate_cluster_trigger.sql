-- Fix ambiguous column error in assign_roaster_candidate_cluster trigger
-- The variable name "normalized_name" conflicts with the table column

CREATE OR REPLACE FUNCTION service.assign_roaster_candidate_cluster()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
declare
  v_normalized_name text;
  cluster_uuid uuid;
  cluster_created_at timestamptz;
  cluster_updated_at timestamptz;
  last_enrichment_at timestamptz;
  is_new_cluster boolean;
  is_stale boolean;
  has_active_job boolean;
begin
  v_normalized_name := service.normalize_roaster_name(NEW.roaster);

  insert into service.roaster_candidate_clusters (
    normalized_name,
    display_name,
    sample_names,
    candidate_count,
    occurrences,
    updated_at
  )
  values (
    v_normalized_name,
    NEW.roaster,
    jsonb_build_array(NEW.roaster),
    1,
    1,
    now()
  )
  on conflict (normalized_name)
  do update set
    display_name = excluded.display_name,
    sample_names = coalesce(service.roaster_candidate_clusters.sample_names, '[]'::jsonb) || excluded.sample_names,
    candidate_count = coalesce(service.roaster_candidate_clusters.candidate_count, 0) + 1,
    occurrences = coalesce(service.roaster_candidate_clusters.occurrences, 0) + 1,
    updated_at = now()
  returning id, created_at, updated_at
  into cluster_uuid, cluster_created_at, cluster_updated_at;

  NEW.cluster_id := cluster_uuid;

  select max(updated_at)
    into last_enrichment_at
    from service.roaster_enrichment_results
    where cluster_id = cluster_uuid;

  is_new_cluster := cluster_created_at = cluster_updated_at;
  is_stale := last_enrichment_at is null
    or last_enrichment_at < now() - interval '7 days'; -- treat results older than 7 days as stale

  select exists (
    select 1
    from service.roaster_enrichment_jobs
    where cluster_id = cluster_uuid
      and state in ('queued', 'running')
  )
  into has_active_job;

  if (is_new_cluster or is_stale) and not has_active_job then
    insert into service.roaster_enrichment_jobs (
      cluster_id,
      state,
      run_after
    )
    values (
      cluster_uuid,
      'queued',
      now()
    );
  end if;

  return NEW;
end;
$$;

-- Drop and recreate the trigger to ensure it uses the updated function
drop trigger if exists assign_roaster_candidate_cluster_trigger on service.new_roaster_candidates;

create trigger assign_roaster_candidate_cluster_trigger
  before insert on service.new_roaster_candidates
  for each row
  execute function service.assign_roaster_candidate_cluster();
