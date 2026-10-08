-- Security F01 follow-up: anonymous sign-in left the guest Auth user undeletable.
--
-- On 2026-10-08 update-id-after-signin returned 500 source_delete_failed for a
-- real sign-in: migrate_anonymous_account_data moved the data and wrote the
-- ledger row, but auth.admin.deleteUser(source) failed with 23503 on
-- bean_reviews_user_id_fkey. public.bean_reviews.user_id references auth.users
-- ON DELETE NO ACTION and the RPC did not move it. A retry could not recover
-- either: an existing claim returned early without moving anything, so the
-- deletion failed the same way every time and the row stayed at data_migrated.
--
-- This version:
--   * moves bean_reviews. Replies and translations follow review_id, so they
--     need nothing. The account's review wins a duplicate: a guest review that
--     would violate either unique index on the destination is deleted first
--     (its translations and reply cascade). The indexes are
--     UNIQUE (user_id, roaster_name, bean_name) and
--     UNIQUE (user_id, coffee_beans_uuid) WHERE coffee_beans_uuid IS NOT NULL;
--     plain = mirrors how both treat NULLs, which never collide.
--   * moves review_replies.user_id and service.notifications.user_id, the other
--     NO ACTION references a guest could hold. Neither has a unique constraint
--     involving user_id.
--   * resumes: a claim at data_migrated for the same destination re-runs every
--     move. Each move touches only rows the source still owns, so repeating it
--     is safe; it also catches rows written to the guest between the first move
--     and the Auth deletion. The new counts are added to the stored ones. A
--     completed claim still returns early, and a different destination is
--     still refused with PT409.
--
-- The DO block at the end refuses the migration if any NO ACTION/RESTRICT
-- foreign key to auth.users outside the auth schema is neither moved by this
-- function nor in an explicit allowlist. tests/security/f01_auth_users_fk_coverage.sql
-- runs the same check on demand, so a later migration that adds such a key is
-- caught there.

create or replace function service.migrate_anonymous_account_data(p_source uuid, p_destination uuid)
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
  bean_reviews_dropped_count bigint;
  bean_reviews_count bigint;
  review_replies_count bigint;
  notifications_count bigint;
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
  if claim.status = 'completed' then
    return jsonb_build_object('status', claim.status, 'already', true, 'moved', claim.moved);
  end if;

  update public.global_stats set user_id = p_destination where user_id = p_source;
  get diagnostics global_stats_count = row_count;
  update public.parse_coffee_label_invocations set user_id = p_destination where user_id = p_source;
  get diagnostics label_invocations_count = row_count;

  -- NO ACTION foreign keys are checked after this entire statement finishes.
  -- Moved recipes no longer carry the source vendor_id, and a collision stays
  -- excluded by not exists, so a resumed run renames only new source recipes.
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

  -- The account's review wins: drop guest reviews that would collide with it
  -- on either unique index (translations and replies cascade), then move the rest.
  delete from public.bean_reviews guest
    where guest.user_id = p_source
      and exists (
        select 1 from public.bean_reviews account
        where account.user_id = p_destination
          and ((account.roaster_name = guest.roaster_name and account.bean_name = guest.bean_name)
            or account.coffee_beans_uuid = guest.coffee_beans_uuid)
      );
  get diagnostics bean_reviews_dropped_count = row_count;
  update public.bean_reviews set user_id = p_destination where user_id = p_source;
  get diagnostics bean_reviews_count = row_count;
  update public.review_replies set user_id = p_destination where user_id = p_source;
  get diagnostics review_replies_count = row_count;
  update service.notifications set user_id = p_destination where user_id = p_source;
  get diagnostics notifications_count = row_count;

  moved_counts := jsonb_build_object(
    'global_stats', global_stats_count, 'label_invocations', label_invocations_count,
    'recipes', recipes_count, 'recipe_localizations', localizations_count,
    'recipe_steps', steps_count, 'fcm_tokens', fcm_tokens_count,
    'bean_reviews', bean_reviews_count,
    'bean_reviews_dropped_duplicates', bean_reviews_dropped_count,
    'review_replies', review_replies_count, 'notifications', notifications_count
  );
  if not inserted then
    -- Resume: add this run's counts to the stored ones. Rows written by the
    -- previous version lack the newer keys, which the union supplies.
    select jsonb_object_agg(key, total) into moved_counts
    from (
      select key, sum(value::bigint) as total
      from (
        select key, value from jsonb_each(claim.moved)
        union all
        select key, value from jsonb_each(moved_counts)
      ) counts
      group by key
    ) merged;
  end if;
  update service.anonymous_account_migrations set moved = moved_counts where source_user_id = p_source;
  return jsonb_build_object('status', 'data_migrated', 'already', not inserted, 'moved', moved_counts);
end;
$$;

revoke execute on function service.migrate_anonymous_account_data(uuid, uuid) from public;
revoke execute on function service.migrate_anonymous_account_data(uuid, uuid) from anon;
revoke execute on function service.migrate_anonymous_account_data(uuid, uuid) from authenticated;
grant execute on function service.migrate_anonymous_account_data(uuid, uuid) to service_role;
grant execute on function service.migrate_anonymous_account_data(uuid, uuid) to postgres;

-- Regression guard. Any NO ACTION/RESTRICT reference to auth.users outside the
-- auth schema blocks auth.admin.deleteUser(source) while the guest owns a row.
-- Each one must be moved by the function above (an
-- "update <schema>.<table> set <column> = p_destination" in its body) or be
-- an admin-only column a guest cannot own. Same check as
-- tests/security/f01_auth_users_fk_coverage.sql.
do $$
declare
  uncovered text;
begin
  select string_agg(format('%s.%s (%s)', c.conrelid::regclass, a.attname, c.conname), ', '
      order by c.conrelid::regclass::text, a.attname)
    into uncovered
  from pg_catalog.pg_constraint c
  join pg_catalog.pg_class t on t.oid = c.conrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  cross join (
    select p.prosrc from pg_catalog.pg_proc p
    where p.oid = 'service.migrate_anonymous_account_data(uuid,uuid)'::regprocedure
  ) fn
  where c.contype = 'f'
    and c.confrelid = 'auth.users'::regclass
    and c.confdeltype in ('a', 'r')
    and n.nspname <> 'auth'
    and (n.nspname, t.relname, a.attname) not in (
      -- Admin-only columns; a guest (anonymous) user cannot own these rows.
      ('public', 'roaster_profiles', 'admin_user_id'),
      ('service', 'notification_templates', 'created_by'),
      ('service', 'recipe_draft_lab_access', 'created_by')
    )
    and fn.prosrc !~* format('update\s+%s\.%s\s+set\s+%s\s*=\s*p_destination\M',
      n.nspname, t.relname, a.attname);
  if uncovered is not null then
    raise exception 'auth.users references that block anonymous-account deletion are not moved by service.migrate_anonymous_account_data: %', uncovered;
  end if;
end
$$;
