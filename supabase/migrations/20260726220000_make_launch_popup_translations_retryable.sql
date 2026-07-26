-- Make launch-popup translation idempotent and retryable without enrolling
-- historical rows. Every added column is nullable and has no default/backfill;
-- only English source rows inserted after this migration are enrolled by the
-- insert trigger.

alter table public.launch_popup
  add column source_popup_id bigint,
  add column translation_status text,
  add column translation_attempts integer,
  add column translation_last_attempt_at timestamp with time zone,
  add column translation_error text;

alter table public.launch_popup
  add constraint launch_popup_source_popup_id_fkey
    foreign key (source_popup_id)
    references public.launch_popup (id)
    on delete cascade,
  add constraint launch_popup_translation_status_check
    check (
      translation_status is null
      or translation_status in (
        'pending',
        'processing',
        'partial',
        'completed',
        'failed'
      )
    ),
  add constraint launch_popup_translation_attempts_check
    check (
      translation_attempts is null
      or translation_attempts >= 0
    ),
  add constraint launch_popup_source_locale_key
    unique (source_popup_id, locale);

comment on column public.launch_popup.source_popup_id is
  'English source launch_popup row for a translated child; NULL on source and legacy rows.';
comment on column public.launch_popup.translation_status is
  'Internal translation lifecycle for newly enrolled English source rows.';
comment on column public.launch_popup.translation_attempts is
  'Number of translation requests queued for a newly enrolled English source row.';
comment on column public.launch_popup.translation_last_attempt_at is
  'Timestamp of the latest translation request for a newly enrolled English source row.';
comment on column public.launch_popup.translation_error is
  'Most recent translation error for a newly enrolled English source row.';

-- translate-openai retains built-in JWT verification. Keep the authenticated
-- pg_net request introduced by 20260726183000, preserve platform, and include
-- the source row id so translated inserts can use (source_popup_id, locale) as
-- their idempotency key.
create or replace function public.translate_launch_popup()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public', 'vault', 'net'
as $function$
declare
  project_url text;
  service_key text;
  locales text[];
begin
  -- Translated children and non-English source inserts must never fan out.
  if new.is_translated
    or new.source_popup_id is not null
    or new.locale is distinct from 'en'
  then
    return new;
  end if;

  select array_agg(locale order by locale)
  into locales
  from public.supported_locales
  where locale <> 'en';

  -- This is deliberately scoped by NEW.id. Historical is_translated=false
  -- rows remain unenrolled with NULL lifecycle fields.
  update public.launch_popup
  set
    translation_status = 'pending',
    translation_attempts = 1,
    translation_last_attempt_at = statement_timestamp(),
    translation_error = null
  where id = new.id
    and source_popup_id is null
    and is_translated is not true
    and locale = 'en';

  if coalesce(cardinality(locales), 0) = 0 then
    return new;
  end if;

  select decrypted_secret
  into project_url
  from vault.decrypted_secrets
  where name = 'supabase_url';

  select decrypted_secret
  into service_key
  from vault.decrypted_secrets
  where name = 'service_role_key';

  if project_url is null then
    raise exception 'Vault secret supabase_url is not set.';
  end if;

  if service_key is null then
    raise exception 'Vault secret service_role_key is not set.';
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/translate-openai',
    body := jsonb_build_object(
      'text', new.content,
      'locales', locales,
      'platform', new.platform,
      'source_popup_id', new.id
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

comment on function public.translate_launch_popup() is
  'Enrolls a newly inserted English launch-popup source and queues one authenticated translate-openai request.';

-- Trigger functions are internal implementation details, not PostgREST RPCs.
revoke execute on function public.translate_launch_popup()
  from public, anon, authenticated;
grant execute on function public.translate_launch_popup()
  to service_role;

-- Reconcile only rows explicitly enrolled above. NULL status/attempt fields
-- exclude every historical row, even if is_translated=false.
create or replace function public.reconcile_launch_popup_translations()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  source_row record;
  missing_locales text[];
  missing_count integer;
  target_count integer;
  next_attempt integer;
  retry_status text;
  project_url text;
  service_key text;
  credentials_loaded boolean := false;
begin
  for source_row in
    select
      source.id,
      source.content,
      source.platform,
      source.translation_attempts
    from public.launch_popup as source
    where source.source_popup_id is null
      and source.locale = 'en'
      and source.is_translated is not true
      and source.translation_status in (
        'pending',
        'processing',
        'partial',
        'failed'
      )
      and source.translation_attempts is not null
      and source.translation_last_attempt_at
        <= statement_timestamp() - interval '5 minutes'
      and (
        source.translation_attempts < 3
        or (
          source.translation_attempts >= 3
          and source.translation_status <> 'failed'
        )
      )
    order by source.translation_last_attempt_at, source.id
    limit 10
    for update skip locked
  loop
    select
      array_agg(locale order by locale),
      count(*)::integer
    into missing_locales, missing_count
    from public.supported_locales as supported
    where supported.locale <> 'en'
      and not exists (
        select 1
        from public.launch_popup as translated
        where translated.source_popup_id = source_row.id
          and translated.locale = supported.locale
          and translated.is_translated is true
      );

    select count(*)::integer
    into target_count
    from public.supported_locales
    where locale <> 'en';

    if missing_count = 0 then
      update public.launch_popup
      set
        translation_status = 'completed',
        translation_error = null
      where id = source_row.id;
      continue;
    end if;

    if source_row.translation_attempts >= 3 then
      update public.launch_popup
      set
        translation_status = 'failed',
        translation_error = coalesce(
          translation_error,
          format(
            'Translation retry limit reached with %s locale(s) missing.',
            missing_count
          )
        )
      where id = source_row.id;
      continue;
    end if;

    if not credentials_loaded then
      select decrypted_secret
      into project_url
      from vault.decrypted_secrets
      where name = 'supabase_url';

      select decrypted_secret
      into service_key
      from vault.decrypted_secrets
      where name = 'service_role_key';

      if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
      end if;

      if service_key is null then
        raise exception 'Vault secret service_role_key is not set.';
      end if;

      credentials_loaded := true;
    end if;

    next_attempt := source_row.translation_attempts + 1;
    retry_status := case
      when missing_count < target_count then 'partial'
      else 'processing'
    end;

    update public.launch_popup
    set
      translation_status = retry_status,
      translation_attempts = next_attempt,
      translation_last_attempt_at = statement_timestamp(),
      translation_error = null
    where id = source_row.id;

    begin
      perform net.http_post(
        url := project_url || '/functions/v1/translate-openai',
        body := jsonb_build_object(
          'text', source_row.content,
          'locales', missing_locales,
          'platform', source_row.platform,
          'source_popup_id', source_row.id
        ),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_key
        ),
        timeout_milliseconds := 300000
      );
    exception
      when others then
        -- A failed attempt below the limit remains eligible for a later
        -- reconciliation run. Attempt 3 is the only terminal failure.
        update public.launch_popup
        set
          translation_status = case
            when next_attempt >= 3 then 'failed'
            when missing_count < target_count then 'partial'
            else 'pending'
          end,
          translation_error = sqlerrm
        where id = source_row.id;
    end;
  end loop;
end;
$function$;

comment on function public.reconcile_launch_popup_translations() is
  'Retries up to 10 stale, explicitly enrolled launch-popup sources per run, requesting only missing supported locales and stopping after 3 attempts.';

revoke execute on function public.reconcile_launch_popup_translations()
  from public, anon, authenticated;
grant execute on function public.reconcile_launch_popup_translations()
  to service_role;

-- Recreate by name so repeated development resets cannot accumulate duplicate
-- reconciliation jobs. The function itself also uses row locks and a hard
-- batch limit to keep each scheduled invocation bounded.
do $cron$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'reconcile-launch-popup-translations'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'reconcile-launch-popup-translations',
    '*/5 * * * *',
    'select public.reconcile_launch_popup_translations();'
  );
end;
$cron$
language plpgsql;

-- Canary verification/cleanup:
-- Insert the controlled English source with platform = 'internal_canary' and
-- retain its id. After inspecting all linked translations, delete only that
-- source row:
--   delete from public.launch_popup
--   where id = <canary_source_id>
--     and source_popup_id is null
--     and platform = 'internal_canary';
-- The self-FK ON DELETE CASCADE removes only that source's translated children.
