
  create table "public"."global_stats_hourly" (
    "hour_bucket" timestamp with time zone not null,
    "water_liters" numeric,
    "brew_count" integer,
    "top_recipes" jsonb,
    "created_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "updated_at" timestamp with time zone not null default timezone('utc'::text, now())
      );


alter table "public"."global_stats_hourly" enable row level security;


  create table "service"."live_activity_events" (
    "id" uuid not null default gen_random_uuid(),
    "session_id" uuid not null,
    "event_type" text not null,
    "scheduled_at" timestamp with time zone not null,
    "payload" jsonb not null default '{}'::jsonb,
    "status" text not null default 'pending'::text,
    "attempts" integer not null default 0,
    "last_error" text,
    "last_attempt_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "updated_at" timestamp with time zone not null default timezone('utc'::text, now())
      );



  create table "service"."live_activity_sessions" (
    "id" uuid not null default gen_random_uuid(),
    "brew_session_id" uuid not null,
    "user_id" uuid not null,
    "recipe_id" text not null,
    "recipe_name" text not null default 'Brewing'::text,
    "device_type" text not null default 'ios'::text,
    "fcm_token" text,
    "activity_id" text not null,
    "activity_push_token" text,
    "step_durations_seconds" integer[] not null,
    "step_descriptions" text[] not null default '{}'::text[],
    "brew_started_at" timestamp with time zone not null,
    "total_duration_seconds" integer not null,
    "expected_end_at" timestamp with time zone not null,
    "status" text not null default 'active'::text,
    "end_reason" text,
    "last_token_refresh_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "updated_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "paused_at" timestamp with time zone,
    "paused_elapsed_seconds" integer
      );



  create table "service"."website_redirect_clicks" (
    "id" uuid not null default gen_random_uuid(),
    "redirect_id" uuid,
    "slug" text not null,
    "referer" text,
    "user_agent" text,
    "created_at" timestamp with time zone not null default now()
      );


alter table "service"."website_redirect_clicks" enable row level security;


  create table "service"."website_redirects" (
    "id" uuid not null default gen_random_uuid(),
    "slug" text not null,
    "target_url" text not null,
    "is_active" boolean not null default true,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "service"."website_redirects" enable row level security;

CREATE UNIQUE INDEX global_stats_hourly_pkey ON public.global_stats_hourly USING btree (hour_bucket);

CREATE INDEX idx_website_redirect_clicks_redirect_id ON service.website_redirect_clicks USING btree (redirect_id);

CREATE INDEX idx_website_redirects_slug ON service.website_redirects USING btree (slug);

CREATE INDEX live_activity_events_pending_schedule_idx ON service.live_activity_events USING btree (scheduled_at, session_id) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));

CREATE UNIQUE INDEX live_activity_events_pkey ON service.live_activity_events USING btree (id);

CREATE INDEX live_activity_events_session_status_idx ON service.live_activity_events USING btree (session_id, status);

CREATE UNIQUE INDEX live_activity_events_session_type_schedule_uidx ON service.live_activity_events USING btree (session_id, event_type, scheduled_at);

CREATE INDEX live_activity_sessions_activity_id_idx ON service.live_activity_sessions USING btree (activity_id);

CREATE UNIQUE INDEX live_activity_sessions_brew_session_id_key ON service.live_activity_sessions USING btree (brew_session_id);

CREATE UNIQUE INDEX live_activity_sessions_pkey ON service.live_activity_sessions USING btree (id);

CREATE INDEX live_activity_sessions_user_status_idx ON service.live_activity_sessions USING btree (user_id, status, expected_end_at);

CREATE UNIQUE INDEX website_redirect_clicks_pkey ON service.website_redirect_clicks USING btree (id);

CREATE UNIQUE INDEX website_redirects_pkey ON service.website_redirects USING btree (id);

CREATE UNIQUE INDEX website_redirects_slug_key ON service.website_redirects USING btree (slug);

alter table "public"."global_stats_hourly" add constraint "global_stats_hourly_pkey" PRIMARY KEY using index "global_stats_hourly_pkey";

alter table "service"."live_activity_events" add constraint "live_activity_events_pkey" PRIMARY KEY using index "live_activity_events_pkey";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_pkey" PRIMARY KEY using index "live_activity_sessions_pkey";

alter table "service"."website_redirect_clicks" add constraint "website_redirect_clicks_pkey" PRIMARY KEY using index "website_redirect_clicks_pkey";

alter table "service"."website_redirects" add constraint "website_redirects_pkey" PRIMARY KEY using index "website_redirects_pkey";

alter table "public"."global_stats_hourly" add constraint "global_stats_hourly_top_recipes_check" CHECK (((top_recipes IS NULL) OR ((jsonb_typeof(top_recipes) = 'array'::text) AND (jsonb_array_length(top_recipes) <= 5)))) not valid;

alter table "public"."global_stats_hourly" validate constraint "global_stats_hourly_top_recipes_check";

alter table "public"."global_stats_hourly" add constraint "global_stats_hourly_water_liters_check" CHECK (((water_liters IS NULL) OR (water_liters >= (0)::numeric))) not valid;

alter table "public"."global_stats_hourly" validate constraint "global_stats_hourly_water_liters_check";

alter table "service"."live_activity_events" add constraint "live_activity_events_attempts_check" CHECK ((attempts >= 0)) not valid;

alter table "service"."live_activity_events" validate constraint "live_activity_events_attempts_check";

alter table "service"."live_activity_events" add constraint "live_activity_events_event_type_check" CHECK ((event_type = ANY (ARRAY['boundary'::text, 'watchdog'::text, 'end'::text]))) not valid;

alter table "service"."live_activity_events" validate constraint "live_activity_events_event_type_check";

alter table "service"."live_activity_events" add constraint "live_activity_events_session_id_fkey" FOREIGN KEY (session_id) REFERENCES service.live_activity_sessions(id) ON DELETE CASCADE not valid;

alter table "service"."live_activity_events" validate constraint "live_activity_events_session_id_fkey";

alter table "service"."live_activity_events" add constraint "live_activity_events_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'cancelled'::text]))) not valid;

alter table "service"."live_activity_events" validate constraint "live_activity_events_status_check";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_brew_session_id_key" UNIQUE using index "live_activity_sessions_brew_session_id_key";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_descriptions_match" CHECK (((COALESCE(array_length(step_descriptions, 1), 0) = 0) OR (array_length(step_descriptions, 1) = array_length(step_durations_seconds, 1)))) not valid;

alter table "service"."live_activity_sessions" validate constraint "live_activity_sessions_descriptions_match";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_device_type_check" CHECK ((device_type = 'ios'::text)) not valid;

alter table "service"."live_activity_sessions" validate constraint "live_activity_sessions_device_type_check";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_durations_nonempty" CHECK ((COALESCE(array_length(step_durations_seconds, 1), 0) > 0)) not valid;

alter table "service"."live_activity_sessions" validate constraint "live_activity_sessions_durations_nonempty";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_paused_elapsed_seconds_check" CHECK (((paused_elapsed_seconds IS NULL) OR (paused_elapsed_seconds >= 0))) not valid;

alter table "service"."live_activity_sessions" validate constraint "live_activity_sessions_paused_elapsed_seconds_check";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'ended'::text, 'failed'::text, 'stale'::text]))) not valid;

alter table "service"."live_activity_sessions" validate constraint "live_activity_sessions_status_check";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_total_duration_seconds_check" CHECK ((total_duration_seconds > 0)) not valid;

alter table "service"."live_activity_sessions" validate constraint "live_activity_sessions_total_duration_seconds_check";

alter table "service"."live_activity_sessions" add constraint "live_activity_sessions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "service"."live_activity_sessions" validate constraint "live_activity_sessions_user_id_fkey";

alter table "service"."website_redirect_clicks" add constraint "website_redirect_clicks_redirect_id_fkey" FOREIGN KEY (redirect_id) REFERENCES service.website_redirects(id) ON DELETE SET NULL not valid;

alter table "service"."website_redirect_clicks" validate constraint "website_redirect_clicks_redirect_id_fkey";

alter table "service"."website_redirects" add constraint "website_redirects_slug_key" UNIQUE using index "website_redirects_slug_key";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.backfill_global_stats_hourly(p_start_hour timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_hour timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_hour timestamptz;
  v_count integer := 0;
begin
  select coalesce(
    date_trunc('hour', p_start_hour),
    (select date_trunc('hour', min(created_at)) from public.global_stats)
  ) into v_start;

  select coalesce(
    date_trunc('hour', p_end_hour),
    date_trunc('hour', timezone('utc', now()))
  ) into v_end;

  if v_start is null then
    return 0;
  end if;

  if v_start > v_end then
    return 0;
  end if;

  v_hour := v_start;
  while v_hour <= v_end loop
    perform public.refresh_global_stats_hourly(v_hour);
    v_count := v_count + 1;
    v_hour := v_hour + interval '1 hour';
  end loop;

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cron_refresh_global_stats_hourly()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_current_hour timestamptz := date_trunc('hour', timezone('utc', now()));
begin
  perform public.refresh_global_stats_hourly(v_current_hour - interval '1 hour');
  perform public.refresh_global_stats_hourly(v_current_hour);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.global_stats_hourly_range_summary(p_start_ts timestamp with time zone, p_end_ts timestamp with time zone)
 RETURNS TABLE(total_liters numeric, total_brews bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_first_full timestamptz;
  v_last_full timestamptz;
  v_edge1_end timestamptz;
  v_edge2_start timestamptz;

  v_edge1_liters numeric := 0;
  v_edge1_brews bigint := 0;
  v_edge2_liters numeric := 0;
  v_edge2_brews bigint := 0;
  v_hourly_liters numeric := 0;
  v_hourly_brews bigint := 0;
  v_missing_liters numeric := 0;
  v_missing_brews bigint := 0;
begin
  if p_start_ts is null or p_end_ts is null then
    raise exception 'start_ts and end_ts are required';
  end if;

  if p_start_ts >= p_end_ts then
    raise exception 'start_ts (%) must be before end_ts (%)', p_start_ts, p_end_ts;
  end if;

  v_first_full := date_trunc('hour', p_start_ts);
  if v_first_full < p_start_ts then
    v_first_full := v_first_full + interval '1 hour';
  end if;

  v_last_full := date_trunc('hour', p_end_ts);

  v_edge1_end := least(v_first_full, p_end_ts);
  if p_start_ts < v_edge1_end then
    select
      coalesce(sum(gs.water_amount) / 1000.0, 0),
      count(*)::bigint
    into v_edge1_liters, v_edge1_brews
    from public.global_stats gs
    where gs.created_at >= p_start_ts
      and gs.created_at < v_edge1_end
      and gs.water_amount between 50 and 5000;
  end if;

  v_edge2_start := greatest(v_last_full, p_start_ts);
  if v_edge2_start < p_end_ts and v_edge2_start >= v_edge1_end then
    select
      coalesce(sum(gs.water_amount) / 1000.0, 0),
      count(*)::bigint
    into v_edge2_liters, v_edge2_brews
    from public.global_stats gs
    where gs.created_at >= v_edge2_start
      and gs.created_at < p_end_ts
      and gs.water_amount between 50 and 5000;
  end if;

  if v_first_full < v_last_full then
    with full_hours as (
      select generate_series(
        v_first_full,
        v_last_full - interval '1 hour',
        interval '1 hour'
      ) as hour_bucket
    )
    select
      coalesce(sum(h.water_liters), 0),
      coalesce(sum(h.brew_count), 0)::bigint
    into v_hourly_liters, v_hourly_brews
    from public.global_stats_hourly h
    join full_hours fh on fh.hour_bucket = h.hour_bucket;

    with full_hours as (
      select generate_series(
        v_first_full,
        v_last_full - interval '1 hour',
        interval '1 hour'
      ) as hour_bucket
    ),
    missing_hours as (
      select fh.hour_bucket
      from full_hours fh
      left join public.global_stats_hourly h
        on h.hour_bucket = fh.hour_bucket
      where h.hour_bucket is null
    )
    select
      coalesce(sum(gs.water_amount) / 1000.0, 0),
      count(*)::bigint
    into v_missing_liters, v_missing_brews
    from public.global_stats gs
    join missing_hours mh
      on date_trunc('hour', gs.created_at) = mh.hour_bucket
    where gs.created_at >= v_first_full
      and gs.created_at < v_last_full
      and gs.water_amount between 50 and 5000;
  end if;

  total_liters :=
    coalesce(v_edge1_liters, 0)
    + coalesce(v_edge2_liters, 0)
    + coalesce(v_hourly_liters, 0)
    + coalesce(v_missing_liters, 0);

  total_brews :=
    coalesce(v_edge1_brews, 0)
    + coalesce(v_edge2_brews, 0)
    + coalesce(v_hourly_brews, 0)
    + coalesce(v_missing_brews, 0);

  return next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.global_stats_live_summary(p_now timestamp with time zone DEFAULT timezone('utc'::text, now()), p_utc_offset_minutes integer DEFAULT 0)
 RETURNS TABLE(period text, start_ts timestamp with time zone, end_ts timestamp with time zone, brew_count bigint, water_liters numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_now timestamptz := coalesce(p_now, timezone('utc', now()));
  v_offset interval := make_interval(mins => coalesce(p_utc_offset_minutes, 0));
  v_local_now timestamp := (
    coalesce(p_now, timezone('utc', now()))
    + make_interval(mins => coalesce(p_utc_offset_minutes, 0))
  );
  v_today_start timestamptz;
  v_yesterday_start timestamptz;
  v_week_start timestamptz;
  v_month_start timestamptz;
  v_year_start timestamptz;
  v_last_year_start timestamptz;
  v_liters numeric;
  v_brews bigint;
begin
  v_today_start := date_trunc('day', v_local_now) - v_offset;
  v_yesterday_start := (date_trunc('day', v_local_now) - interval '1 day') - v_offset;
  v_week_start := date_trunc('week', v_local_now) - v_offset;
  v_month_start := date_trunc('month', v_local_now) - v_offset;
  v_year_start := date_trunc('year', v_local_now) - v_offset;
  v_last_year_start := (date_trunc('year', v_local_now) - interval '1 year') - v_offset;

  -- 1) "recent" — last 15 minutes
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_now - interval '15 minutes', v_now);
  period := 'recent';
  start_ts := v_now - interval '15 minutes';
  end_ts := v_now;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;

  -- 2) "last_hour" — last 60 minutes
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_now - interval '1 hour', v_now);
  period := 'last_hour';
  start_ts := v_now - interval '1 hour';
  end_ts := v_now;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;

  -- 3) "today" — from start of day in user's local timezone
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_today_start, v_now);
  period := 'today';
  start_ts := v_today_start;
  end_ts := v_now;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;

  -- 4) "yesterday" — from start of yesterday to start of today in user's local timezone
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_yesterday_start, v_today_start);
  period := 'yesterday';
  start_ts := v_yesterday_start;
  end_ts := v_today_start;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;

  -- 5) "this_week" — from start of ISO week in user's local timezone
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_week_start, v_now);
  period := 'this_week';
  start_ts := v_week_start;
  end_ts := v_now;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;

  -- 6) "this_month" — from start of month in user's local timezone
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_month_start, v_now);
  period := 'this_month';
  start_ts := v_month_start;
  end_ts := v_now;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;

  -- 7) "this_year" — from start of year in user's local timezone
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_year_start, v_now);
  period := 'this_year';
  start_ts := v_year_start;
  end_ts := v_now;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;

  -- 8) "last_year" — the full previous calendar year
  select total_liters, total_brews
  into v_liters, v_brews
  from public.global_stats_hourly_range_summary(v_last_year_start, v_year_start);
  period := 'last_year';
  start_ts := v_last_year_start;
  end_ts := v_year_start;
  brew_count := coalesce(v_brews, 0);
  water_liters := coalesce(v_liters, 0);
  return next;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.process_live_activity_events_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    edge_function_url text;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if service_key is null then
        raise exception 'Vault secret service_role_key is not set.';
    end if;

    edge_function_url := project_url || '/functions/v1/process-live-activity-events-fcm';

    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('timestamp', now()),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        ),
        timeout_milliseconds := 300000
    ) into http_response;

    if (http_response ? 'status') and http_response->>'status' = 'error' then
        raise exception 'Live activity event processing failed: %', http_response->>'content';
    end if;

    if (http_response ? 'status_code') and (http_response->>'status_code')::integer >= 400 then
        raise exception 'Live activity event processing failed with status code %', http_response->>'status_code';
    end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_global_stats_hourly(p_target_hour timestamp with time zone DEFAULT date_trunc('hour'::text, timezone('utc'::text, now())))
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_hour_start timestamptz := date_trunc('hour', p_target_hour);
  v_hour_end timestamptz := date_trunc('hour', p_target_hour) + interval '1 hour';
  v_now timestamptz := timezone('utc', now());
  v_has_data boolean;
begin
  select exists (
    select 1
    from public.global_stats gs
    where gs.created_at >= v_hour_start
      and gs.created_at < v_hour_end
      and gs.water_amount between 50 and 5000
  ) into v_has_data;

  if not v_has_data then
    delete from public.global_stats_hourly
    where hour_bucket = v_hour_start;
    return;
  end if;

  insert into public.global_stats_hourly (
    hour_bucket,
    water_liters,
    brew_count,
    top_recipes,
    created_at,
    updated_at
  )
  select
    v_hour_start,
    coalesce(sum(gs.water_amount) / 1000.0, 0),
    count(*)::int,
    (
      select jsonb_agg(recipe_row order by (recipe_row->>'count')::int desc, recipe_row->>'recipe_id' asc)
      from (
        select jsonb_build_object(
          'recipe_id', gs2.recipe_id,
          'count', count(*)
        ) as recipe_row
        from public.global_stats gs2
        where gs2.created_at >= v_hour_start
          and gs2.created_at < v_hour_end
          and gs2.water_amount between 50 and 5000
          and gs2.recipe_id is not null
        group by gs2.recipe_id
        order by count(*) desc, gs2.recipe_id asc
        limit 5
      ) ranked
    ),
    v_now,
    v_now
  from public.global_stats gs
  where gs.created_at >= v_hour_start
    and gs.created_at < v_hour_end
    and gs.water_amount between 50 and 5000
  on conflict (hour_bucket) do update
    set water_liters = excluded.water_liters,
        brew_count = excluded.brew_count,
        top_recipes = excluded.top_recipes,
        updated_at = excluded.updated_at;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.search_roasters_fuzzy(search_term text, result_limit integer DEFAULT 10)
 RETURNS TABLE(id bigint, roaster_name character varying, aliases character varying, similarity_score real)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    cr.id,
    cr.roaster_name,
    cr.aliases,
    GREATEST(
      similarity(lower(cr.roaster_name), lower(search_term)),
      similarity(lower(COALESCE(cr.normalized_name, '')), lower(search_term))
    ) AS similarity_score
  FROM public.coffee_roasters cr
  WHERE
    similarity(lower(cr.roaster_name), lower(search_term)) > 0.15
    OR similarity(lower(COALESCE(cr.normalized_name, '')), lower(search_term)) > 0.15
    OR lower(cr.roaster_name) ILIKE '%' || lower(search_term) || '%'
    OR lower(COALESCE(cr.aliases, '')) ILIKE '%' || lower(search_term) || '%'
  ORDER BY similarity_score DESC
  LIMIT result_limit;
END;
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

        if v_step_index < v_step_count then
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

CREATE OR REPLACE FUNCTION service.finalize_live_activity_event(p_event_id uuid, p_status text, p_error text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service', 'public', 'auth'
AS $function$
declare
    v_event_type text;
    v_session_id uuid;
begin
    if p_status not in ('pending', 'processing', 'sent', 'failed', 'cancelled') then
        raise exception 'Invalid live activity event status: %', p_status;
    end if;

    update service.live_activity_events
       set status = p_status,
           sent_at = case when p_status = 'sent' then timezone('utc', now()) else sent_at end,
           last_error = p_error,
           updated_at = timezone('utc', now())
     where id = p_event_id
    returning event_type, session_id
         into v_event_type, v_session_id;

    if p_status = 'sent' and v_event_type = 'end' and v_session_id is not null then
        update service.live_activity_sessions
           set status = 'ended',
               end_reason = coalesce(end_reason, 'completed'),
               updated_at = timezone('utc', now())
         where id = v_session_id;
    end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION service.lock_due_live_activity_events(p_limit integer DEFAULT 100)
 RETURNS TABLE(event_id uuid, session_id uuid, event_type text, scheduled_at timestamp with time zone, payload jsonb, attempts integer, user_id uuid, recipe_id text, recipe_name text, activity_id text, activity_push_token text, fcm_token text, step_durations_seconds integer[], step_descriptions text[], brew_started_at timestamp with time zone, total_duration_seconds integer, expected_end_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service', 'public', 'auth'
AS $function$
begin
    return query
    with due as (
        select e.id
          from service.live_activity_events e
          join service.live_activity_sessions s
            on s.id = e.session_id
         where e.status = 'pending'
           and e.event_type in ('boundary', 'end')
           and e.scheduled_at <= timezone('utc', now())
           and s.status = 'active'
         order by e.scheduled_at asc
         limit p_limit
         for update skip locked
    )
    update service.live_activity_events e
       set status = 'processing',
           attempts = e.attempts + 1,
           last_attempt_at = timezone('utc', now())
      from due
     where e.id = due.id
    returning
        e.id,
        e.session_id,
        e.event_type,
        e.scheduled_at,
        e.payload,
        e.attempts,
        (select s.user_id from service.live_activity_sessions s where s.id = e.session_id),
        (select s.recipe_id from service.live_activity_sessions s where s.id = e.session_id),
        (select s.recipe_name from service.live_activity_sessions s where s.id = e.session_id),
        (select s.activity_id from service.live_activity_sessions s where s.id = e.session_id),
        (select s.activity_push_token from service.live_activity_sessions s where s.id = e.session_id),
        (select s.fcm_token from service.live_activity_sessions s where s.id = e.session_id),
        (select s.step_durations_seconds from service.live_activity_sessions s where s.id = e.session_id),
        (select s.step_descriptions from service.live_activity_sessions s where s.id = e.session_id),
        (select s.brew_started_at from service.live_activity_sessions s where s.id = e.session_id),
        (select s.total_duration_seconds from service.live_activity_sessions s where s.id = e.session_id),
        (select s.expected_end_at from service.live_activity_sessions s where s.id = e.session_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.search_roaster_unaccent(search_name text)
 RETURNS SETOF public.coffee_roasters
 LANGUAGE sql
 STABLE
AS $function$
  SELECT *
  FROM coffee_roasters
  WHERE (
    unaccent(lower(roaster_name)) = unaccent(lower(search_name))
    OR unaccent(lower(aliases)) ILIKE '%' || unaccent(lower(search_name)) || '%'
  )
  ORDER BY
    CASE WHEN unaccent(lower(roaster_name)) = unaccent(lower(search_name))
         THEN 0 ELSE 1 END
  LIMIT 1
$function$
;

grant delete on table "public"."global_stats_hourly" to "anon";

grant insert on table "public"."global_stats_hourly" to "anon";

grant references on table "public"."global_stats_hourly" to "anon";

grant select on table "public"."global_stats_hourly" to "anon";

grant trigger on table "public"."global_stats_hourly" to "anon";

grant truncate on table "public"."global_stats_hourly" to "anon";

grant update on table "public"."global_stats_hourly" to "anon";

grant delete on table "public"."global_stats_hourly" to "authenticated";

grant insert on table "public"."global_stats_hourly" to "authenticated";

grant references on table "public"."global_stats_hourly" to "authenticated";

grant select on table "public"."global_stats_hourly" to "authenticated";

grant trigger on table "public"."global_stats_hourly" to "authenticated";

grant truncate on table "public"."global_stats_hourly" to "authenticated";

grant update on table "public"."global_stats_hourly" to "authenticated";

grant select on table "public"."global_stats_hourly" to "cline_mcp_readonly_role";

grant delete on table "public"."global_stats_hourly" to "service_role";

grant insert on table "public"."global_stats_hourly" to "service_role";

grant references on table "public"."global_stats_hourly" to "service_role";

grant select on table "public"."global_stats_hourly" to "service_role";

grant trigger on table "public"."global_stats_hourly" to "service_role";

grant truncate on table "public"."global_stats_hourly" to "service_role";

grant update on table "public"."global_stats_hourly" to "service_role";

grant delete on table "service"."live_activity_events" to "anon";

grant insert on table "service"."live_activity_events" to "anon";

grant references on table "service"."live_activity_events" to "anon";

grant select on table "service"."live_activity_events" to "anon";

grant trigger on table "service"."live_activity_events" to "anon";

grant truncate on table "service"."live_activity_events" to "anon";

grant update on table "service"."live_activity_events" to "anon";

grant delete on table "service"."live_activity_events" to "authenticated";

grant insert on table "service"."live_activity_events" to "authenticated";

grant references on table "service"."live_activity_events" to "authenticated";

grant select on table "service"."live_activity_events" to "authenticated";

grant trigger on table "service"."live_activity_events" to "authenticated";

grant truncate on table "service"."live_activity_events" to "authenticated";

grant update on table "service"."live_activity_events" to "authenticated";

grant delete on table "service"."live_activity_events" to "service_role";

grant insert on table "service"."live_activity_events" to "service_role";

grant references on table "service"."live_activity_events" to "service_role";

grant select on table "service"."live_activity_events" to "service_role";

grant trigger on table "service"."live_activity_events" to "service_role";

grant truncate on table "service"."live_activity_events" to "service_role";

grant update on table "service"."live_activity_events" to "service_role";

grant delete on table "service"."live_activity_sessions" to "anon";

grant insert on table "service"."live_activity_sessions" to "anon";

grant references on table "service"."live_activity_sessions" to "anon";

grant select on table "service"."live_activity_sessions" to "anon";

grant trigger on table "service"."live_activity_sessions" to "anon";

grant truncate on table "service"."live_activity_sessions" to "anon";

grant update on table "service"."live_activity_sessions" to "anon";

grant delete on table "service"."live_activity_sessions" to "authenticated";

grant insert on table "service"."live_activity_sessions" to "authenticated";

grant references on table "service"."live_activity_sessions" to "authenticated";

grant select on table "service"."live_activity_sessions" to "authenticated";

grant trigger on table "service"."live_activity_sessions" to "authenticated";

grant truncate on table "service"."live_activity_sessions" to "authenticated";

grant update on table "service"."live_activity_sessions" to "authenticated";

grant delete on table "service"."live_activity_sessions" to "service_role";

grant insert on table "service"."live_activity_sessions" to "service_role";

grant references on table "service"."live_activity_sessions" to "service_role";

grant select on table "service"."live_activity_sessions" to "service_role";

grant trigger on table "service"."live_activity_sessions" to "service_role";

grant truncate on table "service"."live_activity_sessions" to "service_role";

grant update on table "service"."live_activity_sessions" to "service_role";

grant delete on table "service"."website_redirect_clicks" to "anon";

grant insert on table "service"."website_redirect_clicks" to "anon";

grant references on table "service"."website_redirect_clicks" to "anon";

grant select on table "service"."website_redirect_clicks" to "anon";

grant trigger on table "service"."website_redirect_clicks" to "anon";

grant truncate on table "service"."website_redirect_clicks" to "anon";

grant update on table "service"."website_redirect_clicks" to "anon";

grant delete on table "service"."website_redirect_clicks" to "authenticated";

grant insert on table "service"."website_redirect_clicks" to "authenticated";

grant references on table "service"."website_redirect_clicks" to "authenticated";

grant select on table "service"."website_redirect_clicks" to "authenticated";

grant trigger on table "service"."website_redirect_clicks" to "authenticated";

grant truncate on table "service"."website_redirect_clicks" to "authenticated";

grant update on table "service"."website_redirect_clicks" to "authenticated";

grant delete on table "service"."website_redirect_clicks" to "service_role";

grant insert on table "service"."website_redirect_clicks" to "service_role";

grant references on table "service"."website_redirect_clicks" to "service_role";

grant select on table "service"."website_redirect_clicks" to "service_role";

grant trigger on table "service"."website_redirect_clicks" to "service_role";

grant truncate on table "service"."website_redirect_clicks" to "service_role";

grant update on table "service"."website_redirect_clicks" to "service_role";

grant delete on table "service"."website_redirects" to "anon";

grant insert on table "service"."website_redirects" to "anon";

grant references on table "service"."website_redirects" to "anon";

grant select on table "service"."website_redirects" to "anon";

grant trigger on table "service"."website_redirects" to "anon";

grant truncate on table "service"."website_redirects" to "anon";

grant update on table "service"."website_redirects" to "anon";

grant delete on table "service"."website_redirects" to "authenticated";

grant insert on table "service"."website_redirects" to "authenticated";

grant references on table "service"."website_redirects" to "authenticated";

grant select on table "service"."website_redirects" to "authenticated";

grant trigger on table "service"."website_redirects" to "authenticated";

grant truncate on table "service"."website_redirects" to "authenticated";

grant update on table "service"."website_redirects" to "authenticated";

grant delete on table "service"."website_redirects" to "service_role";

grant insert on table "service"."website_redirects" to "service_role";

grant references on table "service"."website_redirects" to "service_role";

grant select on table "service"."website_redirects" to "service_role";

grant trigger on table "service"."website_redirects" to "service_role";

grant truncate on table "service"."website_redirects" to "service_role";

grant update on table "service"."website_redirects" to "service_role";


  create policy "global_stats_hourly_select_clients"
  on "public"."global_stats_hourly"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "global_stats_hourly_service_role"
  on "public"."global_stats_hourly"
  as permissive
  for all
  to service_role
using (true)
with check (true);



  create policy "roaster_enrichment_jobs_insert_admin"
  on "service"."roaster_enrichment_jobs"
  as permissive
  for insert
  to public
with check ((public.is_admin() AND (state = 'queued'::text) AND (attempts = 0)));



  create policy "Allow service role all"
  on "service"."website_redirect_clicks"
  as permissive
  for all
  to public
using (true)
with check (true);



  create policy "Allow public read"
  on "service"."website_redirects"
  as permissive
  for select
  to public
using (true);



  create policy "Allow service role all"
  on "service"."website_redirects"
  as permissive
  for all
  to public
using (true)
with check (true);


CREATE TRIGGER trg_live_activity_events_updated_at BEFORE UPDATE ON service.live_activity_events FOR EACH ROW EXECUTE FUNCTION service.update_updated_at_column();

CREATE TRIGGER trg_live_activity_sessions_updated_at BEFORE UPDATE ON service.live_activity_sessions FOR EACH ROW EXECUTE FUNCTION service.update_updated_at_column();

-- Note: Storage triggers on storage.objects, storage.prefixes, and storage.buckets 
-- are managed by Supabase and cannot be modified by user migrations.
-- The following statements were removed to prevent permission errors:
-- drop trigger if exists "objects_delete_delete_prefix" on "storage"."objects";
-- drop trigger if exists "objects_insert_create_prefix" on "storage"."objects";
-- drop trigger if exists "objects_update_create_prefix" on "storage"."objects";
-- drop trigger if exists "prefixes_create_hierarchy" on "storage"."prefixes";
-- drop trigger if exists "prefixes_delete_hierarchy" on "storage"."prefixes";
-- CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets ...
-- CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects ...


