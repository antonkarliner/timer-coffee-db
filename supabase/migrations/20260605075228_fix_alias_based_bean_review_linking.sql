-- Link pending bean reviews to roaster profiles by exact normalized canonical
-- name or exact comma-separated alias. Ambiguous matches intentionally remain
-- pending instead of being guessed.

create or replace function public.resolve_roaster_profile_for_review(
  p_roaster_name text
)
returns uuid
language sql
stable
set search_path = public, extensions, pg_catalog
as $function$
  with input as (
    select nullif(
      lower(extensions.unaccent(trim(p_roaster_name))),
      ''
    ) as normalized_name
  ),
  profile_matches as (
    select distinct rp.id
    from public.roaster_profiles rp
    cross join input
    where input.normalized_name is not null
      and rp.is_active = true
      and (
        lower(extensions.unaccent(trim(coalesce(rp.roaster_name, '')))) = input.normalized_name
        or exists (
          select 1
          from regexp_split_to_table(coalesce(rp.aliases, ''), '\s*,\s*') as alias_item(alias)
          where nullif(trim(alias_item.alias), '') is not null
            and lower(extensions.unaccent(trim(alias_item.alias))) = input.normalized_name
        )
      )
  )
  select case
    when count(*) = 1 then (array_agg(id))[1]
    else null::uuid
  end
  from profile_matches;
$function$;

create or replace function public.link_pending_bean_reviews()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $function$
begin
  with profile_terms as (
    select nullif(
      lower(extensions.unaccent(trim(new.roaster_name))),
      ''
    ) as normalized_term
    union
    select nullif(
      lower(extensions.unaccent(trim(alias_item.alias))),
      ''
    ) as normalized_term
    from regexp_split_to_table(coalesce(new.aliases, ''), '\s*,\s*') as alias_item(alias)
  ),
  matching_reviews as (
    select
      br.id,
      public.resolve_roaster_profile_for_review(br.roaster_name) as resolved_profile_id
    from public.bean_reviews br
    join profile_terms pt
      on pt.normalized_term is not null
     and lower(extensions.unaccent(trim(br.roaster_name))) = pt.normalized_term
    where br.roaster_profile_id is null
  )
  update public.bean_reviews br
  set roaster_profile_id = new.id
  from matching_reviews mr
  where br.id = mr.id
    and mr.resolved_profile_id = new.id;

  return new;
end;
$function$;

drop trigger if exists trg_link_pending_bean_reviews on public.roaster_profiles;
create trigger trg_link_pending_bean_reviews
  after insert or update of roaster_name, aliases, is_active on public.roaster_profiles
  for each row
  execute function public.link_pending_bean_reviews();

create or replace function public.link_bean_review_to_roaster_profile()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $function$
begin
  if new.roaster_profile_id is null
     and nullif(trim(coalesce(new.roaster_name, '')), '') is not null then
    new.roaster_profile_id := public.resolve_roaster_profile_for_review(new.roaster_name);
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_link_bean_review_to_roaster_profile on public.bean_reviews;
create trigger trg_link_bean_review_to_roaster_profile
  before insert or update of roaster_name, roaster_profile_id on public.bean_reviews
  for each row
  when (new.roaster_profile_id is null)
  execute function public.link_bean_review_to_roaster_profile();

with resolved_reviews as (
  select
    br.id,
    public.resolve_roaster_profile_for_review(br.roaster_name) as resolved_profile_id
  from public.bean_reviews br
  where br.roaster_profile_id is null
    and nullif(trim(coalesce(br.roaster_name, '')), '') is not null
),
safe_reviews as (
  select id, resolved_profile_id
  from resolved_reviews
  where resolved_profile_id is not null
)
update public.bean_reviews br
set roaster_profile_id = sr.resolved_profile_id
from safe_reviews sr
where br.id = sr.id;
