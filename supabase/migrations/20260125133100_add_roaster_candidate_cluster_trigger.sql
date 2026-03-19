-- Add roaster candidate clustering trigger and normalization helper

create unique index if not exists roaster_candidate_clusters_normalized_name_key
  on service.roaster_candidate_clusters (normalized_name);

create or replace function service.normalize_roaster_name(input text)
returns text
language plpgsql
immutable
as $$
declare
  normalized text;
begin
  if input is null then
    return null;
  end if;

  begin
    execute 'select unaccent($1)' into normalized using input;
  exception when undefined_function or invalid_schema_name then
    begin
      execute 'select extensions.unaccent($1)' into normalized using input;
    exception when undefined_function or invalid_schema_name then
      begin
        execute 'select public.unaccent($1)' into normalized using input;
      exception when undefined_function or invalid_schema_name then
        normalized := input;
      end;
    end;
  end;

  return lower(trim(normalized));
end;
$$;

create or replace function service.assign_roaster_candidate_cluster()
returns trigger
language plpgsql
as $$
declare
  normalized_name text;
  cluster_uuid uuid;
begin
  normalized_name := service.normalize_roaster_name(NEW.roaster);

  insert into service.roaster_candidate_clusters (
    normalized_name,
    display_name,
    sample_names,
    candidate_count,
    occurrences,
    updated_at
  )
  values (
    normalized_name,
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
  returning id into cluster_uuid;

  NEW.cluster_id := cluster_uuid;

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

  return NEW;
end;
$$;

drop trigger if exists assign_roaster_candidate_cluster_trigger on service.new_roaster_candidates;

create trigger assign_roaster_candidate_cluster_trigger
  before insert on service.new_roaster_candidates
  for each row
  execute function service.assign_roaster_candidate_cluster();
