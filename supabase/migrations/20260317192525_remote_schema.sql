create schema if not exists "grafana";

drop view if exists "public"."cron_job_status";

alter table "public"."coffee_roasters" add column "address_text" text;

alter table "public"."user_recipe_preferences" add column "custom_grind_size" text;

alter table "public"."user_stats" add column "grind_size" text;

alter table "service"."user_fcm_tokens" add column "ip_address" inet;

CREATE INDEX idx_coffee_countries_locale ON public.coffee_countries USING btree (locale);

CREATE INDEX idx_coffee_descriptors_locale ON public.coffee_descriptors USING btree (locale);

CREATE INDEX idx_coffee_facts_locale ON public.coffee_facts USING btree (locale);

CREATE INDEX idx_coffee_processing_methods_locale ON public.coffee_processing_methods USING btree (locale);

CREATE INDEX idx_launch_popup_locale ON public.launch_popup USING btree (locale);

CREATE INDEX launch_popup_is_translated_idx ON public.launch_popup USING btree (is_translated);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION grafana.secure_users_metrics()
 RETURNS SETOF grafana.users_metrics
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT * FROM grafana.users_metrics;
$function$
;

create or replace view "grafana"."users_metrics" as  WITH users_clean AS (
         SELECT users.id,
            users.created_at,
            users.last_sign_in_at,
            users.deleted_at
           FROM auth.users
        )
 SELECT users_clean.id,
    users_clean.created_at,
    users_clean.last_sign_in_at,
    users_clean.deleted_at
   FROM users_clean;


CREATE OR REPLACE FUNCTION public.admin_list_notifications(p_limit integer DEFAULT 10, p_offset integer DEFAULT 0, p_status text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_priority text DEFAULT NULL::text, p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sort_by text DEFAULT 'created_at'::text, p_sort_order text DEFAULT 'desc'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_where      text := 'WHERE TRUE';
  v_data       json;
  v_total      bigint;
BEGIN
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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_notification_analytics()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_sent      bigint;
  v_total_delivered bigint;
  v_total_failed    bigint;
  v_active_tokens   bigint;
  v_platform_dist   json;
BEGIN
  SELECT
    COALESCE(SUM(tokens_targeted), 0),
    COALESCE(SUM(tokens_successful), 0),
    COALESCE(SUM(tokens_failed), 0)
  INTO v_total_sent, v_total_delivered, v_total_failed
  FROM service.notifications;

  SELECT count(*) INTO v_active_tokens
  FROM service.user_fcm_tokens
  WHERE is_active = true;

  SELECT json_object_agg(device_type, cnt)
  INTO v_platform_dist
  FROM (
    SELECT device_type, count(*) AS cnt
    FROM service.user_fcm_tokens
    WHERE is_active = true
    GROUP BY device_type
  ) t;

  RETURN json_build_object(
    'total_sent',           v_total_sent,
    'total_delivered',      v_total_delivered,
    'total_failed',         v_total_failed,
    'total_pending',        v_active_tokens,
    'platform_distribution', COALESCE(v_platform_dist, '{}'::json)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_notification_health_metrics()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_notifications_24h bigint;
  v_active_tokens     bigint;
  v_total_targeted    bigint;
  v_total_failed      bigint;
  v_error_rate        numeric;
BEGIN
  SELECT count(*) INTO v_notifications_24h
  FROM service.notifications
  WHERE created_at > now() - interval '24 hours';

  SELECT count(*) INTO v_active_tokens
  FROM service.user_fcm_tokens
  WHERE is_active = true;

  SELECT
    COALESCE(SUM(tokens_targeted), 0),
    COALESCE(SUM(tokens_failed), 0)
  INTO v_total_targeted, v_total_failed
  FROM service.notifications
  WHERE created_at > now() - interval '24 hours';

  v_error_rate := CASE
    WHEN v_total_targeted > 0
      THEN ROUND((v_total_failed::numeric / v_total_targeted) * 100, 1)
    ELSE 0
  END;

  RETURN json_build_object(
    'notifications_sent_24h', v_notifications_24h,
    'active_tokens',          v_active_tokens,
    'error_rate_24h',         v_error_rate
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION service.cancel_orphan_events_on_session_end()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service'
AS $function$
begin
    if NEW.status in ('ended', 'stale') and OLD.status = 'active' then
        update service.live_activity_events
           set status = 'cancelled',
               last_error = 'session_' || NEW.status,
               updated_at = timezone('utc', now())
         where session_id = NEW.id
           and status in ('pending', 'processing');
    end if;
    return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION service.enqueue_live_activity_events(p_session_id uuid, p_watchdog_interval_seconds integer DEFAULT 20)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service', 'public', 'auth'
AS $function$
declare
    v_session service.live_activity_sessions%rowtype;
    v_step_count integer;
    v_step_running_seconds integer := 0;
    v_step_index integer;
    v_step_duration_seconds integer;
    v_boundary_at timestamptz;
    v_scheduled_at timestamptz;
    v_early_dispatch_ms integer;
begin
    select *
      into v_session
      from service.live_activity_sessions
     where id = p_session_id;

    if not found then
        raise exception 'Live activity session % not found', p_session_id;
    end if;

    delete from service.live_activity_events
     where session_id = p_session_id
       and status in ('pending', 'processing');

    v_step_count := coalesce(array_length(v_session.step_durations_seconds, 1), 0);
    if v_step_count = 0 then
        return 0;
    end if;

    v_step_running_seconds := 0;
    for v_step_index in 1..v_step_count loop
        v_step_duration_seconds := coalesce(v_session.step_durations_seconds[v_step_index], 0);
        v_step_running_seconds := v_step_running_seconds + v_step_duration_seconds;

        v_boundary_at := v_session.brew_started_at + make_interval(secs => v_step_running_seconds);

        if v_boundary_at > timezone('utc', now()) then
            v_early_dispatch_ms := least(
                greatest(round((v_step_duration_seconds * 1000)::numeric * 0.15)::integer, 1000),
                2000
            );

            v_scheduled_at := greatest(
                v_boundary_at - make_interval(secs => (v_early_dispatch_ms::double precision / 1000.0)),
                timezone('utc', now())
            );

            insert into service.live_activity_events (
                session_id,
                event_type,
                scheduled_at,
                payload,
                status
            )
            values (
                p_session_id,
                'boundary',
                v_scheduled_at,
                jsonb_build_object(
                    'step_index', v_step_index + 1,
                    'effective_at_ms', floor(extract(epoch from v_boundary_at) * 1000)::bigint
                ),
                'pending'
            )
            on conflict do nothing;
        end if;
    end loop;

    insert into service.live_activity_events (
        session_id,
        event_type,
        scheduled_at,
        payload,
        status
    )
    values (
        p_session_id,
        'end',
        greatest(v_session.expected_end_at, timezone('utc', now())),
        '{}'::jsonb,
        'pending'
    )
    on conflict do nothing;

    return (
        select count(*)::integer
          from service.live_activity_events
         where session_id = p_session_id
           and status = 'pending'
    );
end;
$function$
;

grant select on table "public"."global_stats" to "grafana";

grant delete on table "service"."app_release_notifications" to "anon";

grant insert on table "service"."app_release_notifications" to "anon";

grant references on table "service"."app_release_notifications" to "anon";

grant select on table "service"."app_release_notifications" to "anon";

grant trigger on table "service"."app_release_notifications" to "anon";

grant truncate on table "service"."app_release_notifications" to "anon";

grant update on table "service"."app_release_notifications" to "anon";

grant delete on table "service"."app_release_notifications" to "authenticated";

grant insert on table "service"."app_release_notifications" to "authenticated";

grant references on table "service"."app_release_notifications" to "authenticated";

grant select on table "service"."app_release_notifications" to "authenticated";

grant trigger on table "service"."app_release_notifications" to "authenticated";

grant truncate on table "service"."app_release_notifications" to "authenticated";

grant update on table "service"."app_release_notifications" to "authenticated";

grant delete on table "service"."app_release_notifications" to "service_role";

grant insert on table "service"."app_release_notifications" to "service_role";

grant references on table "service"."app_release_notifications" to "service_role";

grant select on table "service"."app_release_notifications" to "service_role";

grant trigger on table "service"."app_release_notifications" to "service_role";

grant truncate on table "service"."app_release_notifications" to "service_role";

grant update on table "service"."app_release_notifications" to "service_role";

CREATE TRIGGER trg_cancel_orphan_events_on_session_end AFTER UPDATE OF status ON service.live_activity_sessions FOR EACH ROW WHEN (((new.status = ANY (ARRAY['ended'::text, 'stale'::text])) AND (old.status = 'active'::text))) EXECUTE FUNCTION service.cancel_orphan_events_on_session_end();

drop trigger if exists "objects_delete_delete_prefix" on "storage"."objects";

drop trigger if exists "objects_insert_create_prefix" on "storage"."objects";

drop trigger if exists "objects_update_create_prefix" on "storage"."objects";

drop trigger if exists "prefixes_create_hierarchy" on "storage"."prefixes";

drop trigger if exists "prefixes_delete_hierarchy" on "storage"."prefixes";

CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();

CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();


