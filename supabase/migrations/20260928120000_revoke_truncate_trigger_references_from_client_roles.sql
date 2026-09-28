-- Revoke TRUNCATE, TRIGGER and REFERENCES from the client roles on every table
-- and view in `public` and `service`, and close the default privileges that
-- keep re-granting them.
--
-- Why: `postgres`'s default privileges in both schemas grant `anon` and
-- `authenticated` arwdDxt on every new table. RLS masks SELECT/INSERT/UPDATE/
-- DELETE, but TRUNCATE is table-level and RLS cannot restrain it (measured on
-- production 2026-09-14: anon TRUNCATE on an RLS-protected service table
-- succeeded). TRIGGER and REFERENCES are likewise never needed by a client.
-- Audit 2026-09-28: all 85 tables/views in `public` + `service` carried all
-- three for both roles, except the plan-029 job ledger already fixed in
-- 20260914120050. No function in either schema issues TRUNCATE, and every
-- object is owned by `postgres`.
--
-- SELECT/INSERT/UPDATE/DELETE are left untouched: those are gated by RLS and
-- the app depends on them.

do $$
declare
  r record;
begin
  for r in
    select c.relnamespace::regnamespace::text as schema_name,
           c.relname as rel_name
    from pg_class c
    where c.relnamespace::regnamespace::text in ('public', 'service')
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and pg_get_userbyid(c.relowner) = 'postgres'
  loop
    execute format(
      'revoke truncate, trigger, references on table %I.%I from anon, authenticated',
      r.schema_name, r.rel_name
    );
  end loop;
end $$;

-- `anon` has no legitimate access to push tokens: the app only touches this
-- table with a user session (anonymous users run as `authenticated`), and
-- every policy keys on auth.uid(). `authenticated` keeps SELECT/INSERT/UPDATE/
-- DELETE for the app's own-row upsert and sign-out delete.
revoke all on table service.user_fcm_tokens from anon;

-- Stop new tables inheriting the three privileges. Only `postgres`'s defaults
-- can be altered from a migration; `supabase_admin` also has public-schema
-- defaults, but no table here is owned by it.
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;
alter default privileges for role postgres in schema service
  revoke truncate, trigger, references on tables from anon, authenticated;

-- Verify after `db push` (expect zero rows, then anon absent on user_fcm_tokens):
--   select table_schema, table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema in ('public','service')
--     and grantee in ('anon','authenticated')
--     and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES');
--   select grantee, string_agg(privilege_type, ',')
--   from information_schema.role_table_grants
--   where table_schema = 'service' and table_name = 'user_fcm_tokens'
--   group by 1;
--   select defaclnamespace::regnamespace, defaclacl::text from pg_default_acl
--   where pg_get_userbyid(defaclrole) = 'postgres' and defaclobjtype = 'r';
