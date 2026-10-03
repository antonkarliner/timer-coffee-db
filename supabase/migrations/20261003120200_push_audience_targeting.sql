-- Plan 041 §5: push audience targeting, shared country regions and admin reach estimates.
-- Token upserts tolerate invalid geo data. Existing token/scheduled table ACLs and RLS stay unchanged.
begin;

alter table service.user_fcm_tokens
  add column country text,
  add column timezone text,
  add column locale_source text;

create function service.normalize_fcm_token_geo()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  new.country := upper(new.country);
  if new.country !~ '^[A-Z]{2}$' then new.country := null; end if;
  if tg_op = 'INSERT' then
    if new.timezone is not null and not exists (
      select 1 from pg_catalog.pg_timezone_names where name = new.timezone
    ) then new.timezone := null; end if;
  elsif new.timezone is distinct from old.timezone then
    if new.timezone is not null and not exists (
      select 1 from pg_catalog.pg_timezone_names where name = new.timezone
    ) then new.timezone := null; end if;
  end if;
  if new.locale_source not in ('explicit', 'system') then new.locale_source := null; end if;
  return new;
end;
$$;
create trigger normalize_fcm_token_geo before insert or update
on service.user_fcm_tokens for each row execute function service.normalize_fcm_token_geo();
revoke execute on function service.normalize_fcm_token_geo() from public, anon, authenticated;
grant execute on function service.normalize_fcm_token_geo() to postgres, service_role;

create table public.country_regions (
  country_code text primary key check (country_code ~ '^[A-Z]{2}$'),
  region text not null
);
alter table public.country_regions enable row level security;
revoke all on public.country_regions from public, anon, authenticated;
grant select on public.country_regions to anon, authenticated, service_role;
grant insert, update, delete on public.country_regions to service_role;
create policy "Read country regions" on public.country_regions for select
  to anon, authenticated, service_role using (true);
create policy "Service manages country regions" on public.country_regions for all
  to service_role using (true) with check (true);
-- Exact mapping previously held by geoip/index.ts (unknown countries remain WW there).
insert into public.country_regions(country_code, region) values
  ('US', 'NA'),
  ('CA', 'NA'),
  ('MX', 'NA'),
  ('GB', 'EU'),
  ('DE', 'EU'),
  ('FR', 'EU'),
  ('ES', 'EU'),
  ('IT', 'EU'),
  ('NL', 'EU'),
  ('BE', 'EU'),
  ('SE', 'EU'),
  ('NO', 'EU'),
  ('FI', 'EU'),
  ('DK', 'EU'),
  ('PL', 'EU'),
  ('PT', 'EU'),
  ('IE', 'EU'),
  ('AT', 'EU'),
  ('CH', 'EU'),
  ('JP', 'AS'),
  ('CN', 'AS'),
  ('HK', 'AS'),
  ('KR', 'AS'),
  ('SG', 'AS'),
  ('TH', 'AS'),
  ('VN', 'AS'),
  ('MY', 'AS'),
  ('ID', 'AS'),
  ('PH', 'AS'),
  ('IN', 'AS'),
  ('AU', 'AU'),
  ('NZ', 'AU'),
  ('AR', 'SA'),
  ('BR', 'SA'),
  ('CL', 'SA'),
  ('CO', 'SA'),
  ('PE', 'SA'),
  ('UY', 'SA'),
  ('PY', 'SA'),
  ('BO', 'SA'),
  ('VE', 'SA'),
  ('EC', 'SA'),
  ('DZ', 'AF'),
  ('EG', 'AF'),
  ('MA', 'AF'),
  ('ZA', 'AF'),
  ('KE', 'AF'),
  ('NG', 'AF'),
  ('GH', 'AF'),
  ('TZ', 'AF'),
  ('UG', 'AF'),
  ('ET', 'AF'),
  ('RW', 'AF'),
  ('CI', 'AF'),
  ('SN', 'AF'),
  ('CM', 'AF'),
  ('TN', 'AF'),
  ('MU', 'AF'),
  ('NA', 'AF'),
  ('BW', 'AF'),
  ('MZ', 'AF'),
  ('AE', 'ME'),
  ('SA', 'ME'),
  ('QA', 'ME'),
  ('KW', 'ME'),
  ('BH', 'ME'),
  ('OM', 'ME'),
  ('JO', 'ME'),
  ('LB', 'ME'),
  ('IL', 'ME'),
  ('IQ', 'ME'),
  ('IR', 'ME');

create function service.get_broadcast_tokens(
  p_target_device_types text[], p_target_user_ids uuid[], p_audience_filter jsonb
)
returns table (id uuid, user_id uuid, token text, device_type text, locale text, country text, timezone text)
language plpgsql stable security definer set search_path = pg_catalog
as $$
begin
  if not public.is_valid_audience_filter(p_audience_filter) then
    raise exception 'Invalid audience_filter' using errcode = '22023';
  end if;
  return query
  select t.id, t.user_id, t.token, t.device_type::text, t.locale::text, t.country, t.timezone
  from service.user_fcm_tokens t
  left join public.country_regions cr on cr.country_code = t.country
  where t.is_active
    and t.device_type = any(p_target_device_types)
    and (coalesce(cardinality(p_target_user_ids), 0) = 0 or t.user_id = any(p_target_user_ids))
    and public.audience_filter_matches(p_audience_filter, t.locale, t.device_type, t.country, cr.region);
end;
$$;
revoke execute on function service.get_broadcast_tokens(text[], uuid[], jsonb) from public, anon, authenticated;
grant execute on function service.get_broadcast_tokens(text[], uuid[], jsonb) to postgres, service_role;

alter table service.scheduled_notifications
  add column audience_filter jsonb,
  add constraint scheduled_notifications_audience_filter_check
    check (public.is_valid_audience_filter(audience_filter)),
  add constraint scheduled_notifications_filter_broadcast_check
    check (audience_filter is null or audience = 'broadcast');

drop function service.lock_due_scheduled_notifications(integer);
create function service.lock_due_scheduled_notifications(p_limit integer)
returns table (
  id uuid, user_id uuid, template_id uuid, template_name text,
  template_data jsonb, title text, body text, data jsonb, priority text,
  category text, schedule_at timestamptz, recurrence text, recurrence_data jsonb,
  quiet_hours_override boolean, locale text, translate boolean,
  audience text, platform text, target_user_ids uuid[], created_by uuid, audience_filter jsonb
)
language plpgsql
security definer
set search_path = service, public, auth
as $$
begin
    return query
    with cte as (
        select sn.id
        from service.scheduled_notifications as sn
        where sn.status = 'pending'
          and sn.schedule_at <= timezone('utc', now())
        order by sn.schedule_at asc
        limit p_limit
        for update skip locked
    )
    update service.scheduled_notifications as s
    set status = 'processing', last_attempt_at = timezone('utc', now())
    from cte
    where s.id = cte.id
    returning s.id, s.user_id, s.template_id, s.template_name, s.template_data,
              s.title, s.body, s.data, s.priority, s.category, s.schedule_at,
              s.recurrence, s.recurrence_data, s.quiet_hours_override,
              s.locale, s.translate, s.audience, s.platform, s.target_user_ids,
              s.created_by, s.audience_filter;
end;
$$;

revoke execute on function service.lock_due_scheduled_notifications(integer) from public;
revoke execute on function service.lock_due_scheduled_notifications(integer) from anon;
revoke execute on function service.lock_due_scheduled_notifications(integer) from authenticated;
grant execute on function service.lock_due_scheduled_notifications(integer) to service_role;
grant execute on function service.lock_due_scheduled_notifications(integer) to postgres;


create function public.estimate_broadcast_reach(
  p_audience_filter jsonb default null, p_platform text default 'all',
  p_target_user_ids uuid[] default null
)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare
  devices text[];
  result jsonb;
  geography boolean;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.is_valid_audience_filter(p_audience_filter) then
    raise exception 'Invalid audience_filter' using errcode = '22023';
  end if;
  case lower(trim(p_platform))
    when 'all' then devices := array['android', 'ios', 'web'];
    when 'ios' then devices := array['ios'];
    when 'android' then devices := array['android'];
    when 'web' then devices := array['web'];
    else raise exception 'Invalid platform' using errcode = '22023';
  end case;
  geography := jsonb_array_length(coalesce(nullif(p_audience_filter->'countries', 'null'::jsonb), '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(nullif(p_audience_filter->'regions', 'null'::jsonb), '[]'::jsonb)) > 0;
  with base as (
    select t.*, cr.region,
      public.audience_filter_matches(p_audience_filter, t.locale, t.device_type, t.country, cr.region) as matched
    from service.user_fcm_tokens t
    left join public.country_regions cr on cr.country_code = t.country
    where t.is_active and t.device_type = any(devices)
      and (coalesce(cardinality(p_target_user_ids), 0) = 0 or t.user_id = any(p_target_user_ids))
  ), locale_counts as (
    select coalesce(locale, 'unknown') as locale, count(*) as n from base where matched group by 1
  )
  select jsonb_build_object(
    'total', (select count(*) from base where matched),
    'by_locale', coalesce((select jsonb_object_agg(locale, n) from locale_counts), '{}'::jsonb),
    'unknown_country_excluded', (select count(*) from base
      where geography and not matched
        and (country is null or (region is null and jsonb_array_length(coalesce(nullif(p_audience_filter->'regions', 'null'::jsonb), '[]'::jsonb)) > 0))
        and public.audience_filter_matches(p_audience_filter - 'countries' - 'regions', locale, device_type, country, region)),
    'unknown_timezone', (select count(*) from base where matched and timezone is null),
    'total_active', (select count(*) from service.user_fcm_tokens where is_active)
  ) into result;
  return result;
end;
$$;
revoke execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) from public, anon;
grant execute on function public.estimate_broadcast_reach(jsonb, text, uuid[]) to postgres, authenticated, service_role;

commit;
