-- Repair launch-popup translation calls and preserve platform for scheduled
-- popups. translate-openai keeps built-in JWT verification enabled, so this
-- caller must use the legacy service-role JWT in Authorization. New-style
-- sb_secret keys sent via apikey require verify_jwt=false plus in-function
-- authorization and are therefore intentionally not used here.

create or replace function public.translate_launch_popup()
 returns trigger
 language plpgsql
 set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
declare
  project_url text := (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'supabase_url'
  );
  service_key text := (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'service_role_key'
  );
  locales text[];
begin
  if new.is_translated then
    return new;
  end if;

  if project_url is null then
    raise exception 'Vault secret supabase_url is not set.';
  end if;

  if service_key is null then
    raise exception 'Vault secret service_role_key is not set.';
  end if;

  select array_agg(locale order by locale)
  into locales
  from public.supported_locales
  where locale <> 'en';

  if coalesce(cardinality(locales), 0) = 0 then
    return new;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/translate-openai',
    body := jsonb_build_object(
      'text', new.content,
      'locales', locales,
      'platform', new.platform
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    timeout_milliseconds := 300000
  );

  return new;
end;
$function$;

-- Keep the existing three-argument RPC for already-deployed callers. New
-- callers use the four-argument overload so platform survives the queue.
create or replace function public.enqueue_popup(
  _content text,
  _locale text,
  _run_at timestamp with time zone,
  _platform text
)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public', 'pgmq', 'pg_catalog'
as $function$
declare
  msg_id bigint;
  delay_seconds integer;
  platform_value text;
begin
  delay_seconds := greatest(
    extract(epoch from (_run_at - now()))::integer,
    0
  );

  platform_value := case
    when _platform in ('ios', 'android', 'web', 'all') then _platform
    else 'all'
  end;

  select pgmq.send(
    'scheduled_launch_popup',
    jsonb_build_object(
      'content', _content,
      'locale', _locale,
      'platform', platform_value
    ),
    delay_seconds
  )
  into msg_id;

  return msg_id;
end;
$function$;

create or replace function public.enqueue_popup(
  _content text,
  _locale text,
  _run_at timestamp with time zone
)
 returns bigint
 language sql
 security definer
 set search_path to 'public', 'pg_catalog'
as $function$
  select public.enqueue_popup(_content, _locale, _run_at, 'all');
$function$;

-- Both overloads enqueue globally visible content. Only the service-role
-- scheduling function may call them.
revoke all on function public.enqueue_popup(text, text, timestamp with time zone, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_popup(text, text, timestamp with time zone, text)
  to service_role;

revoke all on function public.enqueue_popup(text, text, timestamp with time zone)
  from public, anon, authenticated;
grant execute on function public.enqueue_popup(text, text, timestamp with time zone)
  to service_role;

create or replace function public.process_due_popups()
 returns void
 language plpgsql
 set search_path to 'public', 'pgmq', 'pg_catalog'
as $function$
declare
  m pgmq.message_record;
  platform_value text;
begin
  loop
    select *
    into m
    from pgmq.read('scheduled_launch_popup', 60, 25);

    exit when m is null;

    platform_value := case
      when m.message ->> 'platform' in ('ios', 'android', 'web', 'all')
        then m.message ->> 'platform'
      else 'all'
    end;

    insert into public.launch_popup (content, locale, platform)
    values (
      (m.message ->> 'content')::text,
      (m.message ->> 'locale')::text,
      platform_value
    );

    perform pgmq.delete('scheduled_launch_popup', m.msg_id);
  end loop;
end;
$function$;
