-- Plan 062 phase 1: resolve terminal roaster contributions and expose a
-- private, per-user acknowledgement loop through narrowly granted RPCs.

alter table service.roaster_candidate_contributions
  add column if not exists resolved_roaster_id bigint
    references public.coffee_roasters(id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_channel text;

alter table service.roaster_candidate_contributions
  drop constraint if exists roaster_candidate_contributions_status_check;

alter table service.roaster_candidate_contributions
  add constraint roaster_candidate_contributions_status_check
  check (status in ('new', 'accepted', 'superseded', 'rejected'));

alter table service.roaster_candidate_contributions
  drop constraint if exists roaster_candidate_contributions_acknowledged_channel_check;

alter table service.roaster_candidate_contributions
  add constraint roaster_candidate_contributions_acknowledged_channel_check
  check (
    acknowledged_channel is null
    or acknowledged_channel in ('in_app', 'push')
  );

create index if not exists idx_roaster_candidate_contributions_submitter_status
  on service.roaster_candidate_contributions (submitted_by, status);

create or replace function service.resolve_roaster_for_cluster(
  p_cluster_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_normalized_name text;
  v_roaster_id bigint;
begin
  select cluster.normalized_name
  into v_normalized_name
  from service.roaster_candidate_clusters as cluster
  where cluster.id = p_cluster_id;

  if not found then
    return null;
  end if;

  select cluster.best_match_roaster_id
  into v_roaster_id
  from service.roaster_candidate_clusters as cluster
  where cluster.id = p_cluster_id
    and cluster.best_match_roaster_id is not null
    and exists (
      select 1
      from public.roaster_profiles as profile
      where profile.coffee_roaster_id = cluster.best_match_roaster_id
        and profile.is_active = true
    );

  if v_roaster_id is not null then
    return v_roaster_id;
  end if;

  select case
    when count(distinct roaster.id) = 1 then min(roaster.id)
    else null
  end
  into v_roaster_id
  from public.coffee_roasters as roaster
  where service.normalize_roaster_name(roaster.roaster_name) = v_normalized_name
    and exists (
      select 1
      from public.roaster_profiles as profile
      where profile.coffee_roaster_id = roaster.id
        and profile.is_active = true
    );

  if v_roaster_id is not null then
    return v_roaster_id;
  end if;

  select case
    when count(*) = 1 then min(profile.coffee_roaster_id)
    else null
  end
  into v_roaster_id
  from public.roaster_profiles as profile
  where profile.is_active = true
    and v_normalized_name = any(profile.norm_terms);

  return v_roaster_id;
end;
$function$;

create or replace function service.apply_contribution_resolution(
  p_cluster_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cluster_status text;
  v_resolved_roaster_id bigint;
  v_rows_changed integer := 0;
begin
  select cluster.status
  into v_cluster_status
  from service.roaster_candidate_clusters as cluster
  where cluster.id = p_cluster_id;

  if v_cluster_status = 'approved' then
    v_resolved_roaster_id := service.resolve_roaster_for_cluster(p_cluster_id);

    if v_resolved_roaster_id is null then
      return 0;
    end if;

    update service.roaster_candidate_contributions
    set
      status = 'accepted',
      resolved_roaster_id = v_resolved_roaster_id,
      resolved_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where cluster_id = p_cluster_id
      and status = 'new';
  elsif v_cluster_status = 'rejected' then
    update service.roaster_candidate_contributions
    set
      status = 'rejected',
      updated_at = pg_catalog.now()
    where cluster_id = p_cluster_id
      and status = 'new';
  elsif v_cluster_status = 'processed_as_alias' then
    update service.roaster_candidate_contributions
    set
      status = 'superseded',
      updated_at = pg_catalog.now()
    where cluster_id = p_cluster_id
      and status = 'new';
  else
    return 0;
  end if;

  get diagnostics v_rows_changed = row_count;
  return v_rows_changed;
end;
$function$;

create or replace function service.handle_contribution_resolution_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  begin
    perform service.apply_contribution_resolution(new.id);
  exception when others then
    raise warning 'Contribution resolution failed for cluster %: %',
      new.id,
      sqlerrm;
  end;

  return null;
end;
$function$;

drop trigger if exists trg_contribution_resolution
  on service.roaster_candidate_clusters;

create trigger trg_contribution_resolution
  after update on service.roaster_candidate_clusters
  for each row
  when (
    new.status in ('approved', 'rejected', 'processed_as_alias')
    and (
      old.status is distinct from new.status
      or old.best_match_roaster_id is distinct from new.best_match_roaster_id
    )
  )
  execute function service.handle_contribution_resolution_trigger();

create or replace function service.reconcile_contribution_resolutions(
  p_limit integer default 1000
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cluster_id uuid;
  v_rows_changed integer := 0;
begin
  for v_cluster_id in
    select distinct contribution.cluster_id
    from service.roaster_candidate_contributions as contribution
    join service.roaster_candidate_clusters as cluster
      on cluster.id = contribution.cluster_id
    where contribution.status = 'new'
      and cluster.status in ('approved', 'rejected', 'processed_as_alias')
    order by contribution.cluster_id
    limit greatest(coalesce(p_limit, 1000), 0)
  loop
    v_rows_changed := v_rows_changed
      + service.apply_contribution_resolution(v_cluster_id);
  end loop;

  return v_rows_changed;
end;
$function$;

create or replace function public.get_my_contribution_acknowledgements(
  p_limit integer default 10
)
returns table (
  contribution_id bigint,
  roaster_name text,
  slug text,
  roaster_logo_mirror_url text,
  dominant_color_hex text,
  resolved_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    contribution.id as contribution_id,
    profile.roaster_name,
    profile.slug,
    profile.roaster_logo_mirror_url,
    profile.dominant_color_hex,
    contribution.resolved_at
  from service.roaster_candidate_contributions as contribution
  join public.roaster_profiles as profile
    on profile.coffee_roaster_id = contribution.resolved_roaster_id
   and profile.is_active = true
  where auth.uid() is not null
    and contribution.submitted_by = auth.uid()
    and contribution.status = 'accepted'
    and contribution.acknowledged_at is null
  order by contribution.resolved_at desc nulls last, contribution.id desc
  limit least(
    greatest(coalesce(p_limit, 10), 1),
    50
  );
$function$;

create or replace function public.mark_contribution_acknowledged(
  p_contribution_id bigint,
  p_channel text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_rows_changed integer;
begin
  if p_channel is null or p_channel not in ('in_app', 'push') then
    raise exception 'Invalid acknowledgement channel: %', p_channel
      using errcode = '22023';
  end if;

  update service.roaster_candidate_contributions
  set
    acknowledged_at = pg_catalog.now(),
    acknowledged_channel = p_channel,
    updated_at = pg_catalog.now()
  where id = p_contribution_id
    and submitted_by = auth.uid()
    and status = 'accepted'
    and acknowledged_at is null;

  get diagnostics v_rows_changed = row_count;
  return v_rows_changed = 1;
end;
$function$;

revoke all on function service.resolve_roaster_for_cluster(uuid) from public;
grant execute on function service.resolve_roaster_for_cluster(uuid)
  to service_role;

revoke all on function service.apply_contribution_resolution(uuid) from public;
grant execute on function service.apply_contribution_resolution(uuid)
  to service_role;

revoke all on function service.handle_contribution_resolution_trigger()
  from public;
grant execute on function service.handle_contribution_resolution_trigger()
  to service_role;

revoke all on function service.reconcile_contribution_resolutions(integer)
  from public;
grant execute on function service.reconcile_contribution_resolutions(integer)
  to service_role;

revoke all on function public.get_my_contribution_acknowledgements(integer)
  from public;
grant execute on function public.get_my_contribution_acknowledgements(integer)
  to authenticated, service_role;

revoke all on function public.mark_contribution_acknowledged(bigint, text)
  from public;
grant execute on function public.mark_contribution_acknowledged(bigint, text)
  to authenticated, service_role;
