-- Security F17 (3 of 5): remove anon EXECUTE from the admin RPCs.
--
-- Each body already raises or returns nothing unless public.is_admin(). The
-- website admin pages call them with the signed-in admin's session (role
-- authenticated), and edge functions call some with the service-role key
-- (is_admin() returns true for service_role). Anon has no use for them.
-- End state: {postgres, authenticated, service_role}.
--
-- This migration changes no function body, only privileges.

-- Admin RPCs.

revoke execute on function public.admin_connection_analytics(integer) from public;
revoke execute on function public.admin_connection_analytics(integer) from anon;
revoke execute on function public.admin_connection_analytics(integer) from authenticated;
grant  execute on function public.admin_connection_analytics(integer) to authenticated;
grant  execute on function public.admin_connection_analytics(integer) to service_role;
grant  execute on function public.admin_connection_analytics(integer) to postgres;

revoke execute on function public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text) from public;
revoke execute on function public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text) from anon;
revoke execute on function public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text) from authenticated;
grant  execute on function public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text) to authenticated;
grant  execute on function public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text) to service_role;
grant  execute on function public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text) to postgres;

revoke execute on function public.admin_lookup_assignable_user_by_email(text) from public;
revoke execute on function public.admin_lookup_assignable_user_by_email(text) from anon;
revoke execute on function public.admin_lookup_assignable_user_by_email(text) from authenticated;
grant  execute on function public.admin_lookup_assignable_user_by_email(text) to authenticated;
grant  execute on function public.admin_lookup_assignable_user_by_email(text) to service_role;
grant  execute on function public.admin_lookup_assignable_user_by_email(text) to postgres;

revoke execute on function public.admin_notification_analytics() from public;
revoke execute on function public.admin_notification_analytics() from anon;
revoke execute on function public.admin_notification_analytics() from authenticated;
grant  execute on function public.admin_notification_analytics() to authenticated;
grant  execute on function public.admin_notification_analytics() to service_role;
grant  execute on function public.admin_notification_analytics() to postgres;

revoke execute on function public.admin_notification_health_metrics() from public;
revoke execute on function public.admin_notification_health_metrics() from anon;
revoke execute on function public.admin_notification_health_metrics() from authenticated;
grant  execute on function public.admin_notification_health_metrics() to authenticated;
grant  execute on function public.admin_notification_health_metrics() to service_role;
grant  execute on function public.admin_notification_health_metrics() to postgres;

revoke execute on function public.admin_search_roaster_profiles(text, integer) from public;
revoke execute on function public.admin_search_roaster_profiles(text, integer) from anon;
revoke execute on function public.admin_search_roaster_profiles(text, integer) from authenticated;
grant  execute on function public.admin_search_roaster_profiles(text, integer) to authenticated;
grant  execute on function public.admin_search_roaster_profiles(text, integer) to service_role;
grant  execute on function public.admin_search_roaster_profiles(text, integer) to postgres;

revoke execute on function public.admin_set_roaster_profile_owner(uuid, uuid) from public;
revoke execute on function public.admin_set_roaster_profile_owner(uuid, uuid) from anon;
revoke execute on function public.admin_set_roaster_profile_owner(uuid, uuid) from authenticated;
grant  execute on function public.admin_set_roaster_profile_owner(uuid, uuid) to authenticated;
grant  execute on function public.admin_set_roaster_profile_owner(uuid, uuid) to service_role;
grant  execute on function public.admin_set_roaster_profile_owner(uuid, uuid) to postgres;

revoke execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) from public;
revoke execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) from anon;
revoke execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) from authenticated;
grant  execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) to authenticated;
grant  execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) to service_role;
grant  execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) to postgres;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'public.admin_connection_analytics(integer)'::regprocedure,
    'public.admin_list_notifications(integer, integer, text, text, text, timestamp with time zone, timestamp with time zone, text, text)'::regprocedure,
    'public.admin_lookup_assignable_user_by_email(text)'::regprocedure,
    'public.admin_notification_analytics()'::regprocedure,
    'public.admin_notification_health_metrics()'::regprocedure,
    'public.admin_search_roaster_profiles(text, integer)'::regprocedure,
    'public.admin_set_roaster_profile_owner(uuid, uuid)'::regprocedure,
    'public.estimate_broadcast_reach(jsonb, text, uuid[])'::regprocedure
  ];
begin
  foreach fn in array fns loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'anon can still execute %', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'execute') is distinct from true then
      raise exception 'authenticated execute on % should be true', fn;
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
