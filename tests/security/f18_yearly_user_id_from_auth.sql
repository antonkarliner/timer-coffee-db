\set ON_ERROR_STOP on

-- Run as postgres against the full local database with all migrations applied:
--   docker exec -i supabase_db_timer-coffee-db psql -U postgres -d postgres < tests/security/f18_yearly_user_id_from_auth.sql
-- All fixtures and assertions are rolled back; no real users are used.
begin;

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
  ('c1180000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1180000-0000-4000-8000-000000000001@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1180000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1180000-0000-4000-8000-000000000002@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now());

-- Make the pick deterministic: any other approved wish in the local database is
-- rejected for the duration of this rolled-back transaction.
update public.yearly_wishes set status = 'rejected' where status = 'approved';

-- Two approved wishes authored by B. The newer one (0003) is picked first.
insert into public.yearly_wishes (id, author_user_id, locale, text, status, created_at)
values
  ('c1180000-0000-4000-8000-000000000004', 'c1180000-0000-4000-8000-000000000002',
   'en', 'F18 older wish', 'approved', now() - interval '1 hour'),
  ('c1180000-0000-4000-8000-000000000003', 'c1180000-0000-4000-8000-000000000002',
   'en', 'F18 newer wish', 'approved', now());

insert into public.yearly_user_liters (year, user_id, liters, brews)
values
  (2099, 'c1180000-0000-4000-8000-000000000001', 10, 3),
  (2099, 'c1180000-0000-4000-8000-000000000002', 99, 5);

-- Privileges and function settings.
select pg_temp.assert(
  not has_function_privilege('anon', 'public.pick_yearly_wish(uuid, text)', 'execute'),
  'anon cannot execute pick_yearly_wish');
select pg_temp.assert(
  has_function_privilege('authenticated', 'public.pick_yearly_wish(uuid, text)', 'execute'),
  'authenticated can execute pick_yearly_wish');
select pg_temp.assert(
  has_function_privilege('service_role', 'public.pick_yearly_wish(uuid, text)', 'execute'),
  'service_role can execute pick_yearly_wish');
select pg_temp.assert(
  not has_function_privilege('anon', 'public.yearly_user_liters_percentile(integer, uuid, double precision)', 'execute'),
  'anon cannot execute yearly_user_liters_percentile');
select pg_temp.assert(
  has_function_privilege('authenticated', 'public.yearly_user_liters_percentile(integer, uuid, double precision)', 'execute'),
  'authenticated can execute yearly_user_liters_percentile');
select pg_temp.assert(
  has_function_privilege('service_role', 'public.yearly_user_liters_percentile(integer, uuid, double precision)', 'execute'),
  'service_role can execute yearly_user_liters_percentile');
select pg_temp.assert(
  (select p.prosecdef and p.proconfig = array['search_path=public']::text[]
   from pg_proc p
   where p.oid = 'public.pick_yearly_wish(uuid, text)'::regprocedure),
  'pick_yearly_wish is SECURITY DEFINER with search_path=public');
select pg_temp.assert(
  (select p.prosecdef and p.proconfig = array['search_path=public']::text[]
   from pg_proc p
   where p.oid = 'public.yearly_user_liters_percentile(integer, uuid, double precision)'::regprocedure),
  'yearly_user_liters_percentile is SECURITY DEFINER with search_path=public');

-- The 2-argument overload is gone.
select pg_temp.assert(
  to_regprocedure('public.yearly_user_liters_percentile(integer,uuid)') is null,
  'the 2-argument yearly_user_liters_percentile overload no longer exists');

-- pick_yearly_wish as A, passing A's own id.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1180000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 1 and bool_and(pw.id = 'c1180000-0000-4000-8000-000000000003' and pw.text = 'F18 newer wish')
   from public.pick_yearly_wish('c1180000-0000-4000-8000-000000000001', 'en') as pw),
  'A picks the newest approved wish authored by B');

reset role;

select pg_temp.assert(
  (select count(*) = 1 from public.yearly_wish_deliveries
   where recipient_user_id = 'c1180000-0000-4000-8000-000000000001'),
  'exactly one delivery row recorded for A');
select pg_temp.assert(
  (select count(*) = 0 from public.yearly_wish_deliveries
   where recipient_user_id = 'c1180000-0000-4000-8000-000000000002'),
  'no delivery row recorded for B');

-- A cannot act as B.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1180000-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
begin
  perform * from public.pick_yearly_wish('c1180000-0000-4000-8000-000000000002', 'en');
  raise exception 'expected failure: A picks a wish as B';
exception when insufficient_privilege then
  null;
end $$;

reset role;

select pg_temp.assert(
  (select count(*) = 0 from public.yearly_wish_deliveries
   where recipient_user_id = 'c1180000-0000-4000-8000-000000000002'),
  'still no delivery row for B after A tried to pick as B');

-- A passing a null p_user_id uses auth.uid(); the older wish is still undelivered,
-- and a further call has nothing left to deliver.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1180000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 1 and bool_and(pw.id = 'c1180000-0000-4000-8000-000000000004')
   from public.pick_yearly_wish(null, 'en') as pw),
  'null p_user_id resolves to auth.uid() and delivers the remaining wish');
select pg_temp.assert(
  (select count(*) = 0 from public.pick_yearly_wish(null, 'en')),
  'a further call returns no row once everything is delivered');

reset role;

-- anon is rejected by the grant.
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  perform * from public.pick_yearly_wish('c1180000-0000-4000-8000-000000000001', 'en');
  raise exception 'expected failure: anon picks a wish';
exception when insufficient_privilege then
  null;
end $$;

reset role;

-- service_role has no auth.uid(), so the body rejects it.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
begin
  perform * from public.pick_yearly_wish('c1180000-0000-4000-8000-000000000001', 'en');
  raise exception 'expected failure: service_role picks a wish without auth.uid()';
exception when insufficient_privilege then
  null;
end $$;

reset role;

-- yearly_user_liters_percentile as A.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1180000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 1 and bool_and(liters = 10 and active_users = 2)
   from public.yearly_user_liters_percentile(2099, 'c1180000-0000-4000-8000-000000000001')),
  'A sees their own liters (10) among 2 active users');
select pg_temp.assert(
  (select count(*) = 0
   from public.yearly_user_liters_percentile(2099, 'c1180000-0000-4000-8000-000000000002')),
  'A asking for B returns no rows and never B''s 99 liters');
select pg_temp.assert(
  (select count(*) = 1 and bool_and(liters = 50 and percentile is not null)
   from public.yearly_user_liters_percentile(2099, 'c1180000-0000-4000-8000-000000000001', 50.0)),
  'p_liters override still applies for the caller''s own id');

-- A named 2-argument call, as PostgREST sends when the app omits p_liters,
-- now resolves to the 3-argument overload.
select pg_temp.assert(
  (select count(*) = 1 and bool_and(liters = 10)
   from public.yearly_user_liters_percentile(p_year => 2099, p_user_id => 'c1180000-0000-4000-8000-000000000001')),
  'named 2-argument call resolves and returns the caller''s liters');

reset role;

-- anon is rejected by the grant.
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  perform * from public.yearly_user_liters_percentile(2099, 'c1180000-0000-4000-8000-000000000001');
  raise exception 'expected failure: anon reads yearly percentile';
exception when insufficient_privilege then
  null;
end $$;

reset role;

rollback;
