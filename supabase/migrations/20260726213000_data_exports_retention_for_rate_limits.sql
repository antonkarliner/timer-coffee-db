-- Fix the retention window on service.data_export_requests so the export rate
-- limits actually work.
--
-- The original cleanup (20260726190000) deleted rows once they were more than
-- 1 hour past expiry. Since expires_at = created_at + 10 minutes, that purged
-- every row ~70 minutes after creation.
--
-- The export-user-data edge function enforces its anti-abuse caps by COUNTING
-- rows in this table over the last 24 hours (max 3 per user, max 3 per
-- destination email). With a ~70-minute retention those counts could never see
-- a full day, so both caps silently degraded from "3 per 24h" to roughly
-- "3 per 70 minutes" -- about 60 OTP emails a day to arbitrary addresses.
--
-- Retention is therefore keyed off created_at and set to 25 hours: long enough
-- to cover the full 24h rate-limit window with an hour of slack for the hourly
-- cron, and still short enough that this stays transient challenge state.
--
-- The rows kept are only: user_id, dest_email, a SHA-256 code hash, attempt
-- counters and timestamps. Expired codes are unusable regardless, because
-- `confirm` requires an unconsumed AND unexpired row.

create or replace function service.cleanup_expired_data_exports()
returns void
language plpgsql
security definer
set search_path = service, public, extensions, pg_catalog
as $$
begin
    delete from service.data_export_requests
    where created_at < timezone('utc', now()) - interval '25 hours';
end;
$$;

comment on function service.cleanup_expired_data_exports() is 'Purges data_export_requests rows older than 25 hours. Retention must exceed the 24h window the export-user-data edge function counts over to enforce its per-user and per-destination-email rate limits. Stale data-exports storage objects are purged separately via the Storage API (storage.protect_delete blocks direct DELETE on storage.objects).';

-- Re-assert the hardening from 20260726193000: `create or replace function`
-- preserves existing grants, but this makes the intent explicit and keeps the
-- migration self-contained if it is ever replayed onto a fresh database.
revoke execute on function service.cleanup_expired_data_exports() from public;
revoke execute on function service.cleanup_expired_data_exports() from anon;
revoke execute on function service.cleanup_expired_data_exports() from authenticated;
grant execute on function service.cleanup_expired_data_exports() to service_role;
