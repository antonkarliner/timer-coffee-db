-- Plan 041 §6/§10: local-time broadcast buckets, translation cache and worker RPCs.
-- File only. Existing UTC/user lock retains its current signature and ACL.
begin;
alter table service.scheduled_notifications
  add column deliver_local_date date,
  add column deliver_local_time time,
  add column local_time_fallback text not null default 'utc'
    check (local_time_fallback in ('utc', 'exclude')),
  add column local_time_max_lateness interval not null default '12 hours'
    check (local_time_max_lateness >= interval '0 seconds'),
  add column translated_payloads jsonb,
  add constraint scheduled_notifications_local_pair_check
    check ((deliver_local_date is null) = (deliver_local_time is null)),
  add constraint scheduled_notifications_local_broadcast_check
    check (deliver_local_time is null or (audience = 'broadcast' and recurrence = 'none')),
  drop constraint scheduled_notifications_status_check,
  add constraint scheduled_notifications_status_check
    check (status in ('pending','processing','delivering','sent','failed','cancelled'));

create table service.scheduled_notification_buckets (
  job_id uuid references service.scheduled_notifications(id) on delete cascade,
  bucket text,
  status text not null check (status in ('sending','sent','failed','skipped')),
  token_count int check (token_count >= 0),
  result jsonb,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (job_id, bucket)
);
alter table service.scheduled_notification_buckets enable row level security;
revoke all on service.scheduled_notification_buckets from public, anon, authenticated;
grant select, insert, update, delete on service.scheduled_notification_buckets to service_role;
create policy "Service manages broadcast buckets" on service.scheduled_notification_buckets
  for all to service_role using (true) with check (true);

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
          and sn.deliver_local_time is null
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

drop function service.get_broadcast_tokens(text[], uuid[], jsonb);
create function service.get_broadcast_tokens(
  p_target_device_types text[], p_target_user_ids uuid[], p_audience_filter jsonb,
  p_timezones text[] default null, p_null_timezone_only boolean default false
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
    and (p_timezones is null or t.timezone = any(p_timezones))
    and (not p_null_timezone_only or t.timezone is null)
    and public.audience_filter_matches(p_audience_filter, t.locale, t.device_type, t.country, cr.region);
end;
$$;
revoke execute on function service.get_broadcast_tokens(text[], uuid[], jsonb, text[], boolean) from public, anon, authenticated;
grant execute on function service.get_broadcast_tokens(text[], uuid[], jsonb, text[], boolean) to postgres, service_role;

create function service.lock_local_time_scheduled_notifications(p_limit integer)
returns setof service.scheduled_notifications
language sql security definer set search_path = pg_catalog
as $$
  with jobs as (
    select sn.id from service.scheduled_notifications sn
    where sn.deliver_local_time is not null and sn.status in ('pending','delivering')
      and now() >= (sn.deliver_local_date + sn.deliver_local_time) at time zone 'Etc/GMT-14'
    -- Rotate unfinished jobs so a small batch cannot starve later jobs.
    order by sn.last_attempt_at nulls first, sn.schedule_at, sn.id
    limit p_limit for update skip locked
  )
  update service.scheduled_notifications sn
  set status = 'delivering', last_attempt_at = now()
  from jobs where sn.id = jobs.id returning sn.*;
$$;

create function service.due_local_time_buckets(p_job_id uuid)
returns table (bucket text, token_count int, lateness interval)
language sql stable security definer set search_path = pg_catalog
as $$
  with job as (
    select * from service.scheduled_notifications
    where id = p_job_id and deliver_local_time is not null and status = 'delivering'
  ), zones as (
    select t.timezone, count(*)::int n from job j
    cross join lateral service.get_broadcast_tokens(
      case when j.platform = 'all' then array['ios','android','web'] else array[j.platform] end,
      j.target_user_ids, j.audience_filter) t
    group by t.timezone
  ), buckets as (
    select z.timezone bucket, z.n token_count,
      (j.deliver_local_date + j.deliver_local_time) at time zone z.timezone due_at
    from zones z cross join job j where z.timezone is not null
    union all
    select '__no_timezone__', coalesce((select n from zones where timezone is null), 0), j.schedule_at
    from job j where j.local_time_fallback = 'utc'
  )
  select b.bucket, b.token_count, now() - b.due_at
  from buckets b where b.due_at <= now() and not exists (
    select 1 from service.scheduled_notification_buckets claimed
    where claimed.job_id = p_job_id and claimed.bucket = b.bucket
  ) order by b.due_at, b.bucket;
$$;

-- Keep interval arithmetic in PostgreSQL (including calendar interval units).
create function service.due_local_time_bucket_actions(p_job_id uuid)
returns table (bucket text, token_count int, too_late boolean)
language sql stable security definer set search_path = pg_catalog
as $$
  select b.bucket, b.token_count, b.lateness > j.local_time_max_lateness
  from service.scheduled_notifications j
  cross join lateral service.due_local_time_buckets(j.id) b
  where j.id = p_job_id;
$$;
revoke execute on function service.due_local_time_bucket_actions(uuid) from public, anon, authenticated;
grant execute on function service.due_local_time_bucket_actions(uuid) to postgres, service_role;

-- A durable preparation marker serializes the external translation call across cron runs.
-- A crash leaves the marker in place: never silently re-translate or send uncached text.
create function service.claim_scheduled_translation(p_job_id uuid)
returns boolean language sql security definer set search_path = pg_catalog
as $$
  with claimed as (
    update service.scheduled_notifications set translated_payloads = '{"preparing":true}'::jsonb
    where id = p_job_id and status = 'delivering' and translated_payloads is null
    returning id
  ) select exists(select 1 from claimed);
$$;

create function service.local_time_delivery_state(p_job_id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'window_closed', now() > ((j.deliver_local_date + j.deliver_local_time)
      at time zone 'Etc/GMT+12') + j.local_time_max_lateness,
    'fallback_done', j.local_time_fallback = 'exclude' or exists (
      select 1 from service.scheduled_notification_buckets b
      where b.job_id = j.id and b.bucket = '__no_timezone__'),
    'partial_failures', (select count(*) from service.scheduled_notification_buckets b
      where b.job_id = j.id and b.status = 'sent'
        and jsonb_array_length(coalesce(b.result->'failures', '[]'::jsonb)) > 0),
    'active_sends', (select count(*) from service.scheduled_notification_buckets b
      where b.job_id = j.id and b.status = 'sending' and b.claimed_at > now() - interval '5 minutes'),
    'unclaimed', (select count(*) from service.due_local_time_buckets(j.id)),
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
      select status, count(*) n from service.scheduled_notification_buckets
      where job_id = j.id group by status
    ) counts)
  ) from service.scheduled_notifications j where j.id = p_job_id;
$$;

-- Scalar JSON aggregation avoids PostgREST row limits when preparing all locales.
create function service.local_time_delivery_locales(p_job_id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog
as $$
  select coalesce(jsonb_agg(locale), '[]'::jsonb) from (
    select distinct coalesce(nullif(t.locale, ''), 'en') locale
    from service.scheduled_notifications j
    cross join lateral service.get_broadcast_tokens(
      case when j.platform = 'all' then array['ios','android','web'] else array[j.platform] end,
      j.target_user_ids, j.audience_filter) t
    where j.id = p_job_id
  ) locales;
$$;
revoke execute on function service.local_time_delivery_locales(uuid) from public, anon, authenticated;
grant execute on function service.local_time_delivery_locales(uuid) to postgres, service_role;

-- Page-scoped aggregation, backed by the ledger primary key (job_id, bucket).
create function service.scheduled_bucket_summary(p_job_ids uuid[])
returns table (job_id uuid, counts jsonb)
language sql stable security definer set search_path = pg_catalog
as $$
  select c.job_id, jsonb_object_agg(c.status, c.n) from (
    select b.job_id, b.status, count(*) n from service.scheduled_notification_buckets b
    where b.job_id = any(p_job_ids) group by b.job_id, b.status
  ) c group by c.job_id;
$$;
revoke execute on function service.lock_local_time_scheduled_notifications(integer) from public;
revoke execute on function service.lock_local_time_scheduled_notifications(integer) from anon;
revoke execute on function service.lock_local_time_scheduled_notifications(integer) from authenticated;
grant execute on function service.lock_local_time_scheduled_notifications(integer) to service_role;
grant execute on function service.lock_local_time_scheduled_notifications(integer) to postgres;
revoke execute on function service.due_local_time_buckets(uuid) from public;
revoke execute on function service.due_local_time_buckets(uuid) from anon;
revoke execute on function service.due_local_time_buckets(uuid) from authenticated;
grant execute on function service.due_local_time_buckets(uuid) to service_role;
grant execute on function service.due_local_time_buckets(uuid) to postgres;
revoke execute on function service.claim_scheduled_translation(uuid) from public;
revoke execute on function service.claim_scheduled_translation(uuid) from anon;
revoke execute on function service.claim_scheduled_translation(uuid) from authenticated;
grant execute on function service.claim_scheduled_translation(uuid) to service_role;
grant execute on function service.claim_scheduled_translation(uuid) to postgres;
revoke execute on function service.local_time_delivery_state(uuid) from public;
revoke execute on function service.local_time_delivery_state(uuid) from anon;
revoke execute on function service.local_time_delivery_state(uuid) from authenticated;
grant execute on function service.local_time_delivery_state(uuid) to service_role;
grant execute on function service.local_time_delivery_state(uuid) to postgres;
revoke execute on function service.scheduled_bucket_summary(uuid[]) from public;
revoke execute on function service.scheduled_bucket_summary(uuid[]) from anon;
revoke execute on function service.scheduled_bucket_summary(uuid[]) from authenticated;
grant execute on function service.scheduled_bucket_summary(uuid[]) to service_role;
grant execute on function service.scheduled_bucket_summary(uuid[]) to postgres;

commit;
