-- Close an unauthenticated read of service.notifications via
-- public.admin_list_notifications.
--
-- The function is SECURITY DEFINER over service.notifications, returns whole
-- rows (SELECT *) with limit/offset/filter/sort controls, and carried no
-- authorization check of any kind while remaining EXECUTE-able by anon.
-- The anon key is published in the mobile app, so every notification row --
-- including unsent and scheduled ones -- was enumerable by anyone.
--
-- Verified on 2026-09-16: prosecdef = true, no is_admin()/auth.uid() call in
-- the body, has_function_privilege('anon', ..., 'EXECUTE') = true.
--
-- The fix adds the project's standard guard, matching
-- 20260610130000_admin_connection_analytics.sql and
-- 20260409110000_add_roaster_admin_portal.sql:
--
--   if not public.is_admin() then
--     raise exception 'forbidden' using errcode = '42501';
--   end if;
--
-- public.is_admin() returns true for service_role and otherwise checks
-- service.admin_users for auth.uid(), so edge functions using the service key
-- and signed-in admins both keep working while anon and non-admin
-- authenticated callers are refused. anon is additionally revoked by name,
-- because ALTER DEFAULT PRIVILEGES granted it EXECUTE as a named role and a
-- revoke from PUBLIC would not remove that.
--
-- The body below is otherwise unchanged from production, including the
-- existing sort-column/direction whitelist that keeps the dynamic SQL safe.

create or replace function public.admin_list_notifications(
  p_limit integer default 10,
  p_offset integer default 0,
  p_status text default null,
  p_category text default null,
  p_priority text default null,
  p_start_date timestamp with time zone default null,
  p_end_date timestamp with time zone default null,
  p_sort_by text default 'created_at',
  p_sort_order text default 'desc'
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_where      text := 'WHERE TRUE';
  v_data       json;
  v_total      bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;

  IF p_status IS NOT NULL THEN
    v_where := v_where || format(' AND status = %L', p_status);
  END IF;
  IF p_category IS NOT NULL THEN
    v_where := v_where || format(' AND category = %L', p_category);
  END IF;
  IF p_priority IS NOT NULL THEN
    v_where := v_where || format(' AND priority = %L', p_priority);
  END IF;
  IF p_start_date IS NOT NULL THEN
    v_where := v_where || format(' AND created_at >= %L', p_start_date);
  END IF;
  IF p_end_date IS NOT NULL THEN
    v_where := v_where || format(' AND created_at <= %L', p_end_date);
  END IF;

  -- Whitelist sort column and direction to prevent injection
  IF p_sort_by NOT IN ('created_at','sent_at','status','title','platform','category','priority') THEN
    p_sort_by := 'created_at';
  END IF;
  IF p_sort_order NOT IN ('asc','desc') THEN
    p_sort_order := 'desc';
  END IF;

  EXECUTE format('SELECT count(*) FROM service.notifications %s', v_where)
    INTO v_total;

  EXECUTE format(
    'SELECT COALESCE(json_agg(t), ''[]''::json) FROM (SELECT * FROM service.notifications %s ORDER BY %I %s LIMIT %s OFFSET %s) t',
    v_where, p_sort_by, p_sort_order, p_limit, p_offset
  ) INTO v_data;

  RETURN json_build_object('data', v_data, 'total', v_total);
END;
$function$;

-- authenticated is retained because signed-in admins reach this through
-- PostgREST; is_admin() is what separates them from ordinary users.
revoke execute on function public.admin_list_notifications(
  integer, integer, text, text, text,
  timestamp with time zone, timestamp with time zone, text, text
) from public;
revoke execute on function public.admin_list_notifications(
  integer, integer, text, text, text,
  timestamp with time zone, timestamp with time zone, text, text
) from anon;
grant execute on function public.admin_list_notifications(
  integer, integer, text, text, text,
  timestamp with time zone, timestamp with time zone, text, text
) to authenticated, service_role;
