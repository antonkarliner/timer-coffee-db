drop trigger if exists "process_new_coffee_roaster_logo" on "public"."coffee_roasters";

drop trigger if exists "check_new_roaster" on "public"."global_coffee_beans";

alter table "public"."global_stats" add column "country_code" character(2);

alter table "public"."user_coffee_beans" add column "photo_url" text;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.insert_analytics_events(events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO analytics.raw_events (event_name, category, session_id, install_id, platform, app_version, properties, client_ts, country)
  SELECT
    e->>'event_name',
    e->>'category',
    (e->>'session_id')::uuid,
    e->>'install_id',
    e->>'platform',
    e->>'app_version',
    COALESCE(e->'properties', '{}'::jsonb),
    (e->>'client_ts')::timestamptz,
    NULLIF(e->>'country', '')
  FROM jsonb_array_elements(events) AS e;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  RETURN jsonb_build_object('inserted', inserted_count);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.insert_bmc_support_event(p_configured_event_type text, p_payload jsonb, p_payload_sha256 text, p_signature_header text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event_id uuid;
  v_received_at timestamptz := now();
  v_candidate_count integer := 0;
  v_match_status text := 'not_applicable';
  v_matched_install_id text;
  v_matched_platform text;
  v_matched_button_event_id uuid;
  v_matched_button_ts timestamptz;
  v_provider_event_id text := nullif(p_payload->>'event_id', '');
begin
  if v_provider_event_id is not null then
    select
      id,
      candidate_count,
      match_status,
      matched_install_id,
      matched_platform,
      matched_button_event_id,
      matched_button_ts
    into
      v_event_id,
      v_candidate_count,
      v_match_status,
      v_matched_install_id,
      v_matched_platform,
      v_matched_button_event_id,
      v_matched_button_ts
    from analytics.bmc_support_events
    where configured_event_type = p_configured_event_type
      and payload->>'event_id' = v_provider_event_id
    limit 1;

    if v_event_id is not null then
      return jsonb_build_object(
        'inserted', false,
        'event_id', v_event_id,
        'match_status', v_match_status,
        'candidate_count', v_candidate_count,
        'matched_install_id', v_matched_install_id,
        'matched_platform', v_matched_platform,
        'matched_button_event_id', v_matched_button_event_id,
        'matched_button_ts', v_matched_button_ts
      );
    end if;
  end if;

  insert into analytics.bmc_support_events (
    configured_event_type,
    received_at,
    payload,
    payload_sha256,
    signature_header
  )
  values (
    p_configured_event_type,
    v_received_at,
    p_payload,
    p_payload_sha256,
    p_signature_header
  )
  on conflict do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select
      id,
      candidate_count,
      match_status,
      matched_install_id,
      matched_platform,
      matched_button_event_id,
      matched_button_ts
    into
      v_event_id,
      v_candidate_count,
      v_match_status,
      v_matched_install_id,
      v_matched_platform,
      v_matched_button_event_id,
      v_matched_button_ts
    from analytics.bmc_support_events
    where configured_event_type = p_configured_event_type
      and (
        (v_provider_event_id is not null and payload->>'event_id' = v_provider_event_id)
        or payload_sha256 = p_payload_sha256
      )
    order by received_at desc
    limit 1;

    return jsonb_build_object(
      'inserted', false,
      'event_id', v_event_id,
      'match_status', v_match_status,
      'candidate_count', v_candidate_count,
      'matched_install_id', v_matched_install_id,
      'matched_platform', v_matched_platform,
      'matched_button_event_id', v_matched_button_event_id,
      'matched_button_ts', v_matched_button_ts
    );
  end if;

  if p_configured_event_type in ('support_created', 'monthly_support_started') then
    select count(*)::integer
    into v_candidate_count
    from analytics.raw_events
    where event_name = 'donation_button_tapped'
      and properties->>'product_id' = 'buymeacoffee_external'
      and server_ts between v_received_at - interval '10 minutes' and v_received_at;

    if v_candidate_count = 1 then
      v_match_status := 'matched';

      select
        install_id,
        platform,
        id,
        server_ts
      into
        v_matched_install_id,
        v_matched_platform,
        v_matched_button_event_id,
        v_matched_button_ts
      from analytics.raw_events
      where event_name = 'donation_button_tapped'
        and properties->>'product_id' = 'buymeacoffee_external'
        and server_ts between v_received_at - interval '10 minutes' and v_received_at
      order by server_ts desc
      limit 1;
    elsif v_candidate_count = 0 then
      v_match_status := 'unmatched';
    else
      v_match_status := 'ambiguous';
    end if;
  end if;

  update analytics.bmc_support_events
  set
    match_status = v_match_status,
    candidate_count = v_candidate_count,
    matched_install_id = v_matched_install_id,
    matched_platform = v_matched_platform,
    matched_button_event_id = v_matched_button_event_id,
    matched_button_ts = v_matched_button_ts
  where id = v_event_id;

  return jsonb_build_object(
    'inserted', true,
    'event_id', v_event_id,
    'match_status', v_match_status,
    'candidate_count', v_candidate_count,
    'matched_install_id', v_matched_install_id,
    'matched_platform', v_matched_platform,
    'matched_button_event_id', v_matched_button_event_id,
    'matched_button_ts', v_matched_button_ts
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.check_new_version_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  project_url text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
  );
  service_key text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
  );
begin
  if project_url is null then
    raise exception 'Vault secret supabase_url is not set.';
  end if;

  if service_key is null then
    raise exception 'Vault secret service_role_key is not set.';
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/check-new-version',
    body := jsonb_build_object('trigger', 'pg_cron', 'timestamp', timezone('utc', now())),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    timeout_milliseconds := 30000
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.translate_launch_popup()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  edge_function_url TEXT := 'https://mprokbemdullwezwwscn.supabase.co/functions/v1/translate-openai';
  locales TEXT[];
BEGIN
  -- Skip if this row is already a translated insert
  IF NEW.is_translated THEN
    RETURN NEW;
  END IF;

  -- Gather target locales (exclude source 'en')
  SELECT array_agg(locale) INTO locales
  FROM supported_locales
  WHERE locale <> 'en';

  -- Call Edge function with text, locales, and ORIGINAL platform
  PERFORM net.http_post(
    edge_function_url,
    jsonb_build_object(
      'text', NEW.content,
      'locales', locales,
      'platform', NEW.platform  -- <- added
    ),
    '{}'::jsonb,
    jsonb_build_object('Content-Type','application/json'),
    300000
  );

  -- Mark this source row as processed (note: AFTER trigger; return value won't update row)
  NEW.is_translated := true;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.translate_notification_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    edge_function_url TEXT := 'https://mprokbemdullwezwwscn.supabase.co/functions/v1/translate-and-send-notification';
    locales TEXT[];
    notification_group_id TEXT;
BEGIN
    -- Skip if this row is already translated
    IF NEW.is_translated THEN
        RETURN NEW;
    END IF;

    -- Generate notification group ID if not present
    notification_group_id := COALESCE(NEW.notification_group_id, gen_random_uuid()::text);
    
    -- Update the notification with the group ID
    UPDATE public.notifications 
    SET notification_group_id = notification_group_id 
    WHERE id = NEW.id;

    -- Gather target locales (exclude source locale)
    SELECT array_agg(locale) INTO locales
    FROM supported_locales
    WHERE locale <> NEW.locale;

    -- Call Edge function with translation request and security header
    PERFORM net.http_post(
        url := edge_function_url,
        body := jsonb_build_object(
            'title', NEW.title,
            'content', NEW.content,
            'locales', locales,
            'platform', NEW.platform,
            'deep_link', NEW.deep_link,
            'scheduled_at', NEW.scheduled_at,
            'notification_group_id', notification_group_id
        ),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
            'X-System-Call', 'database-trigger'
        ),
        timeout_milliseconds := 300000
    );

    -- Mark as being processed
    RETURN NEW;
END;
$function$
;

grant select on table "public"."global_stats" to "anon";

grant select on table "public"."global_stats" to "authenticated";

CREATE TRIGGER process_new_coffee_roaster_logo AFTER INSERT ON public.coffee_roasters FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://mprokbemdullwezwwscn.supabase.co/functions/v1/roaster-logo-mirror', 'POST', '{"Content-type":"application/json"}', '{}', '5000');

CREATE TRIGGER check_new_roaster AFTER INSERT ON public.global_coffee_beans FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://mprokbemdullwezwwscn.supabase.co/functions/v1/check-new-roaster', 'POST', '{"Content-type":"application/json"}', '{"body":"json_build_object(''type'', TG_OP, ''record'', row_to_json(NEW))::text"}', '1000');


