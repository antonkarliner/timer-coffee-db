\set ON_ERROR_STOP on
begin;

create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if;
end
$$;

insert into auth.users (id, instance_id, aud, role, email, is_anonymous,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'f01-source@example.invalid', true, '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'f01-destination@example.invalid', false, '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'f01-other@example.invalid', false, '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.brewing_methods (brewing_method_id, brewing_method, show_on_main)
  values ('f01-test', 'F01 synthetic method', false);
insert into public.supported_locales (locale, locale_name)
  values ('en', 'English') on conflict (locale) do nothing;
insert into public.global_stats (user_id, recipe_id, water_amount)
  values ('11111111-1111-4111-8111-111111111111', 'usr-11111111-1111-4111-8111-111111111111-one', 250);
insert into public.parse_coffee_label_invocations (user_id, tokens_used)
  values ('11111111-1111-4111-8111-111111111111', 10);
insert into public.user_recipes (id, vendor_id, brewing_method_id,
  coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
values
  ('usr-11111111-1111-4111-8111-111111111111-one', 'usr-11111111-1111-4111-8111-111111111111', 'f01-test', 15, 250, 95, 180, false, false),
  ('usr-11111111-1111-4111-8111-111111111111-two', 'usr-11111111-1111-4111-8111-111111111111', 'f01-test', 15, 250, 95, 180, false, false),
  ('usr-11111111-1111-4111-8111-111111111111-collision', 'usr-11111111-1111-4111-8111-111111111111', 'f01-test', 15, 250, 95, 180, false, false),
  ('usr-22222222-2222-4222-8222-222222222222-collision', 'usr-22222222-2222-4222-8222-222222222222', 'f01-test', 20, 300, 90, 200, false, false);
insert into public.user_recipe_localizations (id, recipe_id, locale, name, grind_size, short_description)
values
  ('f01-loc-one', 'usr-11111111-1111-4111-8111-111111111111-one', 'en', 'Source one', 'Medium', 'Synthetic recipe'),
  ('f01-loc-two', 'usr-11111111-1111-4111-8111-111111111111-two', 'en', 'Source two', 'Medium', 'Synthetic recipe'),
  ('f01-loc-collision', 'usr-11111111-1111-4111-8111-111111111111-collision', 'en', 'Source collision', 'Medium', 'Synthetic recipe');
insert into public.user_steps (id, recipe_id, step_order, description, time, locale)
values
  ('f01-step-one', 'usr-11111111-1111-4111-8111-111111111111-one', 1, 'Pour', '30', 'en'),
  ('f01-step-two', 'usr-11111111-1111-4111-8111-111111111111-two', 1, 'Pour', '30', 'en'),
  ('f01-step-collision', 'usr-11111111-1111-4111-8111-111111111111-collision', 1, 'Pour', '30', 'en');
insert into service.user_fcm_tokens (id, user_id, token, device_type, locale)
  values ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'f01-synthetic-token', 'ios', 'en');

set local role service_role;
do $$
declare
  result jsonb;
  retry jsonb;
  expected jsonb := '{"global_stats":1,"label_invocations":1,"recipes":2,"recipe_localizations":2,"recipe_steps":2,"fcm_tokens":1,"bean_reviews":0,"bean_reviews_dropped_duplicates":0,"review_replies":0,"notifications":0}'::jsonb;
begin
  result := service.migrate_anonymous_account_data('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  perform pg_temp.assert(result = jsonb_build_object('status', 'data_migrated', 'already', false, 'moved', expected), 'RPC result and counts');
  perform pg_temp.assert((select count(*) = 1 from public.global_stats where user_id = '22222222-2222-4222-8222-222222222222' and recipe_id = 'usr-11111111-1111-4111-8111-111111111111-one'), 'stats owner moved, recipe ID unchanged for parity');
  perform pg_temp.assert((select count(*) = 0 from public.global_stats where user_id = '11111111-1111-4111-8111-111111111111'), 'source stats cleared');
  perform pg_temp.assert((select count(*) = 1 from public.parse_coffee_label_invocations where user_id = '22222222-2222-4222-8222-222222222222'), 'label invocation moved');
  perform pg_temp.assert((select count(*) = 0 from public.parse_coffee_label_invocations where user_id = '11111111-1111-4111-8111-111111111111'), 'source invocations cleared');
  perform pg_temp.assert((select count(*) = 2 from public.user_recipes where vendor_id = 'usr-22222222-2222-4222-8222-222222222222' and id in ('usr-22222222-2222-4222-8222-222222222222-one', 'usr-22222222-2222-4222-8222-222222222222-two')), 'parents renamed with matching vendor');
  perform pg_temp.assert((select count(*) = 0 from public.user_recipes where id in ('usr-11111111-1111-4111-8111-111111111111-one', 'usr-11111111-1111-4111-8111-111111111111-two')), 'old parent IDs gone');
  perform pg_temp.assert((select count(*) = 2 from public.user_recipe_localizations where (id = 'f01-loc-one' and recipe_id = 'usr-22222222-2222-4222-8222-222222222222-one') or (id = 'f01-loc-two' and recipe_id = 'usr-22222222-2222-4222-8222-222222222222-two')), 'localization FKs renamed');
  perform pg_temp.assert((select count(*) = 2 from public.user_steps where (id = 'f01-step-one' and recipe_id = 'usr-22222222-2222-4222-8222-222222222222-one') or (id = 'f01-step-two' and recipe_id = 'usr-22222222-2222-4222-8222-222222222222-two')), 'step FKs renamed');
  perform pg_temp.assert((select count(*) = 1 from public.user_recipes where id = 'usr-11111111-1111-4111-8111-111111111111-collision' and vendor_id = 'usr-11111111-1111-4111-8111-111111111111' and coffee_amount = 15), 'collision source remains untouched');
  perform pg_temp.assert((select count(*) = 1 from public.user_recipes where id = 'usr-22222222-2222-4222-8222-222222222222-collision' and vendor_id = 'usr-22222222-2222-4222-8222-222222222222' and coffee_amount = 20), 'collision destination remains untouched');
  perform pg_temp.assert((select recipe_id = 'usr-11111111-1111-4111-8111-111111111111-collision' from public.user_recipe_localizations where id = 'f01-loc-collision'), 'collision localization untouched');
  perform pg_temp.assert((select recipe_id = 'usr-11111111-1111-4111-8111-111111111111-collision' from public.user_steps where id = 'f01-step-collision'), 'collision step untouched');
  perform pg_temp.assert((select user_id = '22222222-2222-4222-8222-222222222222' and token = 'f01-synthetic-token' from service.user_fcm_tokens where id = '44444444-4444-4444-8444-444444444444'), 'FCM token moved');
  perform pg_temp.assert((select destination_user_id = '22222222-2222-4222-8222-222222222222' and status = 'data_migrated' and moved = expected and completed_at is null from service.anonymous_account_migrations where source_user_id = '11111111-1111-4111-8111-111111111111'), 'ledger claim and counts');
  retry := service.migrate_anonymous_account_data('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  perform pg_temp.assert(retry = jsonb_build_object('status', 'data_migrated', 'already', true, 'moved', expected), 'resumed retry moves nothing new and keeps the stored counts');
  perform pg_temp.assert((select count(*) = 3 from public.user_recipes where vendor_id = 'usr-22222222-2222-4222-8222-222222222222'), 'retry leaves destination recipe count unchanged');
  perform pg_temp.assert((select count(*) = 1 from public.user_recipes where vendor_id = 'usr-11111111-1111-4111-8111-111111111111'), 'retry leaves collision at source');
end
$$;

do $$ begin
  perform service.migrate_anonymous_account_data('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333');
  raise exception 'expected failure: different destination';
exception when sqlstate 'PT409' then null;
end $$;
do $$ begin
  perform service.migrate_anonymous_account_data(null, '22222222-2222-4222-8222-222222222222');
  raise exception 'expected failure: null source';
exception when invalid_parameter_value then null;
end $$;
do $$ begin
  perform service.migrate_anonymous_account_data('11111111-1111-4111-8111-111111111111', null);
  raise exception 'expected failure: null destination';
exception when invalid_parameter_value then null;
end $$;
do $$ begin
  perform service.migrate_anonymous_account_data('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');
  raise exception 'expected failure: equal users';
exception when invalid_parameter_value then null;
end $$;
select pg_temp.assert(not service.complete_anonymous_account_migration('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'), 'wrong destination cannot complete');
select pg_temp.assert(not service.complete_anonymous_account_migration('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222'), 'missing ledger cannot complete');
select pg_temp.assert(service.complete_anonymous_account_migration('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'), 'completion succeeds');
select pg_temp.assert(service.complete_anonymous_account_migration('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'), 'completion retry succeeds');
select pg_temp.assert((select status = 'completed' and completed_at is not null from service.anonymous_account_migrations where source_user_id = '11111111-1111-4111-8111-111111111111'), 'completed ledger');
select pg_temp.assert(service.migrate_anonymous_account_data('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')->>'status' = 'completed', 'completed retry remains completed');

reset role;
select pg_temp.assert((select relrowsecurity from pg_catalog.pg_class where oid = 'service.anonymous_account_migrations'::regclass), 'ledger RLS enabled');
select pg_temp.assert(not exists (select 1 from pg_catalog.pg_policy where polrelid = 'service.anonymous_account_migrations'::regclass), 'ledger has no policies');
select pg_temp.assert(has_function_privilege('service_role', 'service.migrate_anonymous_account_data(uuid,uuid)', 'execute'), 'service migration execute');
select pg_temp.assert(has_function_privilege('service_role', 'service.complete_anonymous_account_migration(uuid,uuid)', 'execute'), 'service completion execute');
select pg_temp.assert(
  has_table_privilege('service_role', 'service.anonymous_account_migrations', 'select')
  and has_table_privilege('service_role', 'service.anonymous_account_migrations', 'insert')
  and has_table_privilege('service_role', 'service.anonymous_account_migrations', 'update')
  and has_table_privilege('service_role', 'service.anonymous_account_migrations', 'delete'),
  'service ledger CRUD access');

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select pg_temp.assert(not has_function_privilege('authenticated', 'service.migrate_anonymous_account_data(uuid,uuid)', 'execute'), 'authenticated cannot migrate');
select pg_temp.assert(not has_function_privilege('authenticated', 'service.complete_anonymous_account_migration(uuid,uuid)', 'execute'), 'authenticated cannot complete');
select pg_temp.assert(not has_table_privilege('authenticated', 'service.anonymous_account_migrations', 'select'), 'authenticated cannot read ledger');
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select pg_temp.assert(not has_function_privilege('anon', 'service.migrate_anonymous_account_data(uuid,uuid)', 'execute'), 'anon cannot migrate');
select pg_temp.assert(not has_function_privilege('anon', 'service.complete_anonymous_account_migration(uuid,uuid)', 'execute'), 'anon cannot complete');
select pg_temp.assert(not has_table_privilege('anon', 'service.anonymous_account_migrations', 'select'), 'anon cannot read ledger');
reset role;
rollback;
