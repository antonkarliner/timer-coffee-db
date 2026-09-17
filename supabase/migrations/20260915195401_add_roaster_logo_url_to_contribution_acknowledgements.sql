drop function public.get_my_contribution_acknowledgements(integer);

create or replace function public.get_my_contribution_acknowledgements(
  p_limit integer default 10
)
returns table (
  contribution_id bigint,
  roaster_name text,
  slug text,
  roaster_logo_url text,
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
    profile.roaster_logo_url,
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

revoke all on function public.get_my_contribution_acknowledgements(integer) from public;
grant execute on function public.get_my_contribution_acknowledgements(integer) to authenticated, service_role;
