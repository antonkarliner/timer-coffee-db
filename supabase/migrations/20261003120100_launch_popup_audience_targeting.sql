-- Plan 041 §3 (SQL) and §4.1–§4.4: shared audience validation/matching,
-- safe legacy reads, scheduled visibility, targeted RPC, and scoped translations.
-- File only: the operator applies this migration. No queue functions are removed.

create or replace function public.is_valid_audience_filter(p jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog
as $function$
declare
  dimension record;
  item jsonb;
  value text;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' then return false; end if;
  for dimension in select * from jsonb_each(p) loop
    if dimension.key not in ('locales', 'countries', 'regions', 'platforms') then
      return false;
    end if;
    -- JSON null, missing keys and empty arrays impose no restriction.
    if dimension.value = 'null'::jsonb then continue; end if;
    if jsonb_typeof(dimension.value) <> 'array' then return false; end if;
    for item in select * from jsonb_array_elements(dimension.value) loop
      if jsonb_typeof(item) <> 'string' then return false; end if;
      value := item #>> '{}';
      if not (case dimension.key
        when 'locales' then length(value) between 2 and 10
          and value ~ '^[a-z]{2,10}(-[a-z0-9]+)*$'
        when 'countries' then value ~ '^[A-Z]{2}$'
        when 'regions' then value ~ '^[A-Z]{2,10}$'
        when 'platforms' then value in ('ios', 'android', 'web')
      end) then return false; end if;
    end loop;
  end loop;
  return true;
end;
$function$;

create or replace function public.audience_filter_matches(
  p_filter jsonb, p_locale text, p_platform text, p_country text, p_region text
)
returns boolean language plpgsql immutable set search_path = pg_catalog
as $function$
declare
  locales jsonb := coalesce(nullif(p_filter -> 'locales', 'null'::jsonb), '[]'::jsonb);
  platforms jsonb := coalesce(nullif(p_filter -> 'platforms', 'null'::jsonb), '[]'::jsonb);
  countries jsonb := coalesce(nullif(p_filter -> 'countries', 'null'::jsonb), '[]'::jsonb);
  regions jsonb := coalesce(nullif(p_filter -> 'regions', 'null'::jsonb), '[]'::jsonb);
begin
  if p_filter is null then return true; end if;
  if jsonb_array_length(locales) > 0 and not exists (
    select 1 from jsonb_array_elements_text(locales) as allowed(locale)
    where allowed.locale = lower(p_locale)
      or allowed.locale = split_part(lower(p_locale), '-', 1)
  ) then return false; end if;
  if jsonb_array_length(platforms) > 0 and not exists (
    select 1 from jsonb_array_elements_text(platforms) as allowed(platform)
    where allowed.platform = p_platform
  ) then return false; end if;
  if jsonb_array_length(countries) > 0 or jsonb_array_length(regions) > 0 then
    return exists (
      select 1 from jsonb_array_elements_text(countries) as allowed(country)
      where allowed.country = upper(p_country)
    ) or exists (
      select 1 from jsonb_array_elements_text(regions) as allowed(region)
      where allowed.region = upper(p_region)
    );
  end if;
  return true;
end;
$function$;

-- These two immutable argument-only helpers are safe for all API roles.
revoke execute on function public.is_valid_audience_filter(jsonb) from public, anon, authenticated;
grant execute on function public.is_valid_audience_filter(jsonb) to postgres, anon, authenticated, service_role;
revoke execute on function public.audience_filter_matches(jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.audience_filter_matches(jsonb, text, text, text, text) to postgres, anon, authenticated, service_role;

alter table public.launch_popup
  add column audience_filter jsonb,
  add column visible_from timestamptz,
  add constraint launch_popup_audience_filter_check
    check (public.is_valid_audience_filter(audience_filter));

comment on column public.launch_popup.audience_filter is
  'Plan 041: NULL means everyone; dimensions AND, country/region union. Unknown geography is excluded when geography is restricted.';
comment on column public.launch_popup.visible_from is
  'Earliest visibility; translations are prepared at insert time.';

alter table public.launch_popup enable row level security;
drop policy "Enable read access for all users" on public.launch_popup;
create policy "Read untargeted visible launch popups"
on public.launch_popup for select to anon, authenticated
using (audience_filter is null and (visible_from is null or visible_from <= now()));
-- Existing table grants remain intact. Supabase service_role has BYPASSRLS;
-- translate-openai uses its service-role key, so no dead service SELECT policy.

create or replace function public.launch_popup_target_locales(p_audience_filter jsonb)
returns setof text language sql stable set search_path = pg_catalog
as $function$
  select supported.locale::text
  from public.supported_locales as supported
  where supported.locale <> 'en'
    and public.audience_filter_matches(
      jsonb_build_object('locales', p_audience_filter -> 'locales'),
      supported.locale, null, null, null
    );
$function$;

create or replace function public.get_launch_popup(
  p_locale text, p_platform text, p_country text default null, p_region text default null
)
returns setof public.launch_popup language sql security definer stable
set search_path = pg_catalog, public
as $function$
  select popup.* from public.launch_popup as popup
  where popup.locale = p_locale
    and popup.platform in (p_platform, 'all')
    and (popup.visible_from is null or popup.visible_from <= now())
    and public.audience_filter_matches(
      popup.audience_filter, p_locale, p_platform, p_country, p_region
    )
  order by coalesce(popup.visible_from, popup.created_at) desc, popup.id desc
  limit 1;
$function$;
revoke execute on function public.get_launch_popup(text, text, text, text) from public, anon, authenticated;
grant execute on function public.get_launch_popup(text, text, text, text) to postgres, anon, authenticated, service_role;
-- New builds use effective visibility time; legacy direct reads still order by created_at.
create index launch_popup_viewer_latest_idx on public.launch_popup
  (locale, platform, (coalesce(visible_from, created_at)) desc, id desc);

-- Rebuilt from the supplied live definition; search_path preserved.
CREATE OR REPLACE FUNCTION public.inherit_launch_popup_campaign_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare
  source_row record;
begin
  if new.source_popup_id is null then
    return new;
  end if;

  select
    parent.hook_type,
    parent.goal_amount_usd,
    parent.progress_amount_usd,
    parent.campaign_ends_at,
    parent.audience_filter,
    parent.visible_from
  into source_row
  from public.launch_popup as parent
  where parent.id = new.source_popup_id;

  if not found then
    return new;
  end if;

  new.hook_type := source_row.hook_type;
  new.goal_amount_usd := source_row.goal_amount_usd;
  new.progress_amount_usd := source_row.progress_amount_usd;
  new.campaign_ends_at := source_row.campaign_ends_at;
  new.audience_filter := source_row.audience_filter;
  new.visible_from := source_row.visible_from;

  return new;
end;
$function$;

-- Rebuilt from the supplied live definition; search_path preserved.
CREATE OR REPLACE FUNCTION public.propagate_launch_popup_campaign_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
begin
  -- Only English source rows fan out, and only when a campaign field actually
  -- changed (progress_amount_usd is expected to be updated mid-campaign).
  if new.source_popup_id is not null then
    return null;
  end if;

  update public.launch_popup as child
  set
    hook_type = new.hook_type,
    goal_amount_usd = new.goal_amount_usd,
    progress_amount_usd = new.progress_amount_usd,
    campaign_ends_at = new.campaign_ends_at,
    audience_filter = new.audience_filter,
    visible_from = new.visible_from
  where child.source_popup_id = new.id;

  return null;
end;
$function$;

-- Rebuilt from the supplied live definition; search_path preserved.
CREATE OR REPLACE FUNCTION public.guard_launch_popup_translation_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
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
  from public.launch_popup_target_locales(new.audience_filter) as targets(locale);

  select count(distinct translated.locale)::integer
  into translated_count
  from public.launch_popup as translated
  where translated.source_popup_id = new.id
    and translated.is_translated is true
    and exists (
      select 1
      from public.launch_popup_target_locales(new.audience_filter) as supported(locale)
      where supported.locale = translated.locale
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

-- Rebuilt from the supplied live definition; search_path preserved.
CREATE OR REPLACE FUNCTION public.reconcile_launch_popup_translations()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
      source.translation_attempts,
      source.audience_filter
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
    from public.launch_popup_target_locales(source_row.audience_filter) as supported(locale)
    where not exists (
        select 1
        from public.launch_popup as translated
        where translated.source_popup_id = source_row.id
          and translated.locale = supported.locale
          and translated.is_translated is true
      );

    select count(*)::integer
    into target_count
    from public.launch_popup_target_locales(source_row.audience_filter) as targets(locale);

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

-- Rebuilt from the supplied live definition; search_path preserved.
CREATE OR REPLACE FUNCTION public.translate_launch_popup()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
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
  from public.launch_popup_target_locales(new.audience_filter) as targets(locale);

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
      from public.launch_popup_target_locales(new.audience_filter) as supported(locale)
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

drop trigger propagate_launch_popup_campaign_fields_after_update on public.launch_popup;
create trigger propagate_launch_popup_campaign_fields_after_update
 after update of hook_type, goal_amount_usd, progress_amount_usd, campaign_ends_at, audience_filter, visible_from
 on public.launch_popup for each row
 when (old.hook_type is distinct from new.hook_type
   or old.goal_amount_usd is distinct from new.goal_amount_usd
   or old.progress_amount_usd is distinct from new.progress_amount_usd
   or old.campaign_ends_at is distinct from new.campaign_ends_at
   or old.audience_filter is distinct from new.audience_filter
   or old.visible_from is distinct from new.visible_from)
 execute function public.propagate_launch_popup_campaign_fields();

-- Queue bodies/overloads remain unchanged. No Flutter client call was found.
-- Repository migrations do not record the processor cron job; operator must
-- verify cron.job.username = 'postgres' before push (postgres keeps EXECUTE).
revoke execute on function public.inherit_launch_popup_campaign_fields() from public, anon, authenticated;
grant execute on function public.inherit_launch_popup_campaign_fields() to postgres, service_role;
revoke execute on function public.propagate_launch_popup_campaign_fields() from public, anon, authenticated;
grant execute on function public.propagate_launch_popup_campaign_fields() to postgres, service_role;
revoke execute on function public.guard_launch_popup_translation_status() from public, anon, authenticated;
grant execute on function public.guard_launch_popup_translation_status() to postgres, service_role;
revoke execute on function public.reconcile_launch_popup_translations() from public, anon, authenticated;
grant execute on function public.reconcile_launch_popup_translations() to postgres, service_role;
revoke execute on function public.translate_launch_popup() from public, anon, authenticated;
grant execute on function public.translate_launch_popup() to postgres, service_role;
revoke execute on function public.launch_popup_target_locales(jsonb) from public, anon, authenticated;
grant execute on function public.launch_popup_target_locales(jsonb) to postgres, service_role;
revoke execute on function public.process_due_popups() from public, anon, authenticated;
grant execute on function public.process_due_popups() to postgres, service_role;
