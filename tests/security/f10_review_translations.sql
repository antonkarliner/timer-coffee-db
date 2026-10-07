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
  ('c1100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1100000-0000-4000-8000-000000000001@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1100000-0000-4000-8000-000000000002@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now());

-- roaster_profile_id is nullable; empty roaster_name avoids linking fixtures.
insert into public.bean_reviews (id, user_id, bean_name, rating, roaster_name, is_public)
values
  ('c1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000001', 'F10 private bean', 4, '', false),
  ('c1100000-0000-4000-8000-000000000004', 'c1100000-0000-4000-8000-000000000001', 'F10 public bean', 4, '', true);

insert into public.bean_review_translations
  (review_id, target_locale, source_locale, translated_text, model, translated_bean_name)
values
  ('c1100000-0000-4000-8000-000000000003', 'fr', 'en', 'F10 private translation', 'security-test', 'F10 private translated bean'),
  ('c1100000-0000-4000-8000-000000000004', 'fr', 'en', 'F10 public translation', 'security-test', 'F10 public translated bean');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1100000-0000-4000-8000-000000000002","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 1 from public.bean_review_translations
   where review_id in ('c1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000004')),
  'B lists only the public review translation');
select pg_temp.assert(
  (select count(*) = 1 from public.bean_review_translations
   where review_id = 'c1100000-0000-4000-8000-000000000004'
     and translated_text = 'F10 public translation'
     and translated_bean_name = 'F10 public translated bean'),
  'B can read public translated text and bean name');
select pg_temp.assert(
  (select count(*) = 0 from public.bean_review_translations
   where review_id = 'c1100000-0000-4000-8000-000000000003'),
  'B direct private review lookup returns no rows');
select pg_temp.assert(
  (select count(translated_bean_name) = 0 from public.bean_review_translations
   where review_id = 'c1100000-0000-4000-8000-000000000003'),
  'B cannot read the private translated bean name');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1100000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 2 from public.bean_review_translations
   where review_id in ('c1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000004')),
  'A sees both their private and public translations');
select pg_temp.assert(
  (select count(*) = 0 from public.bean_reviews where id = 'c1100000-0000-4000-8000-000000000003'),
  'owner private translation access works despite parent SELECT RLS');

reset role;

update public.bean_reviews set is_public = false where id = 'c1100000-0000-4000-8000-000000000004';
select pg_temp.assert(
  (select count(*) = 2 from public.bean_review_translations
   where review_id in ('c1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000004')),
  'visibility change leaves both cached translations intact');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1100000-0000-4000-8000-000000000002","role":"authenticated"}';

select pg_temp.assert(
  (select count(*) = 0 from public.bean_review_translations where review_id = 'c1100000-0000-4000-8000-000000000004'),
  'B immediately loses access after public review becomes private');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1100000-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
begin
  insert into public.bean_review_translations
    (review_id, target_locale, source_locale, translated_text, model)
  values ('c1100000-0000-4000-8000-000000000003', 'de', 'en', 'F10 denied translation', 'security-test');
  raise exception 'expected failure: A inserts cached translation';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  update public.bean_review_translations set translated_text = 'F10 denied update'
  where review_id = 'c1100000-0000-4000-8000-000000000003';
  raise exception 'expected failure: A updates cached translation';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  delete from public.bean_review_translations
  where review_id = 'c1100000-0000-4000-8000-000000000003';
  raise exception 'expected failure: A deletes cached translation';
exception when insufficient_privilege then
  null;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1100000-0000-4000-8000-000000000002","role":"authenticated"}';

do $$
begin
  insert into public.bean_review_translations
    (review_id, target_locale, source_locale, translated_text, model)
  values ('c1100000-0000-4000-8000-000000000003', 'de', 'en', 'F10 denied translation', 'security-test');
  raise exception 'expected failure: B inserts cached translation';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  update public.bean_review_translations set translated_text = 'F10 denied update'
  where review_id = 'c1100000-0000-4000-8000-000000000003';
  raise exception 'expected failure: B updates cached translation';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  delete from public.bean_review_translations
  where review_id = 'c1100000-0000-4000-8000-000000000003';
  raise exception 'expected failure: B deletes cached translation';
exception when insufficient_privilege then
  null;
end $$;

reset role;

select pg_temp.assert(
  not has_function_privilege('anon', 'public.can_read_bean_review_translation(uuid)', 'execute'),
  'anon cannot execute translation visibility helper');
select pg_temp.assert(
  has_function_privilege('authenticated', 'public.can_read_bean_review_translation(uuid)', 'execute'),
  'authenticated can execute translation visibility helper');
select pg_temp.assert(
  has_function_privilege('service_role', 'public.can_read_bean_review_translation(uuid)', 'execute'),
  'service_role can execute translation visibility helper');
select pg_temp.assert(
  has_function_privilege('postgres', 'public.can_read_bean_review_translation(uuid)', 'execute'),
  'postgres can execute translation visibility helper');
select pg_temp.assert(
  (select p.prosecdef and p.proconfig = array['search_path=""']::text[]
   from pg_proc p
   where p.oid = 'public.can_read_bean_review_translation(uuid)'::regprocedure),
  'translation visibility helper is SECURITY DEFINER with empty search_path');

select pg_temp.assert(
  has_table_privilege('authenticated', 'public.bean_review_translations', 'select'),
  'authenticated retains translation SELECT privilege');
select pg_temp.assert(
  has_table_privilege('anon', 'public.bean_review_translations', 'select'),
  'anon SELECT grant is unchanged');
select pg_temp.assert(
  not has_table_privilege('anon', 'public.bean_review_translations', 'insert'),
  'anon has no translation INSERT privilege');
select pg_temp.assert(
  not has_table_privilege('anon', 'public.bean_review_translations', 'update'),
  'anon has no translation UPDATE privilege');
select pg_temp.assert(
  not has_table_privilege('anon', 'public.bean_review_translations', 'delete'),
  'anon has no translation DELETE privilege');
select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.bean_review_translations', 'insert'),
  'authenticated has no translation INSERT privilege');
select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.bean_review_translations', 'update'),
  'authenticated has no translation UPDATE privilege');
select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.bean_review_translations', 'delete'),
  'authenticated has no translation DELETE privilege');
select pg_temp.assert(
  has_table_privilege('service_role', 'public.bean_review_translations', 'select'),
  'service_role retains translation SELECT privilege');
select pg_temp.assert(
  has_table_privilege('service_role', 'public.bean_review_translations', 'insert'),
  'service_role retains translation INSERT privilege');
select pg_temp.assert(
  has_table_privilege('service_role', 'public.bean_review_translations', 'update'),
  'service_role retains translation UPDATE privilege');
select pg_temp.assert(
  has_table_privilege('service_role', 'public.bean_review_translations', 'delete'),
  'service_role retains translation DELETE privilege');

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select pg_temp.assert(
  (select count(*) = 0 from public.bean_review_translations
   where review_id in ('c1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000004')),
  'anon reads no cached translations');

reset role;
rollback;
