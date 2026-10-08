-- Security F17 (2 of 5): restrict public RPCs that no client calls to
-- {postgres, service_role}.
--
-- Revoked by name from public, anon and authenticated, because the project's
-- default privileges grant EXECUTE to the named roles. None of these has a
-- caller in any app release since 3.9.0, the website, or SQL, except as noted:
--   get_unnormalized_bean_origins        called only by the normalize-bean-origins
--                                        edge function with the service-role key.
--   refresh_yearly_user_liters           heavy upsert over every user's brews;
--                                        operator-only.
--   get_user_recipe_import_counts        never called by any client.
--   global_stats_daily_range_sum         app stopped calling it before 3.9.0.
--   global_stats_range_count             never called by any client.
--   global_stats_hourly_range_summary    only called inside global_stats_live_summary,
--                                        which is SECURITY DEFINER owned by postgres,
--                                        so the nested call checks postgres's
--                                        privilege, not the caller's.
--   get_roaster_profile_by_name          app stopped calling it before 3.9.0.
--   search_roaster_unaccent              app stopped calling it before 3.9.0.
--
-- This migration changes no function body, only privileges.

-- Service-only RPCs.

revoke execute on function public.get_unnormalized_bean_origins(integer) from public;
revoke execute on function public.get_unnormalized_bean_origins(integer) from anon;
revoke execute on function public.get_unnormalized_bean_origins(integer) from authenticated;
grant  execute on function public.get_unnormalized_bean_origins(integer) to service_role;
grant  execute on function public.get_unnormalized_bean_origins(integer) to postgres;

revoke execute on function public.refresh_yearly_user_liters(integer) from public;
revoke execute on function public.refresh_yearly_user_liters(integer) from anon;
revoke execute on function public.refresh_yearly_user_liters(integer) from authenticated;
grant  execute on function public.refresh_yearly_user_liters(integer) to service_role;
grant  execute on function public.refresh_yearly_user_liters(integer) to postgres;

revoke execute on function public.get_user_recipe_import_counts(text[]) from public;
revoke execute on function public.get_user_recipe_import_counts(text[]) from anon;
revoke execute on function public.get_user_recipe_import_counts(text[]) from authenticated;
grant  execute on function public.get_user_recipe_import_counts(text[]) to service_role;
grant  execute on function public.get_user_recipe_import_counts(text[]) to postgres;

revoke execute on function public.global_stats_daily_range_sum(date, date) from public;
revoke execute on function public.global_stats_daily_range_sum(date, date) from anon;
revoke execute on function public.global_stats_daily_range_sum(date, date) from authenticated;
grant  execute on function public.global_stats_daily_range_sum(date, date) to service_role;
grant  execute on function public.global_stats_daily_range_sum(date, date) to postgres;

revoke execute on function public.global_stats_range_count(date, date) from public;
revoke execute on function public.global_stats_range_count(date, date) from anon;
revoke execute on function public.global_stats_range_count(date, date) from authenticated;
grant  execute on function public.global_stats_range_count(date, date) to service_role;
grant  execute on function public.global_stats_range_count(date, date) to postgres;

revoke execute on function public.global_stats_hourly_range_summary(timestamp with time zone, timestamp with time zone) from public;
revoke execute on function public.global_stats_hourly_range_summary(timestamp with time zone, timestamp with time zone) from anon;
revoke execute on function public.global_stats_hourly_range_summary(timestamp with time zone, timestamp with time zone) from authenticated;
grant  execute on function public.global_stats_hourly_range_summary(timestamp with time zone, timestamp with time zone) to service_role;
grant  execute on function public.global_stats_hourly_range_summary(timestamp with time zone, timestamp with time zone) to postgres;

revoke execute on function public.get_roaster_profile_by_name(text) from public;
revoke execute on function public.get_roaster_profile_by_name(text) from anon;
revoke execute on function public.get_roaster_profile_by_name(text) from authenticated;
grant  execute on function public.get_roaster_profile_by_name(text) to service_role;
grant  execute on function public.get_roaster_profile_by_name(text) to postgres;

revoke execute on function public.search_roaster_unaccent(text) from public;
revoke execute on function public.search_roaster_unaccent(text) from anon;
revoke execute on function public.search_roaster_unaccent(text) from authenticated;
grant  execute on function public.search_roaster_unaccent(text) to service_role;
grant  execute on function public.search_roaster_unaccent(text) to postgres;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'public.get_unnormalized_bean_origins(integer)'::regprocedure,
    'public.refresh_yearly_user_liters(integer)'::regprocedure,
    'public.get_user_recipe_import_counts(text[])'::regprocedure,
    'public.global_stats_daily_range_sum(date, date)'::regprocedure,
    'public.global_stats_range_count(date, date)'::regprocedure,
    'public.global_stats_hourly_range_summary(timestamp with time zone, timestamp with time zone)'::regprocedure,
    'public.get_roaster_profile_by_name(text)'::regprocedure,
    'public.search_roaster_unaccent(text)'::regprocedure
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
