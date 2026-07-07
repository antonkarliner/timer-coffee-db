-- Admin-facing aggregation over public.connection_events (the direct-vs-proxy
-- telemetry from 20260610125440_connection_events_analytics). Powers the
-- connection monitoring panel in the landing admin dashboard.
--
-- connection_events has RLS enabled with no policies, so it is unreadable by the
-- admin's authenticated session directly. This SECURITY DEFINER function reads it
-- and returns only non-identifying aggregates. It gates on public.is_admin()
-- internally, so it is safe even though EXECUTE is granted to authenticated.
create or replace function public.admin_connection_analytics(p_days integer default 30)
returns json
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
  v_result json;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with bounded as (
    select endpoint, coalesce(platform, 'unknown') as platform, created_at
    from public.connection_events
    where created_at >= now() - make_interval(days => v_days)
  )
  select json_build_object(
    'window_days', v_days,
    'totals', json_build_object(
      'direct', count(*) filter (where endpoint = 'direct'),
      'proxy',  count(*) filter (where endpoint = 'proxy'),
      'total',  count(*)
    ),
    'platform_distribution', coalesce((
      select json_object_agg(platform, cnt)
      from (
        select platform, count(*) as cnt
        from bounded
        group by platform
      ) p
    ), '{}'::json),
    'series', coalesce((
      select json_agg(
               json_build_object('day', day, 'direct', direct, 'proxy', proxy)
               order by day
             )
      from (
        select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
               count(*) filter (where endpoint = 'direct') as direct,
               count(*) filter (where endpoint = 'proxy')  as proxy
        from bounded
        group by date_trunc('day', created_at)
      ) s
    ), '[]'::json)
  )
  into v_result
  from bounded;

  return v_result;
end;
$$;

revoke all on function public.admin_connection_analytics(integer) from public;
grant execute on function public.admin_connection_analytics(integer) to authenticated, service_role;
