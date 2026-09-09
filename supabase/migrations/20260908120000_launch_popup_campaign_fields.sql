-- Plan 052, Item A / Phase A1 — campaign channel on the existing launch_popup
-- table (decision D2: extend, do not add a new table, so campaigns inherit both
-- delivery surfaces — the home popup and the finish-screen what's-new card —
-- with no new client fetch path).
--
-- All four columns are nullable: every existing row stays valid and a row with
-- a NULL hook_type follows the exact pre-existing client code path.
--
-- RLS/GRANTs: public.launch_popup already has RLS enabled with a single SELECT
-- policy `Enable read access for all users` USING (true), and table-level
-- SELECT is granted to anon, authenticated and service_role. Both are
-- column-agnostic, so the new columns are covered without further grants.
-- Verified against production before writing this migration; no new policy or
-- GRANT is added here deliberately.

alter table public.launch_popup
  add column if not exists hook_type text,
  add column if not exists goal_amount_usd numeric,
  add column if not exists progress_amount_usd numeric,
  add column if not exists campaign_ends_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.launch_popup'::regclass
      and conname = 'launch_popup_hook_type_check'
  ) then
    alter table public.launch_popup
      add constraint launch_popup_hook_type_check
      check (
        hook_type is null
        or hook_type in (
          'license_renewal',
          'coffee_day',
          'black_friday',
          'feature_object',
          'yearly_recap'
        )
      );
  end if;
end
$$;

comment on column public.launch_popup.hook_type is
  'Campaign hook this popup belongs to; NULL means an ordinary (non-campaign) popup. Plan 052 Item A.';
comment on column public.launch_popup.goal_amount_usd is
  'Optional campaign funding goal in USD. The client renders a progress bar only when both this and progress_amount_usd are non-null and this is > 0.';
comment on column public.launch_popup.progress_amount_usd is
  'Optional campaign progress in USD, paired with goal_amount_usd.';
comment on column public.launch_popup.campaign_ends_at is
  'Optional campaign end. Past this instant the client renders the row as an ordinary popup, not an expired campaign shell.';

-- ── Translated children inherit the campaign, or the campaign is English-only ──
--
-- Launch popups fan out: `public.translate_launch_popup()` posts the English
-- source to the translate-openai edge function, which upserts one translated
-- child row per locale keyed on (source_popup_id, locale). Those rows are built
-- from the translated text alone and carry none of the source's other fields.
-- The app fetches strictly `.eq('locale', <device locale>)`, so without the
-- triggers below a campaign would render for English users only and be
-- invisible in the other 21 languages — and a translation retry's upsert would
-- wipe any campaign values backfilled by hand.
--
-- Both triggers are the single point where campaign fields reach children, so
-- the edge function needs no change.

create or replace function public.inherit_launch_popup_campaign_fields()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
declare
  source_row record;
begin
  if new.source_popup_id is null then
    return new;
  end if;

  select
    parent.hook_type,
    parent.goal_amount_usd,
    parent.progress_amount_usd,
    parent.campaign_ends_at
  into source_row
  from public.launch_popup as parent
  where parent.id = new.source_popup_id;

  if not found then
    return new;
  end if;

  new.hook_type := source_row.hook_type;
  new.goal_amount_usd := source_row.goal_amount_usd;
  new.progress_amount_usd := source_row.progress_amount_usd;
  new.campaign_ends_at := source_row.campaign_ends_at;

  return new;
end;
$function$;

comment on function public.inherit_launch_popup_campaign_fields() is
  'Copies campaign fields from an English source popup onto each translated child row on insert or upsert, so a campaign renders in every locale.';

revoke execute on function public.inherit_launch_popup_campaign_fields()
  from public, anon, authenticated;
grant execute on function public.inherit_launch_popup_campaign_fields()
  to service_role;

drop trigger if exists inherit_launch_popup_campaign_fields_before_write
  on public.launch_popup;

create trigger inherit_launch_popup_campaign_fields_before_write
before insert or update on public.launch_popup
for each row
execute function public.inherit_launch_popup_campaign_fields();

create or replace function public.propagate_launch_popup_campaign_fields()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
begin
  -- Only English source rows fan out, and only when a campaign field actually
  -- changed (progress_amount_usd is expected to be updated mid-campaign).
  if new.source_popup_id is not null then
    return null;
  end if;

  update public.launch_popup as child
  set
    hook_type = new.hook_type,
    goal_amount_usd = new.goal_amount_usd,
    progress_amount_usd = new.progress_amount_usd,
    campaign_ends_at = new.campaign_ends_at
  where child.source_popup_id = new.id;

  return null;
end;
$function$;

comment on function public.propagate_launch_popup_campaign_fields() is
  'Pushes a source popup''s campaign-field edits down to its translated children, so mid-campaign progress updates reach every locale.';

revoke execute on function public.propagate_launch_popup_campaign_fields()
  from public, anon, authenticated;
grant execute on function public.propagate_launch_popup_campaign_fields()
  to service_role;

drop trigger if exists propagate_launch_popup_campaign_fields_after_update
  on public.launch_popup;

create trigger propagate_launch_popup_campaign_fields_after_update
after update of hook_type, goal_amount_usd, progress_amount_usd, campaign_ends_at
on public.launch_popup
for each row
when (
  old.hook_type is distinct from new.hook_type
  or old.goal_amount_usd is distinct from new.goal_amount_usd
  or old.progress_amount_usd is distinct from new.progress_amount_usd
  or old.campaign_ends_at is distinct from new.campaign_ends_at
)
execute function public.propagate_launch_popup_campaign_fields();
