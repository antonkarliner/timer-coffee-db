\set ON_ERROR_STOP on
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
  ('c1090000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1090000-0000-4000-8000-000000000001@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1090000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1090000-0000-4000-8000-000000000002@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now());

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1090000-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
begin
  insert into public.yearly_wishes (author_user_id, locale, text, status)
  values ('c1090000-0000-4000-8000-000000000001', 'en', 'F09 denied wish', 'approved');
  raise exception 'expected failure: A inserts approved wish';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  insert into public.yearly_wishes (author_user_id, locale, text, status)
  values ('c1090000-0000-4000-8000-000000000001', 'en', 'F09 denied wish', 'rejected');
  raise exception 'expected failure: A inserts rejected wish';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  insert into public.yearly_wishes (author_user_id, locale, text, status)
  values ('c1090000-0000-4000-8000-000000000001', 'en', 'F09 denied wish', 'pending');
  raise exception 'expected failure: A inserts pending wish';
exception when insufficient_privilege then
  null;
end $$;

reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  insert into public.yearly_wishes (author_user_id, locale, text, status)
  values ('c1090000-0000-4000-8000-000000000001', 'en', 'F09 denied anon wish', 'approved');
  raise exception 'expected failure: anon inserts wish';
exception when insufficient_privilege then
  null;
end $$;

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

insert into public.yearly_wishes (id, author_user_id, locale, text, status)
values ('c1090000-0000-4000-8000-000000000003', 'c1090000-0000-4000-8000-000000000001', 'en', 'F09 moderated wish', 'approved');
select pg_temp.assert(
  (select count(*) = 1 from public.yearly_wishes
   where id = 'c1090000-0000-4000-8000-000000000003' and status = 'approved'),
  'service_role can insert an approved wish');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1090000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 1 from public.yearly_wishes where id = 'c1090000-0000-4000-8000-000000000003'),
  'A can select their own wish');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1090000-0000-4000-8000-000000000002","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 0 from public.yearly_wishes where id = 'c1090000-0000-4000-8000-000000000003'),
  'B cannot see A wish');

reset role;

select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.yearly_wishes', 'insert'),
  'authenticated has no wish INSERT privilege');
select pg_temp.assert(
  has_table_privilege('authenticated', 'public.yearly_wishes', 'select'),
  'authenticated retains wish SELECT privilege');
select pg_temp.assert(
  not has_table_privilege('anon', 'public.yearly_wishes', 'insert'),
  'anon has no wish INSERT privilege');
select pg_temp.assert(
  has_table_privilege('service_role', 'public.yearly_wishes', 'insert'),
  'service_role retains wish INSERT privilege');
select pg_temp.assert(
  not exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'yearly_wishes'
                and policyname = 'yearly_wishes_insert_own'),
  'wish INSERT policy is removed');
select pg_temp.assert(
  exists (select 1 from pg_policies
          where schemaname = 'public' and tablename = 'yearly_wishes'
            and policyname = 'yearly_wishes_select_own' and cmd = 'SELECT'),
  'wish owner SELECT policy remains');

rollback;
