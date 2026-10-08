-- Security F17 (1 of 5): close SECURITY DEFINER EXECUTE exposure on cron
-- entrypoints and trigger functions in the public schema.
--
-- This project's ALTER DEFAULT PRIVILEGES grant EXECUTE on new functions to the
-- named roles anon, authenticated and service_role, so `revoke ... from public`
-- never removed those. Every function below is revoked by name, one statement
-- per role. End state for all of them: {postgres, service_role}.
--
-- This migration changes no function body, only privileges.

-- Cron entrypoints. pg_cron runs them as postgres; they read Vault secrets and
-- fire paid edge functions via pg_net, so an anon caller holding the publishable
-- key could loop them into spend.

revoke execute on function public.aggregate_notification_analytics_cron() from public;
revoke execute on function public.aggregate_notification_analytics_cron() from anon;
revoke execute on function public.aggregate_notification_analytics_cron() from authenticated;
grant  execute on function public.aggregate_notification_analytics_cron() to service_role;
grant  execute on function public.aggregate_notification_analytics_cron() to postgres;

revoke execute on function public.check_new_version_cron() from public;
revoke execute on function public.check_new_version_cron() from anon;
revoke execute on function public.check_new_version_cron() from authenticated;
grant  execute on function public.check_new_version_cron() to service_role;
grant  execute on function public.check_new_version_cron() to postgres;

revoke execute on function public.cron_refresh_global_stats_daily() from public;
revoke execute on function public.cron_refresh_global_stats_daily() from anon;
revoke execute on function public.cron_refresh_global_stats_daily() from authenticated;
grant  execute on function public.cron_refresh_global_stats_daily() to service_role;
grant  execute on function public.cron_refresh_global_stats_daily() to postgres;

revoke execute on function public.cron_refresh_global_stats_hourly() from public;
revoke execute on function public.cron_refresh_global_stats_hourly() from anon;
revoke execute on function public.cron_refresh_global_stats_hourly() from authenticated;
grant  execute on function public.cron_refresh_global_stats_hourly() to service_role;
grant  execute on function public.cron_refresh_global_stats_hourly() to postgres;

revoke execute on function public.normalize_bean_origins_cron() from public;
revoke execute on function public.normalize_bean_origins_cron() from anon;
revoke execute on function public.normalize_bean_origins_cron() from authenticated;
grant  execute on function public.normalize_bean_origins_cron() to service_role;
grant  execute on function public.normalize_bean_origins_cron() to postgres;

revoke execute on function public.process_app_release_notifications_cron() from public;
revoke execute on function public.process_app_release_notifications_cron() from anon;
revoke execute on function public.process_app_release_notifications_cron() from authenticated;
grant  execute on function public.process_app_release_notifications_cron() to service_role;
grant  execute on function public.process_app_release_notifications_cron() to postgres;

revoke execute on function public.process_live_activity_events_cron() from public;
revoke execute on function public.process_live_activity_events_cron() from anon;
revoke execute on function public.process_live_activity_events_cron() from authenticated;
grant  execute on function public.process_live_activity_events_cron() to service_role;
grant  execute on function public.process_live_activity_events_cron() to postgres;

revoke execute on function public.process_scheduled_notifications_cron() from public;
revoke execute on function public.process_scheduled_notifications_cron() from anon;
revoke execute on function public.process_scheduled_notifications_cron() from authenticated;
grant  execute on function public.process_scheduled_notifications_cron() to service_role;
grant  execute on function public.process_scheduled_notifications_cron() to postgres;

revoke execute on function public.roaster_enrichment_worker_cron() from public;
revoke execute on function public.roaster_enrichment_worker_cron() from anon;
revoke execute on function public.roaster_enrichment_worker_cron() from authenticated;
grant  execute on function public.roaster_enrichment_worker_cron() to service_role;
grant  execute on function public.roaster_enrichment_worker_cron() to postgres;

revoke execute on function public.token_cleanup_cron() from public;
revoke execute on function public.token_cleanup_cron() from anon;
revoke execute on function public.token_cleanup_cron() from authenticated;
grant  execute on function public.token_cleanup_cron() to service_role;
grant  execute on function public.token_cleanup_cron() to postgres;

-- Trigger functions (returns trigger). A firing trigger never checks the
-- caller's EXECUTE privilege, so the grant is unreachable hygiene only (plan 032).

revoke execute on function public.aggregate_coffee_volume() from public;
revoke execute on function public.aggregate_coffee_volume() from anon;
revoke execute on function public.aggregate_coffee_volume() from authenticated;
grant  execute on function public.aggregate_coffee_volume() to service_role;
grant  execute on function public.aggregate_coffee_volume() to postgres;

revoke execute on function public.attach_pending_global_beans() from public;
revoke execute on function public.attach_pending_global_beans() from anon;
revoke execute on function public.attach_pending_global_beans() from authenticated;
grant  execute on function public.attach_pending_global_beans() to service_role;
grant  execute on function public.attach_pending_global_beans() to postgres;

revoke execute on function public.check_new_roaster_webhook() from public;
revoke execute on function public.check_new_roaster_webhook() from anon;
revoke execute on function public.check_new_roaster_webhook() from authenticated;
grant  execute on function public.check_new_roaster_webhook() to service_role;
grant  execute on function public.check_new_roaster_webhook() to postgres;

revoke execute on function public.create_roaster_profile_on_insert() from public;
revoke execute on function public.create_roaster_profile_on_insert() from anon;
revoke execute on function public.create_roaster_profile_on_insert() from authenticated;
grant  execute on function public.create_roaster_profile_on_insert() to service_role;
grant  execute on function public.create_roaster_profile_on_insert() to postgres;

revoke execute on function public.enqueue_roaster_dominant_color_generation() from public;
revoke execute on function public.enqueue_roaster_dominant_color_generation() from anon;
revoke execute on function public.enqueue_roaster_dominant_color_generation() from authenticated;
grant  execute on function public.enqueue_roaster_dominant_color_generation() to service_role;
grant  execute on function public.enqueue_roaster_dominant_color_generation() to postgres;

revoke execute on function public.enqueue_roaster_logo_mirror() from public;
revoke execute on function public.enqueue_roaster_logo_mirror() from anon;
revoke execute on function public.enqueue_roaster_logo_mirror() from authenticated;
grant  execute on function public.enqueue_roaster_logo_mirror() to service_role;
grant  execute on function public.enqueue_roaster_logo_mirror() to postgres;

revoke execute on function public.invalidate_bean_review_translations() from public;
revoke execute on function public.invalidate_bean_review_translations() from anon;
revoke execute on function public.invalidate_bean_review_translations() from authenticated;
grant  execute on function public.invalidate_bean_review_translations() to service_role;
grant  execute on function public.invalidate_bean_review_translations() to postgres;

revoke execute on function public.link_bean_review_to_roaster_profile() from public;
revoke execute on function public.link_bean_review_to_roaster_profile() from anon;
revoke execute on function public.link_bean_review_to_roaster_profile() from authenticated;
grant  execute on function public.link_bean_review_to_roaster_profile() to service_role;
grant  execute on function public.link_bean_review_to_roaster_profile() to postgres;

revoke execute on function public.link_global_bean_to_coffee_roaster() from public;
revoke execute on function public.link_global_bean_to_coffee_roaster() from anon;
revoke execute on function public.link_global_bean_to_coffee_roaster() from authenticated;
grant  execute on function public.link_global_bean_to_coffee_roaster() to service_role;
grant  execute on function public.link_global_bean_to_coffee_roaster() to postgres;

revoke execute on function public.link_pending_bean_reviews() from public;
revoke execute on function public.link_pending_bean_reviews() from anon;
revoke execute on function public.link_pending_bean_reviews() from authenticated;
grant  execute on function public.link_pending_bean_reviews() to service_role;
grant  execute on function public.link_pending_bean_reviews() to postgres;

revoke execute on function public.sync_roaster_profile_on_update() from public;
revoke execute on function public.sync_roaster_profile_on_update() from anon;
revoke execute on function public.sync_roaster_profile_on_update() from authenticated;
grant  execute on function public.sync_roaster_profile_on_update() to service_role;
grant  execute on function public.sync_roaster_profile_on_update() to postgres;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'public.aggregate_notification_analytics_cron()'::regprocedure,
    'public.check_new_version_cron()'::regprocedure,
    'public.cron_refresh_global_stats_daily()'::regprocedure,
    'public.cron_refresh_global_stats_hourly()'::regprocedure,
    'public.normalize_bean_origins_cron()'::regprocedure,
    'public.process_app_release_notifications_cron()'::regprocedure,
    'public.process_live_activity_events_cron()'::regprocedure,
    'public.process_scheduled_notifications_cron()'::regprocedure,
    'public.roaster_enrichment_worker_cron()'::regprocedure,
    'public.token_cleanup_cron()'::regprocedure,
    'public.aggregate_coffee_volume()'::regprocedure,
    'public.attach_pending_global_beans()'::regprocedure,
    'public.check_new_roaster_webhook()'::regprocedure,
    'public.create_roaster_profile_on_insert()'::regprocedure,
    'public.enqueue_roaster_dominant_color_generation()'::regprocedure,
    'public.enqueue_roaster_logo_mirror()'::regprocedure,
    'public.invalidate_bean_review_translations()'::regprocedure,
    'public.link_bean_review_to_roaster_profile()'::regprocedure,
    'public.link_global_bean_to_coffee_roaster()'::regprocedure,
    'public.link_pending_bean_reviews()'::regprocedure,
    'public.sync_roaster_profile_on_update()'::regprocedure
  ];
begin
  foreach fn in array fns loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'anon can still execute %', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'execute') is distinct from false then
      raise exception 'authenticated execute on % should be false', fn;
    end if;
    if has_function_privilege('service_role', fn, 'execute') is distinct from true then
      raise exception 'service_role cannot execute %', fn;
    end if;
    if exists (
      select 1
      from pg_proc p
      where p.oid = fn
        and (
          p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
        )
    ) then
      raise exception 'PUBLIC still holds an execute grant on %', fn;
    end if;
  end loop;
end $$;
