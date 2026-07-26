-- User data export requests (Plan 035: self-serve, email-OTP-confirmed export).
--
-- A user requests an export of their Timer.Coffee data to a destination email
-- they enter in-app. We confirm control of that inbox with a one-time 6-digit
-- code (delivered via Resend) before assembling and emailing a signed download
-- link. This is intentionally NOT Supabase `signInWithOtp`/`verifyOtp` — that
-- flow mutates the auth session. This table only tracks the OTP challenge; the
-- exported data itself is always scoped to the verified JWT `user_id`, never
-- to the destination email or any other client-supplied value.
--
-- No client ever reads/writes this table directly: only the export-user-data
-- edge function (service_role) touches it.

create table if not exists service.data_export_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    dest_email text not null,
    code_hash text not null,
    attempts int not null default 0,
    max_attempts int not null default 5,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default timezone('utc', now())
);

-- Indexes for lookup by user (latest request) and for cleanup by expiry
create index if not exists idx_data_export_requests_user_created on service.data_export_requests(user_id, created_at desc);
create index if not exists idx_data_export_requests_expires_at on service.data_export_requests(expires_at);

-- Enable RLS
alter table service.data_export_requests enable row level security;

-- Only service role can manage export requests
drop policy if exists "Service role manage data export requests" on service.data_export_requests;
create policy "Service role manage data export requests" on service.data_export_requests
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- Explicit grants: service_role only. No anon/authenticated access — this
-- table is never read or written directly by clients.
grant usage on schema service to service_role;
grant select, insert, update, delete on service.data_export_requests to service_role;

comment on table service.data_export_requests is 'One-time OTP challenges for the self-serve user data export flow (Plan 035). Confirms control of the destination inbox; the export edge function then assembles data scoped to the verified JWT user_id and emails a signed download link.';
comment on column service.data_export_requests.user_id is 'Owning user (auth.users.id). Export data is always read by this verified JWT user_id, never by dest_email or any client-supplied id.';
comment on column service.data_export_requests.dest_email is 'Destination email address the user entered in-app. This is only where the export link is sent, never a selector for whose data is exported.';
comment on column service.data_export_requests.code_hash is 'SHA-256 hex digest of the 6-digit OTP. The plaintext code is never stored or logged.';
comment on column service.data_export_requests.attempts is 'Number of failed confirm attempts made against this code.';
comment on column service.data_export_requests.max_attempts is 'Attempts allowed before the code is locked out (default 5).';
comment on column service.data_export_requests.expires_at is 'Code expiry, created_at + 10 minutes. Expired rows are rejected by confirm and purged by cleanup_expired_data_exports().';
comment on column service.data_export_requests.consumed_at is 'Set when the code is successfully confirmed; makes the code single-use.';
comment on column service.data_export_requests.created_at is 'Row creation timestamp (UTC).';

-- Private storage bucket for the generated export zips. Objects are keyed
-- {user_id}/{uuid}.zip and are never public: access is exclusively via
-- short-lived (1 hour) signed URLs minted server-side by the export edge
-- function, delivered only by email.
insert into storage.buckets (id, name, public)
values ('data-exports', 'data-exports', false)
on conflict (id) do nothing;

-- Storage RLS: service role only. No anon/authenticated read or write —
-- clients never touch this bucket directly, only via signed URLs.
drop policy if exists "Service role manage data-exports objects" on storage.objects;
create policy "Service role manage data-exports objects"
on storage.objects
as permissive
for all
to service_role
using (bucket_id = 'data-exports')
with check (bucket_id = 'data-exports');

-- Clean up expired OTP request rows automatically.
--
-- NOTE: this function deliberately does NOT delete from storage.objects.
-- storage has a BEFORE DELETE trigger (storage.protect_delete) that raises
-- SQLSTATE 42501 -- 'Direct deletion from storage tables is not allowed. Use
-- the Storage API instead.' -- unless storage.allow_delete_query is set. Even
-- with that override, deleting the metadata row leaves the object bytes
-- orphaned in the storage backend. Stale export zips are therefore purged via
-- the Storage API by the export-user-data edge function (see plan 035 Phase 2).
create or replace function service.cleanup_expired_data_exports()
returns void
language plpgsql
security definer
set search_path = service, public, extensions, pg_catalog
as $$
begin
    delete from service.data_export_requests
    where expires_at < timezone('utc', now()) - interval '1 hour';
end;
$$;

comment on function service.cleanup_expired_data_exports() is 'Purges expired data_export_requests rows (>1h past expiry). Stale data-exports storage objects are purged separately via the Storage API by the export-user-data edge function, because storage.protect_delete blocks direct DELETE on storage.objects and direct deletion would orphan the object bytes.';

-- Schedule cleanup to run hourly at minute 15 (rate_limits cleanup already
-- runs at minute 0; offset avoids colliding with it).
do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'cleanup-data-exports'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'cleanup-data-exports',
        '15 * * * *',
        'select service.cleanup_expired_data_exports();'
    );
end;
$cron$
language plpgsql;
