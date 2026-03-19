-- Adds user notification preferences and scheduled notification management in service schema

create schema if not exists service;

create or replace function service.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;


create table if not exists service.user_notification_preferences (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    push_enabled boolean not null default true,
    quiet_hours_start time not null default '22:00'::time,
    quiet_hours_end time not null default '08:00'::time,
    marketing_enabled boolean not null default true,
    transactional_enabled boolean not null default true,
    social_enabled boolean not null default true,
    reminder_enabled boolean not null default true,
    priority_threshold text not null default 'normal' check (priority_threshold in ('low','normal','high')),
    batch_notifications boolean not null default false,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_service_user_prefs_user_id on service.user_notification_preferences(user_id);
create index if not exists idx_service_user_prefs_push_enabled on service.user_notification_preferences(push_enabled) where push_enabled = true;

alter table service.user_notification_preferences enable row level security;

drop policy if exists "Users manage own notification prefs" on service.user_notification_preferences;
create policy "Users manage own notification prefs" on service.user_notification_preferences
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists "Admin read notification prefs" on service.user_notification_preferences;
create policy "Admin read notification prefs" on service.user_notification_preferences
    for select using (public.is_admin());

drop policy if exists "Service role manage notification prefs" on service.user_notification_preferences;
create policy "Service role manage notification prefs" on service.user_notification_preferences
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

create trigger trg_user_notification_preferences_set_updated_at
    before update on service.user_notification_preferences
    for each row execute function service.set_updated_at();

comment on table service.user_notification_preferences is 'Per-user push notification delivery preferences stored in service schema.';

-- Helper to ensure preference row exists for a user id
create or replace function service.ensure_user_notification_preferences(p_user_id uuid)
returns service.user_notification_preferences
language plpgsql
security definer
set search_path = service, public, auth
as $$
declare
    prefs service.user_notification_preferences;
begin
    insert into service.user_notification_preferences (user_id)
    values (p_user_id)
    on conflict (user_id) do update set user_id = excluded.user_id
    returning * into prefs;

    return prefs;
end;
$$;

comment on function service.ensure_user_notification_preferences(uuid) is 'Creates default notification preferences if none exist and returns the row.';

-- Scheduled notifications table for delayed / recurring sends
create table if not exists service.scheduled_notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    template_id uuid references service.notification_templates(id),
    template_name text,
    template_data jsonb not null default '{}'::jsonb,
    title text,
    body text,
    data jsonb not null default '{}'::jsonb,
    priority text not null default 'normal' check (priority in ('low','normal','high')),
    category text default 'general',
    schedule_at timestamptz not null,
    status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
    failure_reason text,
    last_attempt_at timestamptz,
    recurrence text not null default 'none' check (recurrence in ('none','daily','weekly','monthly')),
    recurrence_data jsonb,
    quiet_hours_override boolean not null default false,
    timezone text not null default 'UTC',
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_service_sched_notifications_schedule on service.scheduled_notifications(schedule_at asc);
create index if not exists idx_service_sched_notifications_status on service.scheduled_notifications(status);
create index if not exists idx_service_sched_notifications_user on service.scheduled_notifications(user_id);

alter table service.scheduled_notifications enable row level security;

drop policy if exists "Users manage own scheduled notifications" on service.scheduled_notifications;
create policy "Users manage own scheduled notifications" on service.scheduled_notifications
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists "Admin read scheduled notifications" on service.scheduled_notifications;
create policy "Admin read scheduled notifications" on service.scheduled_notifications
    for select using (public.is_admin());

drop policy if exists "Service role manage scheduled notifications" on service.scheduled_notifications;
create policy "Service role manage scheduled notifications" on service.scheduled_notifications
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

create trigger trg_scheduled_notifications_set_updated_at
    before update on service.scheduled_notifications
    for each row execute function service.set_updated_at();

comment on table service.scheduled_notifications is 'Stores delayed and recurring notification jobs for FCM pipeline.';

-- Utility function to mark scheduled notifications as processing atomically
create or replace function service.lock_due_scheduled_notifications(p_limit integer default 100)
returns table (
    id uuid,
    user_id uuid,
    template_id uuid,
    template_name text,
    template_data jsonb,
    title text,
    body text,
    data jsonb,
    priority text,
    category text,
    schedule_at timestamptz,
    recurrence text,
    recurrence_data jsonb,
    quiet_hours_override boolean
)
language plpgsql
security definer
set search_path = service, public, auth
as $$
begin
    return query
    with cte as (
        select id
        from service.scheduled_notifications
        where status = 'pending'
          and schedule_at <= timezone('utc', now())
        order by schedule_at asc
        limit p_limit
        for update skip locked
    )
    update service.scheduled_notifications s
    set status = 'processing', last_attempt_at = timezone('utc', now())
    where s.id in (select id from cte)
    returning s.id, s.user_id, s.template_id, s.template_name, s.template_data,
              s.title, s.body, s.data, s.priority, s.category, s.schedule_at,
              s.recurrence, s.recurrence_data, s.quiet_hours_override;
end;
$$;

comment on function service.lock_due_scheduled_notifications(integer) is 'Locks a batch of due scheduled notifications and returns them for processing.';
