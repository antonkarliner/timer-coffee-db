\set ON_ERROR_STOP on
-- F01 regression guard. A NO ACTION/RESTRICT foreign key to auth.users outside
-- the auth schema makes auth.admin.deleteUser(guest) fail with 23503 once the
-- guest owns a row there, and update-id-after-signin then returns 500
-- source_delete_failed (production, 2026-10-08, bean_reviews_user_id_fkey).
-- Every such column must be moved by service.migrate_anonymous_account_data
-- ("update <schema>.<table> set <column> = p_destination" in its body) or be
-- listed below as admin-only. Catalog reads only, so it is also safe to run
-- read-only against production. Migration
-- 20261008160000_anonymous_migration_moves_bean_reviews.sql runs the same check.
begin;

create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if;
end
$$;

create function pg_temp.uncovered_auth_user_fks() returns text language sql as $$
  select string_agg(format('%s.%s (%s)', c.conrelid::regclass, a.attname, c.conname), ', '
      order by c.conrelid::regclass::text, a.attname)
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
      n.nspname, t.relname, a.attname)
$$;

select pg_temp.assert(pg_temp.uncovered_auth_user_fks() is null,
  'unmoved auth.users references: ' || coalesce(pg_temp.uncovered_auth_user_fks(), ''));

-- Self-test: a new NO ACTION reference the RPC does not move is reported, and
-- ON DELETE CASCADE / SET NULL references are not.
create table public.f01_guard_probe (
  id int primary key,
  owner uuid references auth.users (id),
  cascaded uuid references auth.users (id) on delete cascade,
  nulled uuid references auth.users (id) on delete set null
);
select pg_temp.assert(pg_temp.uncovered_auth_user_fks() = 'f01_guard_probe.owner (f01_guard_probe_owner_fkey)',
  'guard reports exactly the unmoved probe column, got: ' || coalesce(pg_temp.uncovered_auth_user_fks(), '<null>'));

select 'f01_auth_users_fk_coverage: all assertions passed' as result;
rollback;
