-- Encrypt tokens in notification delivery logs for security
-- This migration adds token hashing to protect sensitive FCM tokens

-- First, create a new column for hashed tokens
alter table service.notification_delivery_logs 
add column if not exists token_hash text;

-- Create index on the new column for efficient queries
create index if not exists idx_delivery_logs_token_hash on service.notification_delivery_logs(token_hash);

-- Create a function to hash tokens (SHA-256)
create or replace function service.hash_fcm_token(token_input text)
returns text
language plpgsql
security definer
as $$
begin
    return encode(sha256(token_input::bytea), 'hex');
end;
$$;

-- Update existing records to include hashed tokens
update service.notification_delivery_logs 
set token_hash = service.hash_fcm_token(token)
where token is not null and token_hash is null;

-- Add comment to document the security improvement
comment on column service.notification_delivery_logs.token is 'Raw FCM token (will be deprecated - use token_hash instead)';
comment on column service.notification_delivery_logs.token_hash is 'SHA-256 hash of the FCM token for security';
comment on function service.hash_fcm_token is 'Hashes FCM tokens using SHA-256 for secure storage';

-- Create a policy to ensure token_hash is always provided for new records
alter table service.notification_delivery_logs
add constraint token_hash_not_null
check (token_hash is not null);

-- Update RLS policies to handle the new column
drop policy if exists "User view own delivery logs" on service.notification_delivery_logs;
drop policy if exists "Admin manage delivery logs" on service.notification_delivery_logs;
drop policy if exists "Service role manage delivery logs" on service.notification_delivery_logs;

create policy "User view own delivery logs" on service.notification_delivery_logs
    for select using (auth.uid() = user_id);

create policy "Admin manage delivery logs" on service.notification_delivery_logs
    for all using (public.is_admin())
    with check (public.is_admin());

create policy "Service role manage delivery logs" on service.notification_delivery_logs
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- Create a function to securely log delivery results with token hashing
create or replace function service.log_delivery_results_secure(
    p_notification_id uuid,
    p_user_id uuid,
    p_token_id uuid,
    p_token text,
    p_device_type text,
    p_status text,
    p_error_code text default null,
    p_error_message text default null,
    p_fcm_message_id text default null
)
returns void
language plpgsql
security definer
as $$
begin
    insert into service.notification_delivery_logs (
        notification_id,
        user_id,
        token_id,
        token,
        token_hash,
        device_type,
        status,
        error_code,
        error_message,
        fcm_message_id
    ) values (
        p_notification_id,
        p_user_id,
        p_token_id,
        p_token,
        service.hash_fcm_token(p_token),
        p_device_type,
        p_status,
        p_error_code,
        p_error_message,
        p_fcm_message_id
    );
end;
$$;

comment on function service.log_delivery_results_secure is 'Securely logs delivery results with token hashing for security';