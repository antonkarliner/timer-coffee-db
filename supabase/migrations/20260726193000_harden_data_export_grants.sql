-- Harden the data export objects created in 20260726190000_data_export_requests.sql.
--
-- The Supabase security advisor flagged two findings against the new objects:
--
--   1. lint 0028/0029 -- `service.cleanup_expired_data_exports()` is a
--      SECURITY DEFINER function that `anon` and `authenticated` could execute
--      via `/rest/v1/rpc/`. Nothing outside pg_cron should ever call it.
--
--   2. lint 0012 -- the RLS policy on `service.data_export_requests` was
--      created without a `to` clause, so it nominally applies to every role
--      (it evaluates false for anon, but the advisor rightly flags the shape).
--
-- Both are pre-existing patterns elsewhere in this schema (service.rate_limits
-- and service.cleanup_old_rate_limits have the identical findings), but the
-- data export table holds OTP challenge state, so it gets the tighter shape.
-- Hardening the rate_limits equivalents is deliberately left out of scope here.

-- 1. Only postgres (pg_cron) and service_role may execute the cleanup function.
revoke execute on function service.cleanup_expired_data_exports() from public;
revoke execute on function service.cleanup_expired_data_exports() from anon;
revoke execute on function service.cleanup_expired_data_exports() from authenticated;
grant execute on function service.cleanup_expired_data_exports() to service_role;

-- 2. Scope the RLS policy explicitly to service_role.
drop policy if exists "Service role manage data export requests" on service.data_export_requests;
create policy "Service role manage data export requests" on service.data_export_requests
    for all
    to service_role
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
