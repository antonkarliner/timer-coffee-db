-- Attach user-logged bean bags (global_coffee_beans) to roasters (coffee_roasters)
-- and expose a "bags logged by the community" count on roaster profiles.
--
-- global_coffee_beans is a per-add bag log (one row per bag a user adds,
-- including anonymous users). Linkage to a roaster is by exact normalized
-- canonical name or exact comma-separated alias. Ambiguous matches (a string
-- that maps to more than one roaster) intentionally remain unlinked rather than
-- being guessed -- mirrors resolve_roaster_profile_for_review for bean_reviews.

--------------------------------------------------------------------------------
-- 1) Schema: physical link + creation timestamp
--------------------------------------------------------------------------------

alter table public.global_coffee_beans
  add column if not exists coffee_roaster_id bigint references public.coffee_roasters(id);

-- created_at: add WITHOUT a default so the ~10k existing rows stay NULL
-- ("unknown"), then set the default for future inserts only. Adding a volatile
-- default (now()) up front would stamp every existing row with the migration
-- time and poison any future "recent activity" metric.
alter table public.global_coffee_beans
  add column if not exists created_at timestamptz;
alter table public.global_coffee_beans
  alter column created_at set default now();

create index if not exists idx_global_coffee_beans_coffee_roaster_id
  on public.global_coffee_beans (coffee_roaster_id);

--------------------------------------------------------------------------------
-- 2) Resolver: free-text roaster string -> coffee_roasters.id (or NULL)
--------------------------------------------------------------------------------

create or replace function public.resolve_coffee_roaster_id(p_roaster_name text)
returns bigint
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
  roaster_matches as (
    select distinct cr.id
    from public.coffee_roasters cr
    cross join input
    where input.normalized_name is not null
      and (
        lower(extensions.unaccent(trim(coalesce(cr.roaster_name, '')))) = input.normalized_name
        or exists (
          select 1
          from regexp_split_to_table(coalesce(cr.aliases, ''), '\s*,\s*') as alias_item(alias)
          where nullif(trim(alias_item.alias), '') is not null
            and lower(extensions.unaccent(trim(alias_item.alias))) = input.normalized_name
        )
      )
  )
  select case
    when count(*) = 1 then (array_agg(id))[1]
    else null::bigint
  end
  from roaster_matches;
$function$;

--------------------------------------------------------------------------------
-- 3) On bean insert/update: stamp coffee_roaster_id when resolvable
--------------------------------------------------------------------------------

create or replace function public.link_global_bean_to_coffee_roaster()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $function$
begin
  if new.coffee_roaster_id is null
     and nullif(trim(coalesce(new.roaster, '')), '') is not null then
    new.coffee_roaster_id := public.resolve_coffee_roaster_id(new.roaster);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_link_global_bean_to_coffee_roaster on public.global_coffee_beans;
create trigger trg_link_global_bean_to_coffee_roaster
  before insert or update of roaster, coffee_roaster_id on public.global_coffee_beans
  for each row
  when (new.coffee_roaster_id is null)
  execute function public.link_global_bean_to_coffee_roaster();

--------------------------------------------------------------------------------
-- 4) On roaster insert / name+alias edit: attach previously-unlinked beans
--    (this is the "roaster added later -> its historical bags count" case)
--------------------------------------------------------------------------------

create or replace function public.attach_pending_global_beans()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $function$
begin
  with roaster_terms as (
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
  matching_beans as (
    select
      g.id,
      public.resolve_coffee_roaster_id(g.roaster) as resolved_id
    from public.global_coffee_beans g
    join roaster_terms rt
      on rt.normalized_term is not null
     and lower(extensions.unaccent(trim(g.roaster))) = rt.normalized_term
    where g.coffee_roaster_id is null
  )
  update public.global_coffee_beans g
  set coffee_roaster_id = new.id
  from matching_beans mb
  where g.id = mb.id
    and mb.resolved_id = new.id;
  return new;
end;
$function$;

drop trigger if exists trg_attach_pending_global_beans on public.coffee_roasters;
create trigger trg_attach_pending_global_beans
  after insert or update of roaster_name, aliases on public.coffee_roasters
  for each row
  execute function public.attach_pending_global_beans();

--------------------------------------------------------------------------------
-- 5) One-time backfill (set-based, ambiguity-safe)
--    A normalized string mapping to >1 roaster is skipped (left unlinked).
--------------------------------------------------------------------------------

with roaster_norms as (
  select cr.id, lower(extensions.unaccent(trim(cr.roaster_name))) as norm
  from public.coffee_roasters cr
  where nullif(trim(coalesce(cr.roaster_name, '')), '') is not null
  union
  select cr.id, lower(extensions.unaccent(trim(alias_item.alias)))
  from public.coffee_roasters cr,
       regexp_split_to_table(coalesce(cr.aliases, ''), '\s*,\s*') as alias_item(alias)
  where nullif(trim(alias_item.alias), '') is not null
),
unique_norms as (
  select norm, max(id) as id
  from roaster_norms
  where norm is not null and norm <> ''
  group by norm
  having count(distinct id) = 1
)
update public.global_coffee_beans g
set coffee_roaster_id = un.id
from unique_norms un
where g.coffee_roaster_id is null
  and nullif(trim(coalesce(g.roaster, '')), '') is not null
  and lower(extensions.unaccent(trim(g.roaster))) = un.norm;

--------------------------------------------------------------------------------
-- 6) Expose logged_bag_count on the roaster profile RPC
--    (live indexed count; all existing fields preserved verbatim)
--------------------------------------------------------------------------------

create or replace function public.get_roaster_profile(p_slug text)
returns json
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $function$
  select row_to_json(t)
  from (
    select
      id,
      slug,
      coffee_roaster_id,
      admin_user_id,
      roaster_name,
      roaster_logo_url,
      roaster_logo_mirror_url,
      dominant_color_hex,
      website_url,
      description,
      city,
      state,
      country,
      address_text,
      instagram_url,
      twitter_url,
      facebook_url,
      tiktok_url,
      is_active,
      coalesce((
        select count(*)
        from public.global_coffee_beans g
        where g.coffee_roaster_id = roaster_profiles.coffee_roaster_id
      ), 0) as logged_bag_count
    from public.roaster_profiles
    where slug = p_slug
      and is_active = true
    limit 1
  ) t;
$function$;
