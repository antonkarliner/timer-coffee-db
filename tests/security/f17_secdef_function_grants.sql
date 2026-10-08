\set ON_ERROR_STOP on

-- Run as postgres against the full local database with all migrations applied:
--   docker exec -i supabase_db_timer-coffee-db psql -U postgres -d postgres < tests/security/f17_secdef_function_grants.sql
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

-- Expected end state for every public SECURITY DEFINER function this plan
-- touched or deliberately left alone. Created and read as postgres only.
create temp table f17_expected on commit drop as
select * from (values
  -- Migration A: cron entrypoints
  ('public.aggregate_notification_analytics_cron()'::regprocedure, false, false, true),
  ('public.check_new_version_cron()'::regprocedure, false, false, true),
  ('public.cron_refresh_global_stats_daily()'::regprocedure, false, false, true),
  ('public.cron_refresh_global_stats_hourly()'::regprocedure, false, false, true),
  ('public.normalize_bean_origins_cron()'::regprocedure, false, false, true),
  ('public.process_app_release_notifications_cron()'::regprocedure, false, false, true),
  ('public.process_live_activity_events_cron()'::regprocedure, false, false, true),
  ('public.process_scheduled_notifications_cron()'::regprocedure, false, false, true),
  ('public.roaster_enrichment_worker_cron()'::regprocedure, false, false, true),
  ('public.token_cleanup_cron()'::regprocedure, false, false, true),
  -- Migration A: trigger functions
  ('public.aggregate_coffee_volume()'::regprocedure, false, false, true),
  ('public.attach_pending_global_beans()'::regprocedure, false, false, true),
  ('public.check_new_roaster_webhook()'::regprocedure, false, false, true),
  ('public.create_roaster_profile_on_insert()'::regprocedure, false, false, true),
  ('public.enqueue_roaster_dominant_color_generation()'::regprocedure, false, false, true),
  ('public.enqueue_roaster_logo_mirror()'::regprocedure, false, false, true),
  ('public.invalidate_bean_review_translations()'::regprocedure, false, false, true),
  ('public.link_bean_review_to_roaster_profile()'::regprocedure, false, false, true),
  ('public.link_global_bean_to_coffee_roaster()'::regprocedure, false, false, true),
  ('public.link_pending_bean_reviews()'::regprocedure, false, false, true),
  ('public.sync_roaster_profile_on_update()'::regprocedure, false, false, true),
  -- Migration B: service-only RPCs
  ('public.get_unnormalized_bean_origins(integer)'::regprocedure, false, false, true),
  ('public.refresh_yearly_user_liters(integer)'::regprocedure, false, false, true),
  ('public.get_user_recipe_import_counts(text[])'::regprocedure, false, false, true),
  ('public.global_stats_daily_range_sum(date, date)'::regprocedure, false, false, true),
  ('public.global_stats_range_count(date, date)'::regprocedure, false, false, true),
  ('public.global_stats_hourly_range_summary(timestamp with time zone, timestamp with time zone)'::regprocedure, false, false, true),
  ('public.get_roaster_profile_by_name(text)'::regprocedure, false, false, true),
  ('public.search_roaster_unaccent(text)'::regprocedure, false, false, true),
  -- Migration C: admin RPCs
  ('public.admin_connection_analytics(integer)'::regprocedure, false, true, true),
  ('public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text)'::regprocedure, false, true, true),
  ('public.admin_lookup_assignable_user_by_email(text)'::regprocedure, false, true, true),
  ('public.admin_notification_analytics()'::regprocedure, false, true, true),
  ('public.admin_notification_health_metrics()'::regprocedure, false, true, true),
  ('public.admin_search_roaster_profiles(text, integer)'::regprocedure, false, true, true),
  ('public.admin_set_roaster_profile_owner(uuid, uuid)'::regprocedure, false, true, true),
  ('public.estimate_broadcast_reach(jsonb, text, uuid[])'::regprocedure, false, true, true),
  -- Migration D: signed-in RPCs
  ('public.get_my_roaster_profile()'::regprocedure, false, true, true),
  ('public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text)'::regprocedure, false, true, true),
  ('public.log_recipe_import(text)'::regprocedure, false, true, true),
  ('public.log_connection_endpoint(text, text)'::regprocedure, false, true, true),
  ('public.increment_likes()'::regprocedure, false, true, true),
  ('public.roaster_contribution_target(text)'::regprocedure, false, true, true),
  ('public.can_access_user_recipe(text, text)'::regprocedure, false, true, true),
  -- Migration E: yearly recap RPCs
  ('public.pick_yearly_wish(uuid, text)'::regprocedure, false, true, true),
  ('public.yearly_user_liters_percentile(integer, uuid, double precision)'::regprocedure, false, true, true),
  -- Not touched: newsletter capability tokens (anon + service_role only)
  ('public.confirm_subscription(uuid)'::regprocedure, true, false, true),
  ('public.unsubscribe_subscriber(uuid)'::regprocedure, true, false, true),
  -- Not touched: RLS qual on TO public policies, and the public directory / stats
  ('public.is_admin()'::regprocedure, true, true, true),
  ('public.get_launch_popup(text, text, text, text)'::regprocedure, true, true, true),
  ('public.list_roaster_profiles(text, text, integer, integer)'::regprocedure, true, true, true),
  ('public.get_roaster_countries()'::regprocedure, true, true, true),
  ('public.get_roaster_profile(text)'::regprocedure, true, true, true),
  ('public.get_roaster_rating_summary(uuid)'::regprocedure, true, true, true),
  ('public.get_roaster_recipes(uuid, text)'::regprocedure, true, true, true),
  ('public.get_roaster_review_facets(text)'::regprocedure, true, true, true),
  ('public.get_roaster_reviews(uuid, integer, integer)'::regprocedure, true, true, true),
  ('public.get_roaster_reviews_by_slug(text, integer, integer)'::regprocedure, true, true, true),
  ('public.get_roaster_bundle_by_name(text)'::regprocedure, true, true, true),
  ('public.get_roaster_profile_by_vendor_id(text)'::regprocedure, true, true, true),
  ('public.global_stats_daily_range_count(date, date)'::regprocedure, true, true, true),
  ('public.global_stats_live_summary(timestamp with time zone, integer)'::regprocedure, true, true, true),
  ('public.global_stats_range_sum(date, date)'::regprocedure, true, true, true),
  ('public.global_stats_top_recipes(date, date, integer)'::regprocedure, true, true, true),
  -- Not touched: authenticated-only already
  ('public.can_read_bean_review_translation(uuid)'::regprocedure, false, true, true),
  ('public.get_brew_peers(timestamp with time zone, timestamp with time zone)'::regprocedure, false, true, true),
  ('public.get_my_contribution_acknowledgements(integer)'::regprocedure, false, true, true),
  ('public.mark_contribution_acknowledged(bigint, text)'::regprocedure, false, true, true)
) as t(fn, want_anon, want_authenticated, want_service_role);

-- 1. Privilege matrix: one check per function and role, so a failure names both.
do $$
declare
  r record;
begin
  for r in select fn, want_anon, want_authenticated, want_service_role from f17_expected loop
    if has_function_privilege('anon', r.fn, 'execute') is distinct from r.want_anon then
      raise exception 'Assertion failed: anon execute on % should be %', r.fn, r.want_anon;
    end if;
    if has_function_privilege('authenticated', r.fn, 'execute') is distinct from r.want_authenticated then
      raise exception 'Assertion failed: authenticated execute on % should be %', r.fn, r.want_authenticated;
    end if;
    if has_function_privilege('service_role', r.fn, 'execute') is distinct from r.want_service_role then
      raise exception 'Assertion failed: service_role execute on % should be %', r.fn, r.want_service_role;
    end if;
    if has_function_privilege('postgres', r.fn, 'execute') is distinct from true then
      raise exception 'Assertion failed: postgres execute on % should be true', r.fn;
    end if;
  end loop;
end $$;

-- 2. Drift guard: no other public SECURITY DEFINER function is executable by
--    anon or authenticated. A new function that is not in the matrix fails here.
do $$
declare
  v_offenders text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
  into v_offenders
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
    and has_function_privilege('anon', p.oid, 'execute')
    and p.oid not in (select e.fn::oid from f17_expected e where e.want_anon);
  if v_offenders is not null then
    raise exception 'Assertion failed: anon can execute SECURITY DEFINER functions outside the allowlist: %', v_offenders;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
  into v_offenders
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'execute')
    and p.oid not in (select e.fn::oid from f17_expected e where e.want_authenticated);
  if v_offenders is not null then
    raise exception 'Assertion failed: authenticated can execute SECURITY DEFINER functions outside the allowlist: %', v_offenders;
  end if;
end $$;

-- Fixtures (as postgres).
insert into auth.users (id, instance_id, aud, role, email, is_anonymous,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('c1170000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1170000-0000-4000-8000-000000000001@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c1170000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c1170000-0000-4000-8000-000000000002@example.invalid', false,
   '{}'::jsonb, '{}'::jsonb, now(), now());

-- Satisfy the recipe FK without relying on reference-table seed data.
insert into public.brewing_methods (brewing_method_id, brewing_method, show_on_main)
values ('f17-test', 'F17 synthetic brewing method', false);

-- Two recipes owned by B: one public, one private. vendor_id is
-- 'usr-' || <owner uuid> and the id must start with vendor_id || '-'.
insert into public.user_recipes
  (id, vendor_id, brewing_method_id, coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
values
  ('usr-c1170000-0000-4000-8000-000000000002-pub', 'usr-c1170000-0000-4000-8000-000000000002',
   'f17-test', 15, 250, 93, 180, true, false),
  ('usr-c1170000-0000-4000-8000-000000000002-priv', 'usr-c1170000-0000-4000-8000-000000000002',
   'f17-test', 15, 250, 93, 180, false, false);

-- A row the is_admin() policy must actually judge: against an empty table the
-- qual is never evaluated and the anon check below would pass vacuously.
insert into service.cleanup_logs (action, records_affected, details)
values ('f17_security_test', 0, '{}'::jsonb);

-- 3. Behaviour as anon.
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $$
begin
  perform public.token_cleanup_cron();
  raise exception 'expected failure: anon runs token_cleanup_cron';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform public.admin_connection_analytics(30);
  raise exception 'expected failure: anon runs admin_connection_analytics';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform public.get_unnormalized_bean_origins(10);
  raise exception 'expected failure: anon runs get_unnormalized_bean_origins';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform public.log_connection_endpoint('direct', 'ios');
  raise exception 'expected failure: anon runs log_connection_endpoint';
exception when insufficient_privilege then
  null;
end $$;

-- The nested call to the now service-only global_stats_hourly_range_summary runs
-- as the SECURITY DEFINER owner, so the public summary keeps working for anon.
select pg_temp.assert(
  (select count(*) = 8 from public.global_stats_live_summary(now(), 0)),
  'anon global_stats_live_summary still returns 8 rows');

-- Nested call to another public function.
do $$
begin
  perform public.get_roaster_reviews_by_slug('no-such-slug-f17', 0, 5);
end $$;

-- is_admin() is still executable for anon, so service-table RLS quals evaluate.
do $$
declare
  v_visible bigint;
begin
  select count(*) into v_visible from service.cleanup_logs where action = 'f17_security_test';
  if v_visible <> 0 then
    raise exception 'Assertion failed: anon sees % admin-only cleanup_logs rows', v_visible;
  end if;
exception when insufficient_privilege then
  raise exception 'Assertion failed: anon cannot read service.cleanup_logs through is_admin(): %', sqlerrm;
end $$;

reset role;

-- 4. Behaviour as non-admin authenticated user A.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1170000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The grant is kept, so this reaches the body and fails its internal check.
do $$
begin
  perform public.admin_connection_analytics(30);
  raise exception 'expected failure: non-admin runs admin_connection_analytics';
exception when insufficient_privilege then
  if sqlerrm is distinct from 'forbidden' then
    raise exception 'Assertion failed: expected the internal forbidden check, got: %', sqlerrm;
  end if;
end $$;

do $$
begin
  perform public.token_cleanup_cron();
  raise exception 'expected failure: A runs token_cleanup_cron';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform public.get_user_recipe_import_counts(array['x']);
  raise exception 'expected failure: A runs get_user_recipe_import_counts';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  perform public.log_connection_endpoint('direct', 'ios');
end $$;

-- is_admin() still runs as the RLS qual for authenticated: a non-admin read
-- returns no rows instead of raising 42501.
select pg_temp.assert(
  (select count(*) = 0 from service.cleanup_logs where action = 'f17_security_test'),
  'non-admin A reads service.cleanup_logs through is_admin() and sees nothing');

-- can_access_user_recipe still runs as the RLS qual for authenticated.
select pg_temp.assert(
  (select count(*) = 1 from public.user_recipes
   where id = 'usr-c1170000-0000-4000-8000-000000000002-pub'),
  'A can read the public recipe owned by B');
select pg_temp.assert(
  (select count(*) = 0 from public.user_recipes
   where id = 'usr-c1170000-0000-4000-8000-000000000002-priv'),
  'A cannot read the private recipe owned by B');

reset role;

-- 5. Trigger functions fire without the caller holding EXECUTE.
--    A inserts their own bean review (RLS allows an authenticated own insert);
--    link_bean_review_to_roaster_profile and the other review triggers run
--    although authenticated can no longer execute them. roaster_name = '' avoids
--    linking to any roaster fixture.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1170000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into public.bean_reviews (id, user_id, bean_name, rating, roaster_name, is_public)
values ('c1170000-0000-4000-8000-000000000003', 'c1170000-0000-4000-8000-000000000001',
        'F17 trigger bean', 4, '', false);

reset role;

select pg_temp.assert(
  (select count(*) = 1 from public.bean_reviews
   where id = 'c1170000-0000-4000-8000-000000000003'
     and user_id = 'c1170000-0000-4000-8000-000000000001'),
  'bean review insert succeeded with trigger functions not executable by authenticated');

rollback;
