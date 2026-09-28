-- Gate the two admin notification RPCs to admins.
--
-- Both are SECURITY DEFINER in the PostgREST-exposed `public` schema and read
-- service.notifications / service.user_fcm_tokens, but had no caller check and
-- carried EXECUTE for PUBLIC, anon and authenticated: anyone holding the anon
-- key could read push-delivery totals and active-token counts.
--
-- Only caller: the landing site's admin API routes
-- (timer-coffee-landing-2 src/pages/api/admin/notifications/{health,analytics}),
-- which call them with the signed-in admin's session after `check-admin-user`
-- confirms a service.admin_users row. So `authenticated` keeps EXECUTE and the
-- function itself now requires public.is_admin() (same table; service_role
-- also passes).
--
-- CREATE OR REPLACE resets proconfig, so `set search_path` is re-declared.
-- Bodies are unchanged apart from the guard.

create or replace function public.admin_notification_analytics()
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_total_sent      bigint;
  v_total_delivered bigint;
  v_total_failed    bigint;
  v_active_tokens   bigint;
  v_platform_dist   json;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select
    coalesce(sum(tokens_targeted), 0),
    coalesce(sum(tokens_successful), 0),
    coalesce(sum(tokens_failed), 0)
  into v_total_sent, v_total_delivered, v_total_failed
  from service.notifications;

  select count(*) into v_active_tokens
  from service.user_fcm_tokens
  where is_active = true;

  select json_object_agg(device_type, cnt)
  into v_platform_dist
  from (
    select device_type, count(*) as cnt
    from service.user_fcm_tokens
    where is_active = true
    group by device_type
  ) t;

  return json_build_object(
    'total_sent',            v_total_sent,
    'total_delivered',       v_total_delivered,
    'total_failed',          v_total_failed,
    'total_pending',         v_active_tokens,
    'platform_distribution', coalesce(v_platform_dist, '{}'::json)
  );
end;
$function$;

create or replace function public.admin_notification_health_metrics()
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_notifications_24h bigint;
  v_active_tokens     bigint;
  v_total_targeted    bigint;
  v_total_failed      bigint;
  v_error_rate        numeric;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*) into v_notifications_24h
  from service.notifications
  where created_at > now() - interval '24 hours';

  select count(*) into v_active_tokens
  from service.user_fcm_tokens
  where is_active = true;

  select
    coalesce(sum(tokens_targeted), 0),
    coalesce(sum(tokens_failed), 0)
  into v_total_targeted, v_total_failed
  from service.notifications
  where created_at > now() - interval '24 hours';

  v_error_rate := case
    when v_total_targeted > 0
      then round((v_total_failed::numeric / v_total_targeted) * 100, 1)
    else 0
  end;

  return json_build_object(
    'notifications_sent_24h', v_notifications_24h,
    'active_tokens',          v_active_tokens,
    'error_rate_24h',         v_error_rate
  );
end;
$function$;

-- End state: {postgres, authenticated, service_role}. Revoke anon by name:
-- `from public` alone leaves the default-privilege grant to anon in place.
revoke execute on function public.admin_notification_analytics() from public;
revoke execute on function public.admin_notification_analytics() from anon;
grant  execute on function public.admin_notification_analytics() to authenticated, service_role;

revoke execute on function public.admin_notification_health_metrics() from public;
revoke execute on function public.admin_notification_health_metrics() from anon;
grant  execute on function public.admin_notification_health_metrics() to authenticated, service_role;

-- Verify after `db push`:
--   select p.proname, p.proacl::text, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('admin_notification_analytics','admin_notification_health_metrics');
