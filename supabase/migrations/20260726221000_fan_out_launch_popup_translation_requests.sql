-- Keep each translate-openai invocation within the live-tested three-locale
-- worker budget. A translation attempt remains one logical wave even though
-- the database queues several bounded pg_net requests for that wave.

create or replace function public.guard_launch_popup_translation_status()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
declare
  target_count integer;
  translated_count integer;
  attempts integer := coalesce(new.translation_attempts, 0);
begin
  -- Only lifecycle-enabled English source rows need aggregate status.
  -- Historical rows remain excluded because their attempts field is NULL.
  if new.source_popup_id is not null
    or new.locale is distinct from 'en'
    or new.translation_status is null
    or new.translation_attempts is null
  then
    return new;
  end if;

  select count(*)::integer
  into target_count
  from public.supported_locales
  where locale <> 'en';

  select count(distinct translated.locale)::integer
  into translated_count
  from public.launch_popup as translated
  where translated.source_popup_id = new.id
    and translated.is_translated is true
    and exists (
      select 1
      from public.supported_locales as supported
      where supported.locale = translated.locale
        and supported.locale <> 'en'
    );

  if translated_count >= target_count then
    new.translation_status := 'completed';
    new.translation_error := null;
    return new;
  end if;

  -- Once attempt three has recorded a terminal failure, later successful
  -- sibling batches must not clear it while locales are still missing. A
  -- final successful batch can still move it to completed via the branch
  -- above.
  if attempts >= 3
    and (
      old.translation_status = 'failed'
      or (
        new.translation_status in ('failed', 'partial')
        and new.translation_error is not null
      )
    )
  then
    new.translation_status := 'failed';
    new.translation_error := coalesce(
      new.translation_error,
      old.translation_error,
      format(
        'Translation retry limit reached with %s locale(s) missing.',
        target_count - translated_count
      )
    );
    return new;
  end if;

  if translated_count > 0 then
    new.translation_status := 'partial';
    return new;
  end if;

  -- A successful subset request cannot complete a source with no persisted
  -- supported translations. Keep it retryable instead.
  if new.translation_status in ('completed', 'partial') then
    new.translation_status := case
      when attempts >= 3 then 'failed'
      else 'pending'
    end;
    if new.translation_status = 'failed' then
      new.translation_error := coalesce(
        new.translation_error,
        format(
          'Translation retry limit reached with %s locale(s) missing.',
          target_count
        )
      );
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.guard_launch_popup_translation_status() is
  'Derives lifecycle status for an enrolled English launch-popup source from all supported translated children.';

revoke execute on function public.guard_launch_popup_translation_status()
  from public, anon, authenticated;
grant execute on function public.guard_launch_popup_translation_status()
  to service_role;

comment on column public.launch_popup.translation_attempts is
  'Number of logical translation waves queued for a newly enrolled English source row; each wave may contain multiple bounded requests.';

drop trigger if exists guard_launch_popup_translation_status_before_update
  on public.launch_popup;

create trigger guard_launch_popup_translation_status_before_update
before update of translation_status, translation_error
on public.launch_popup
for each row
execute function public.guard_launch_popup_translation_status();

create or replace function public.translate_launch_popup()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
declare
  project_url text;
  service_key text;
  locale_batch text[];
  target_count integer;
begin
  -- Translated children and non-English source inserts must never fan out.
  if new.is_translated
    or new.source_popup_id is not null
    or new.locale is distinct from 'en'
  then
    return new;
  end if;

  select count(*)::integer
  into target_count
  from public.supported_locales
  where locale <> 'en';

  -- This remains scoped by NEW.id, so historical rows stay unenrolled.
  update public.launch_popup
  set
    translation_status = case
      when target_count = 0 then 'completed'
      else 'pending'
    end,
    translation_attempts = 1,
    translation_last_attempt_at = statement_timestamp(),
    translation_error = null
  where id = new.id
    and source_popup_id is null
    and is_translated is not true
    and locale = 'en';

  if target_count = 0 then
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

  for locale_batch in
    select array_agg(ranked.locale order by ranked.locale)
    from (
      select
        supported.locale,
        (
          row_number() over (order by supported.locale) - 1
        ) / 3 as batch_number
      from public.supported_locales as supported
      where supported.locale <> 'en'
    ) as ranked
    group by ranked.batch_number
    order by ranked.batch_number
  loop
    perform net.http_post(
      url := project_url || '/functions/v1/translate-openai',
      body := jsonb_build_object(
        'text', new.content,
        'locales', locale_batch,
        'platform', new.platform,
        'source_popup_id', new.id
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      timeout_milliseconds := 300000
    );
  end loop;

  return new;
end;
$function$;

comment on function public.translate_launch_popup() is
  'Enrolls a new English launch-popup source and queues authenticated translate-openai requests in batches of at most three locales.';

revoke execute on function public.translate_launch_popup()
  from public, anon, authenticated;
grant execute on function public.translate_launch_popup()
  to service_role;

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
  locale_batch text[];
  queue_error text;
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
    queue_error := null;

    update public.launch_popup
    set
      translation_status = retry_status,
      translation_attempts = next_attempt,
      translation_last_attempt_at = statement_timestamp(),
      translation_error = null
    where id = source_row.id;

    for locale_batch in
      select array_agg(ranked.locale order by ranked.locale)
      from (
        select
          missing.locale,
          (
            row_number() over (order by missing.locale) - 1
          ) / 3 as batch_number
        from unnest(missing_locales) as missing(locale)
      ) as ranked
      group by ranked.batch_number
      order by ranked.batch_number
    loop
      begin
        perform net.http_post(
          url := project_url || '/functions/v1/translate-openai',
          body := jsonb_build_object(
            'text', source_row.content,
            'locales', locale_batch,
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
          queue_error := left(
            concat_ws('; ', queue_error, sqlerrm),
            500
          );
      end;
    end loop;

    if queue_error is not null then
      update public.launch_popup
      set
        translation_status = case
          when next_attempt >= 3 then 'failed'
          when missing_count < target_count then 'partial'
          else 'pending'
        end,
        translation_error = queue_error
      where id = source_row.id;
    end if;
  end loop;
end;
$function$;

comment on function public.reconcile_launch_popup_translations() is
  'Retries up to 10 stale enrolled launch-popup sources per run, queueing only missing locales in batches of at most three and stopping after three waves.';

revoke execute on function public.reconcile_launch_popup_translations()
  from public, anon, authenticated;
grant execute on function public.reconcile_launch_popup_translations()
  to service_role;
