-- Security F01: anonymous account data could be claimed by another user.
--
-- update-id-after-signin accepted any anonymous oldUserId from the request
-- body, so a signed-in attacker who learned a guest's UUID could move that
-- guest's stats, label-scan history, recipes and FCM tokens to themselves and
-- delete the guest's Auth user. The function now requires the guest session's
-- own access token as proof (verified with auth.getUser) and moves the data
-- through the RPC below, in one transaction.
--
-- service.anonymous_account_migrations is the claim ledger: one row per source
-- account, bound to the destination that first claimed it. A retry for the same
-- destination resumes (the data move is not repeated, the Auth deletion is
-- retried); a different destination is refused with SQLSTATE PT409. The Auth
-- user is deleted by the edge function only after the data move commits, and
-- complete_anonymous_account_migration records that.
--
-- Recipe ids carry the owner (usr-<uuid>-<suffix>), so the rename moves parent
-- rows and their localization/step children in one statement: the children's
-- ON UPDATE NO ACTION foreign keys are checked at the end of that statement.
-- The old function renamed them with separate requests, which those foreign
-- keys rejected (silently, because supabase-js resolves rather than throws).
-- A recipe whose renamed id already exists is left where it is.

create table service.anonymous_account_migrations (
  source_user_id uuid primary key,
  destination_user_id uuid not null,
  status text not null check (status in ('data_migrated', 'completed')),
  moved jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (source_user_id <> destination_user_id)
);

comment on table service.anonymous_account_migrations is
  'Service-only claims and retry state for verified anonymous account migrations; source Auth users may be deleted.';
create index anonymous_account_migrations_destination_idx
  on service.anonymous_account_migrations (destination_user_id);
alter table service.anonymous_account_migrations enable row level security;
revoke all on table service.anonymous_account_migrations from public;
revoke all on table service.anonymous_account_migrations from anon;
revoke all on table service.anonymous_account_migrations from authenticated;
grant select, insert, update, delete on table service.anonymous_account_migrations to service_role;

create function service.migrate_anonymous_account_data(p_source uuid, p_destination uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  claim service.anonymous_account_migrations%rowtype;
  inserted boolean := false;
  global_stats_count bigint;
  label_invocations_count bigint;
  recipes_count bigint;
  localizations_count bigint;
  steps_count bigint;
  fcm_tokens_count bigint;
  moved_counts jsonb;
  source_prefix text := 'usr-' || p_source::text || '-';
  destination_prefix text := 'usr-' || p_destination::text || '-';
begin
  if p_source is null or p_destination is null or p_source = p_destination then
    raise exception 'Source and destination must be distinct non-null users' using errcode = '22023';
  end if;

  select * into claim from service.anonymous_account_migrations
    where source_user_id = p_source for update;
  if not found then
    insert into service.anonymous_account_migrations (source_user_id, destination_user_id, status)
      values (p_source, p_destination, 'data_migrated')
      on conflict (source_user_id) do nothing returning * into claim;
    inserted := found;
    if not inserted then
      select * into claim from service.anonymous_account_migrations
        where source_user_id = p_source for update;
    end if;
  end if;
  if claim.destination_user_id <> p_destination then
    raise exception using errcode = 'PT409', message = 'anonymous_migration_conflict';
  end if;
  if not inserted then
    return jsonb_build_object('status', claim.status, 'already', true, 'moved', claim.moved);
  end if;

  update public.global_stats set user_id = p_destination where user_id = p_source;
  get diagnostics global_stats_count = row_count;
  update public.parse_coffee_label_invocations set user_id = p_destination where user_id = p_source;
  get diagnostics label_invocations_count = row_count;

  -- NO ACTION foreign keys are checked after this entire statement finishes.
  with mapping as (
    select r.id as old_id,
      destination_prefix || substr(r.id, length(source_prefix) + 1) as new_id
    from public.user_recipes r
    where r.vendor_id = 'usr-' || p_source::text
      and left(r.id, length(source_prefix)) = source_prefix
      and not exists (
        select 1 from public.user_recipes existing
        where existing.id = destination_prefix || substr(r.id, length(source_prefix) + 1)
      )
  ), recipes as (
    update public.user_recipes r set id = m.new_id, vendor_id = 'usr-' || p_destination::text
    from mapping m where r.id = m.old_id returning 1
  ), localizations as (
    update public.user_recipe_localizations l set recipe_id = m.new_id
    from mapping m where l.recipe_id = m.old_id returning 1
  ), steps as (
    update public.user_steps s set recipe_id = m.new_id
    from mapping m where s.recipe_id = m.old_id returning 1
  )
  select (select count(*) from recipes), (select count(*) from localizations),
    (select count(*) from steps) into recipes_count, localizations_count, steps_count;

  update service.user_fcm_tokens set user_id = p_destination where user_id = p_source;
  get diagnostics fcm_tokens_count = row_count;
  moved_counts := jsonb_build_object(
    'global_stats', global_stats_count, 'label_invocations', label_invocations_count,
    'recipes', recipes_count, 'recipe_localizations', localizations_count,
    'recipe_steps', steps_count, 'fcm_tokens', fcm_tokens_count
  );
  update service.anonymous_account_migrations set moved = moved_counts where source_user_id = p_source;
  return jsonb_build_object('status', 'data_migrated', 'already', false, 'moved', moved_counts);
end;
$$;

create function service.complete_anonymous_account_migration(p_source uuid, p_destination uuid)
returns boolean
language sql security invoker set search_path = ''
as $$
  with completed as (
    update service.anonymous_account_migrations
      set status = 'completed', completed_at = now()
      where source_user_id = p_source and destination_user_id = p_destination
        and status = 'data_migrated'
      returning 1
  )
  select exists (select 1 from completed) or exists (
    select 1 from service.anonymous_account_migrations
      where source_user_id = p_source and destination_user_id = p_destination and status = 'completed'
  );
$$;

revoke execute on function service.migrate_anonymous_account_data(uuid, uuid) from public;
revoke execute on function service.migrate_anonymous_account_data(uuid, uuid) from anon;
revoke execute on function service.migrate_anonymous_account_data(uuid, uuid) from authenticated;
grant execute on function service.migrate_anonymous_account_data(uuid, uuid) to service_role;
grant execute on function service.migrate_anonymous_account_data(uuid, uuid) to postgres;
revoke execute on function service.complete_anonymous_account_migration(uuid, uuid) from public;
revoke execute on function service.complete_anonymous_account_migration(uuid, uuid) from anon;
revoke execute on function service.complete_anonymous_account_migration(uuid, uuid) from authenticated;
grant execute on function service.complete_anonymous_account_migration(uuid, uuid) to service_role;
grant execute on function service.complete_anonymous_account_migration(uuid, uuid) to postgres;
