\set ON_ERROR_STOP on
begin;

-- F19: what clients may do with public.global_stats after
-- 20261109123435_global_stats_revoke_user_id.sql revoked SELECT on user_id.
--
-- What it protects:
--   * anon and authenticated can no longer read user_id, by any route
--     (table SELECT, column SELECT, WHERE/ORDER BY on the column, or a
--     whole-row reference), while service_role keeps full access;
--   * the app can still record brews: authenticated may insert its own
--     user_id through PostgREST's real statement shape (constant RETURNING,
--     which needs no column privileges), and RLS still confines those
--     inserts to the caller's own user_id;
--   * the finish-screen peer read keeps working through the
--     security-definer get_brew_peers RPC;
--   * RETURNING user_id (the app chaining .select() on the insert) fails,
--     which is why the app must never do that.
--
-- MUST RUN ONLY ON A LOCAL OR REPLAY DATABASE, WITH THE REVOKE MIGRATION
-- ALREADY APPLIED -- never on production: it seeds auth.users and global_stats
-- rows and switches roles. Everything is rolled back at the end.

create function pg_temp.assert(ok boolean, msg text)
returns void language plpgsql
set search_path = ''
as $$begin if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if; end$$;

revoke execute on function pg_temp.assert(boolean, text) from public;
revoke execute on function pg_temp.assert(boolean, text) from anon;
revoke execute on function pg_temp.assert(boolean, text) from authenticated;
grant execute on function pg_temp.assert(boolean, text) to anon, authenticated, service_role, postgres;

insert into auth.users (id, instance_id, aud, role, email, is_anonymous,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('c1190000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1190000-0000-4000-8000-000000000001@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1190000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1190000-0000-4000-8000-000000000002@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1190000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1190000-0000-4000-8000-000000000003@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1190000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1190000-0000-4000-8000-000000000004@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now());

-- Seed, as the initial superuser role: four installs and their brew rows.
insert into public.global_stats
  (user_id, brewing_method, recipe_id, water_amount, created_at, country_code)
values
  ('c1190000-0000-4000-8000-000000000001', 'V60', 'f19-recipe', 250,
   '2001-01-01 11:59:55+00', 'FI'),
  ('c1190000-0000-4000-8000-000000000002', 'Espresso', 'f19-recipe', 36,
   '2001-01-01 12:00:00+00', 'DE'),
  ('c1190000-0000-4000-8000-000000000003', 'Aeropress', 'f19-recipe', 220,
   '2001-01-01 12:00:05+00', 'JP'),
  ('c1190000-0000-4000-8000-000000000004', 'Chemex', 'f19-recipe', 500,
   '2001-01-01 12:00:10+00', 'BR');

-- 1) End-state privileges, as the superuser before any role switch.
select pg_temp.assert(
  not has_table_privilege('anon', 'public.global_stats', 'select'),
  'anon has no table-level SELECT on global_stats');
select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.global_stats', 'select'),
  'authenticated has no table-level SELECT on global_stats');
select pg_temp.assert(
  not has_column_privilege('anon', 'public.global_stats', 'user_id', 'select'),
  'anon cannot select global_stats.user_id');
select pg_temp.assert(
  not has_column_privilege('authenticated', 'public.global_stats', 'user_id', 'select'),
  'authenticated cannot select global_stats.user_id');
select pg_temp.assert(
  has_column_privilege('anon', 'public.global_stats', 'id', 'select') and
  has_column_privilege('anon', 'public.global_stats', 'brewing_method', 'select') and
  has_column_privilege('anon', 'public.global_stats', 'recipe_id', 'select') and
  has_column_privilege('anon', 'public.global_stats', 'water_amount', 'select') and
  has_column_privilege('anon', 'public.global_stats', 'created_at', 'select') and
  has_column_privilege('anon', 'public.global_stats', 'country_code', 'select'),
  'anon can select the six non-user_id columns');
select pg_temp.assert(
  has_column_privilege('authenticated', 'public.global_stats', 'id', 'select') and
  has_column_privilege('authenticated', 'public.global_stats', 'brewing_method', 'select') and
  has_column_privilege('authenticated', 'public.global_stats', 'recipe_id', 'select') and
  has_column_privilege('authenticated', 'public.global_stats', 'water_amount', 'select') and
  has_column_privilege('authenticated', 'public.global_stats', 'created_at', 'select') and
  has_column_privilege('authenticated', 'public.global_stats', 'country_code', 'select'),
  'authenticated can select the six non-user_id columns');
select pg_temp.assert(
  has_column_privilege('service_role', 'public.global_stats', 'user_id', 'select'),
  'service_role can select global_stats.user_id');

-- 2) Reading user_id is denied, by every route, for both client roles.
-- (PERFORM is PL/pgSQL's SELECT without a destination; the permission check
-- on the referenced column fires before any rows are scanned.)

reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  perform user_id from public.global_stats;
  raise exception 'expected failure: anon selects user_id';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform * from public.global_stats;
  raise exception 'expected failure: anon selects *';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform 1 from public.global_stats
  where user_id = 'c1190000-0000-4000-8000-000000000002';
  raise exception 'expected failure: anon filters on user_id';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform 1 from public.global_stats order by user_id;
  raise exception 'expected failure: anon orders by user_id';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform g from public.global_stats g;
  raise exception 'expected failure: anon selects the whole row';
exception when insufficient_privilege then
  null;
end $$;

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1190000-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
begin
  perform user_id from public.global_stats;
  raise exception 'expected failure: authenticated selects user_id';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform * from public.global_stats;
  raise exception 'expected failure: authenticated selects *';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform 1 from public.global_stats
  where user_id = 'c1190000-0000-4000-8000-000000000002';
  raise exception 'expected failure: authenticated filters on user_id';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform 1 from public.global_stats order by user_id;
  raise exception 'expected failure: authenticated orders by user_id';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform g from public.global_stats g;
  raise exception 'expected failure: authenticated selects the whole row';
exception when insufficient_privilege then
  null;
end $$;

-- 3) The non-user_id columns stay readable, and both client roles see the
-- seeded rows.
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select pg_temp.assert(
  (select count(*) = 4 from public.global_stats where recipe_id = 'f19-recipe'),
  'anon sees the four seeded rows via count(*)');
select pg_temp.assert(
  (select count(*) = 4 from
    (select recipe_id, created_at, water_amount, country_code
     from public.global_stats where recipe_id = 'f19-recipe') allowed),
  'anon reads recipe_id/created_at/water_amount/country_code');
select pg_temp.assert(
  (select count(*) = 4 from
    (select id, recipe_id, created_at, water_amount, country_code
     from public.global_stats where recipe_id = 'f19-recipe') allowed),
  'anon reads id/recipe_id/created_at/water_amount/country_code');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1190000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 4 from public.global_stats where recipe_id = 'f19-recipe'),
  'authenticated sees the four seeded rows via count(*)');
select pg_temp.assert(
  (select count(*) = 4 from
    (select recipe_id, created_at, water_amount, country_code
     from public.global_stats where recipe_id = 'f19-recipe') allowed),
  'authenticated reads recipe_id/created_at/water_amount/country_code');
select pg_temp.assert(
  (select count(*) = 4 from
    (select id, recipe_id, created_at, water_amount, country_code
     from public.global_stats where recipe_id = 'f19-recipe') allowed),
  'authenticated reads id/recipe_id/created_at/water_amount/country_code');

-- 4) Brew recording as authenticated user 1, in PostgREST's real statement
-- shape (Prefer: return=minimal compiles to a constant RETURNING, which
-- needs no column privileges). The app sends this exact shape on every brew.
WITH pgrst_source AS (
  INSERT INTO "public"."global_stats"("brewing_method","country_code","recipe_id","user_id","water_amount")
  SELECT b."brewing_method", b."country_code", b."recipe_id", b."user_id", b."water_amount"
  FROM (SELECT '{"brewing_method":"V60","country_code":"US","recipe_id":"f19-recipe","user_id":"c1190000-0000-4000-8000-000000000001","water_amount":250}'::json AS json_data) p,
       LATERAL (SELECT "brewing_method","country_code","recipe_id","user_id","water_amount"
                FROM json_to_record(p.json_data) AS _("brewing_method" varchar,"country_code" char(2),"recipe_id" varchar,"user_id" uuid,"water_amount" double precision)) b
  RETURNING 1)
SELECT pg_temp.assert((SELECT count(*) FROM pgrst_source) = 1,
  'authenticated records a brew (PostgREST shape, with country_code)');

-- The app also sends the form without country_code.
WITH pgrst_source AS (
  INSERT INTO "public"."global_stats"("brewing_method","recipe_id","user_id","water_amount")
  SELECT b."brewing_method", b."recipe_id", b."user_id", b."water_amount"
  FROM (SELECT '{"brewing_method":"Aeropress","recipe_id":"f19-recipe","user_id":"c1190000-0000-4000-8000-000000000001","water_amount":220}'::json AS json_data) p,
       LATERAL (SELECT "brewing_method","recipe_id","user_id","water_amount"
                FROM json_to_record(p.json_data) AS _("brewing_method" varchar,"recipe_id" varchar,"user_id" uuid,"water_amount" double precision)) b
  RETURNING 1)
SELECT pg_temp.assert((SELECT count(*) FROM pgrst_source) = 1,
  'authenticated records a brew (PostgREST shape, without country_code)');

-- 5) Ownership is still enforced: authenticated cannot record a brew for
-- another user, and anon cannot record one at all (an RLS violation and a
-- missing policy both raise 42501 insufficient_privilege).
do $$
begin
  insert into public.global_stats (brewing_method, recipe_id, water_amount, user_id)
  values ('V60', 'f19-recipe', 250, 'c1190000-0000-4000-8000-000000000002');
  raise exception 'expected failure: authenticated inserts another user''s user_id';
exception when insufficient_privilege then
  null;
end $$;

reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  insert into public.global_stats (brewing_method, recipe_id, water_amount, user_id)
  values ('V60', 'f19-recipe', 250, 'c1190000-0000-4000-8000-000000000001');
  raise exception 'expected failure: anon inserts a brew';
exception when insufficient_privilege then
  null;
end $$;

-- 6) Documented hazard: RETURNING user_id needs SELECT on user_id, which
-- client roles no longer have. This is why the app must not chain .select()
-- on the global_stats insert: every brew would fail and only be logged
-- locally by the app.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1190000-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
declare
  leaked_user_id uuid;
begin
  insert into public.global_stats (brewing_method, recipe_id, water_amount, user_id)
  values ('V60', 'f19-recipe', 250, 'c1190000-0000-4000-8000-000000000001')
  returning user_id into leaked_user_id;
  raise exception 'expected failure: insert with returning user_id';
exception when insufficient_privilege then
  null;
end $$;

-- 7) service_role keeps full access to user_id.
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert(
  (select count(*) >= 3 from public.global_stats
   where user_id = 'c1190000-0000-4000-8000-000000000001'),
  'service_role can select global_stats.user_id');

do $$
declare
  updated integer;
begin
  update public.global_stats
  set user_id = 'c1190000-0000-4000-8000-000000000001'
  where user_id = 'c1190000-0000-4000-8000-000000000001'
    and recipe_id = 'f19-recipe';
  get diagnostics updated = row_count;
  if updated < 3 then
    raise exception 'Assertion failed: service_role can update user_id';
  end if;
end $$;

-- 8) The finish-screen peer read still resolves through its
-- security-definer RPC (user 1 sees the three other installs; nothing else
-- falls inside the 2001 window this test seeds).
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1190000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert(
  (select peer_count = 3 from public.get_brew_peers(
     '2001-01-01 11:59:50+00', '2001-01-01 12:00:30+00')),
  'get_brew_peers returns the three other installs as peers');

select pg_temp.assert(
  (select p.prosecdef
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_brew_peers'),
  'get_brew_peers is security definer');

select pg_temp.assert(
  (select p.prosecdef
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'aggregate_coffee_volume'),
  'aggregate_coffee_volume is security definer');

-- 9) As the superuser: the app-facing INSERT policy remains.
reset role;
reset request.jwt.claims;

select pg_temp.assert(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'global_stats'
            and policyname = 'Enable insert for authenticated users only'
            and cmd = 'INSERT'),
  'global_stats INSERT policy remains');

rollback;
