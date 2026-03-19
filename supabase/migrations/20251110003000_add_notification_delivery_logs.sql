-- Delivery logs for per-device tracking

create table if not exists service.notification_delivery_logs (
    id uuid primary key default gen_random_uuid(),
    notification_id uuid not null references service.notifications(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    token_id uuid references service.user_fcm_tokens(id) on delete set null,
    token text,
    device_type text,
    status text not null check (status in ('success','failure')),
    error_code text,
    error_message text,
    fcm_message_id text,
    created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_delivery_logs_notification on service.notification_delivery_logs(notification_id);
create index if not exists idx_delivery_logs_user on service.notification_delivery_logs(user_id);
create index if not exists idx_delivery_logs_status on service.notification_delivery_logs(status);

alter table service.notification_delivery_logs enable row level security;

create policy "User view own delivery logs" on service.notification_delivery_logs
    for select using (auth.uid() = user_id);

create policy "Admin manage delivery logs" on service.notification_delivery_logs
    for all using (public.is_admin());

create policy "Service role manage delivery logs" on service.notification_delivery_logs
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

comment on table service.notification_delivery_logs is 'Per-token delivery outcomes for each notification send.';
