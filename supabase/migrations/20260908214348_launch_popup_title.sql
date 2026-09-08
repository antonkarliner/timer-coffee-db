-- Plan 054, Item C — optional per-popup dialog title on public.launch_popup.
--
-- Both client surfaces (the home-screen modal and the finish-screen expanded
-- card) hardcode a localized "What's new" as the dialog heading. A Coffee Day
-- greeting, a Black Friday campaign, a giveaway notice and a yearly recap all
-- render under it. This adds a nullable title the operator can set per popup;
-- the client renders `popup.title ?? l10n.whatsnewtitle`, so a NULL title is a
-- byte-identical no-op.
--
-- Unlike the campaign columns added in 20260908120000, the title is NOT
-- inherited by translated children — see the note at the bottom of this file.
--
-- RLS/GRANTs: public.launch_popup already has RLS enabled with a single,
-- column-agnostic SELECT policy (`Enable read access for all users`
-- USING (true)) and table-level SELECT granted to anon, authenticated and
-- service_role. Verified against production before writing this migration;
-- both are column-agnostic, so the new column is covered with no new policy
-- or grant.

alter table public.launch_popup
  add column if not exists title text;

comment on column public.launch_popup.title is
  'Optional dialog title for this popup. NULL means the client falls back to its localized "What''s new" string. Translated child rows receive their own TRANSLATED title from the translate-openai pipeline, not a copy of this one. Plan 054 Item C.';

-- ── The scheduled path must carry the title through the queue ────────────────
--
-- Scheduling goes public.enqueue_popup -> pgmq queue 'scheduled_launch_popup'
-- -> public.process_due_popups. The queue message carried only content, locale
-- and platform, so a title set on a scheduled popup would be silently dropped.
--
-- enqueue_popup is dropped and recreated rather than replaced in place: adding
-- a defaulted `_title` to the existing 4-argument function would make a
-- 4-argument call ambiguous against it ("function ... is not unique"). Dropping
-- the 4-arg overload first lets already-deployed 4-argument callers (the
-- admin-launch-popup and schedule-launch-popup edge functions) keep resolving
-- via the default. The legacy 3-argument overload is untouched — three
-- arguments cannot match a function requiring at least four.
--
-- SECURITY: `create or replace` preserves a function's ACL, but `drop` +
-- `create` does NOT — the new function would be created with the default
-- PUBLIC EXECUTE. The dropped function's live ACL was
-- `postgres=X/postgres | service_role=X/postgres` (PUBLIC revoked), so the
-- revoke/grant below is mandatory, not decorative: without it `anon` would
-- gain the ability to enqueue launch popups.

drop function if exists public.enqueue_popup(text, text, timestamptz, text);

create or replace function public.enqueue_popup(
  _content text,
  _locale text,
  _run_at timestamptz,
  _platform text,
  _title text default null
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
      'platform', platform_value,
      'title', _title
    ),
    delay_seconds
  )
  into msg_id;

  return msg_id;
end;
$function$;

comment on function public.enqueue_popup(text, text, timestamptz, text, text) is
  'Enqueues a launch popup for later publication, carrying an optional title. Plan 054 Item C.';

revoke execute on function public.enqueue_popup(text, text, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_popup(text, text, timestamptz, text, text)
  to service_role;

-- process_due_popups uses `create or replace`, which preserves its existing
-- ACL — deliberately no grants here, and its current permissions are out of
-- scope for this migration. `->>` yields NULL for a missing key, so messages
-- already sitting in the queue from before this migration still publish.

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

    insert into public.launch_popup (content, locale, platform, title)
    values (
      (m.message ->> 'content')::text,
      (m.message ->> 'locale')::text,
      platform_value,
      (m.message ->> 'title')::text
    );

    perform pgmq.delete('scheduled_launch_popup', m.msg_id);
  end loop;
end;
$function$;

-- ── Both translation entry points must forward the title ────────────────────
--
-- These two bodies are reproduced from the LIVE production definitions, not
-- from 20260726220000: a later migration
-- (20260726221000_fan_out_launch_popup_translation_requests) rewrote both to
-- fan out one request per batch of three locales. Copying the older bodies
-- would silently revert that batching. The only change below is the added
-- 'title' key in each jsonb_build_object, plus selecting source.title in the
-- reconcile cursor.

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
        'source_popup_id', new.id,
        'title', new.title
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
  'Enrolls a newly inserted English launch-popup source and queues one authenticated translate-openai request per batch of three locales, forwarding the optional title.';

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
      source.title,
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
            'source_popup_id', source_row.id,
            'title', source_row.title
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
  'Retries up to 10 stale, explicitly enrolled launch-popup sources per run, requesting only missing supported locales in batches of three and forwarding the optional title, stopping after 3 attempts.';

revoke execute on function public.reconcile_launch_popup_translations()
  from public, anon, authenticated;
grant execute on function public.reconcile_launch_popup_translations()
  to service_role;

-- ── Why the title is NOT added to the campaign-field triggers ────────────────
--
-- 20260908120000 added inherit_launch_popup_campaign_fields() (BEFORE INSERT)
-- and propagate_launch_popup_campaign_fields() (AFTER UPDATE), which copy the
-- campaign columns from an English source onto its translated children so a
-- campaign renders in every locale.
--
-- The title deliberately does NOT join them. Each translated child receives its
-- own TRANSLATED title from the translate-openai pipeline; if the inherit
-- trigger also wrote the parent's title, it would overwrite that translation
-- with English on every insert and every retry upsert — a title rendering in
-- English across 21 locales, which is worse than no title at all.
--
-- Consequence, accepted deliberately and consistent with how `content` already
-- behaves: editing a source popup's title AFTER its children have been
-- translated does not propagate. Fixing a typo in a published title means
-- re-translating, exactly as it does for the body copy.
