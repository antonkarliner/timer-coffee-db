-- Fix duplicate app release notifications by queueing delivery work and
-- decoupling release detection from the FCM broadcast path.

create extension if not exists pg_cron;

create table if not exists service.app_release_notifications (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('ios', 'android')),
  version text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  failure_reason text,
  delivery_state jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (platform, version)
);

create index if not exists idx_app_release_notifications_status_created
  on service.app_release_notifications (status, created_at asc);

create index if not exists idx_app_release_notifications_processing_retry
  on service.app_release_notifications (last_attempt_at asc, created_at asc)
  where status in ('pending', 'processing', 'failed');

alter table service.app_release_notifications enable row level security;

drop policy if exists "Admin view app release notifications" on service.app_release_notifications;
create policy "Admin view app release notifications"
  on service.app_release_notifications
  for select
  using (public.is_admin());

drop policy if exists "Service role manage app release notifications" on service.app_release_notifications;
create policy "Service role manage app release notifications"
  on service.app_release_notifications
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists trg_app_release_notifications_set_updated_at on service.app_release_notifications;
create trigger trg_app_release_notifications_set_updated_at
  before update on service.app_release_notifications
  for each row execute function service.set_updated_at();

drop function if exists service.lock_due_app_release_notifications(integer);

create function service.lock_due_app_release_notifications(p_limit integer default 1)
returns table (
  id uuid,
  platform text,
  version text,
  status text,
  attempt_count integer,
  last_attempt_at timestamptz,
  failure_reason text,
  delivery_state jsonb,
  sent_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = service, public, auth
as $$
begin
  return query
  with candidate_jobs as (
    select arn.id
    from service.app_release_notifications as arn
    where arn.sent_at is null
      and (
        arn.status = 'pending'
        or (
          arn.status = 'failed'
          and coalesce(arn.last_attempt_at, arn.created_at) <= timezone('utc', now()) - interval '5 minutes'
        )
        or (
          arn.status = 'processing'
          and coalesce(arn.last_attempt_at, arn.created_at) <= timezone('utc', now()) - interval '15 minutes'
        )
      )
    order by arn.created_at asc
    limit greatest(coalesce(p_limit, 1), 1)
    for update skip locked
  )
  update service.app_release_notifications as arn
  set status = 'processing',
      attempt_count = arn.attempt_count + 1,
      last_attempt_at = timezone('utc', now()),
      failure_reason = null
  from candidate_jobs
  where arn.id = candidate_jobs.id
  returning arn.id, arn.platform, arn.version, arn.status, arn.attempt_count,
            arn.last_attempt_at, arn.failure_reason, arn.delivery_state,
            arn.sent_at, arn.created_at, arn.updated_at;
end;
$$;

comment on function service.lock_due_app_release_notifications(integer) is
  'Locks a batch of queued app release notifications for processing.';

revoke all on function service.lock_due_app_release_notifications(integer) from public;
grant execute on function service.lock_due_app_release_notifications(integer) to service_role;

create or replace function public.check_new_version_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
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
    url := project_url || '/functions/v1/check-new-version-detector',
    body := jsonb_build_object('trigger', 'pg_cron', 'timestamp', timezone('utc', now())),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    timeout_milliseconds := 30000
  );
end;
$$;

comment on function public.check_new_version_cron() is
  'Invokes the check-new-version-detector Edge Function with a 30 second HTTP timeout.';

create or replace function public.process_app_release_notifications_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
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

  perform net.http_post(
    url := project_url || '/functions/v1/process-app-release-notifications',
    body := jsonb_build_object('trigger', 'pg_cron', 'timestamp', timezone('utc', now())),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'X-System-Token', cron_secret
    ),
    timeout_milliseconds := 300000
  );
end;
$$;

comment on function public.process_app_release_notifications_cron() is
  'Invokes the process-app-release-notifications Edge Function.';

do $$
declare
  v_job_id integer;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname in ('check-new-version-every-10-minutes', 'check-new-version-every-30-minutes')
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'check-new-version-every-30-minutes',
    '*/30 * * * *',
    'select public.check_new_version_cron();'
  );
end;
$$ language plpgsql;

do $$
declare
  v_job_id integer;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'process-app-release-notifications'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'process-app-release-notifications',
    '*/5 * * * *',
    'select public.process_app_release_notifications_cron();'
  );
end;
$$ language plpgsql;
