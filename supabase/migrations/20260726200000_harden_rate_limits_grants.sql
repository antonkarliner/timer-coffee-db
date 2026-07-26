-- Harden the rate limiting objects created in 20251110005300_create_rate_limits_table.sql.
--
-- Same two advisor findings that were fixed for the data export objects in
-- 20260726193000_harden_data_export_grants.sql, now applied to their older
-- rate_limits equivalents (explicitly left out of scope by that migration):
--
--   1. lint 0028/0029 -- `service.cleanup_old_rate_limits()` is a SECURITY
--      DEFINER function that `anon` and `authenticated` could execute via
--      `/rest/v1/rpc/cleanup_old_rate_limits`. Only the hourly pg_cron job
--      (which runs as postgres) and service_role should ever call it.
--
--   2. lint 0012 -- the "Service role manage rate limits" policy on
--      `service.rate_limits` has no `to` clause, so it nominally applies to
--      every role (it evaluates false for anon, but the advisor rightly flags
--      the shape).

-- 1. Only postgres (pg_cron) and service_role may execute the cleanup function.
revoke execute on function service.cleanup_old_rate_limits() from public;
revoke execute on function service.cleanup_old_rate_limits() from anon;
revoke execute on function service.cleanup_old_rate_limits() from authenticated;
grant execute on function service.cleanup_old_rate_limits() to service_role;

-- 2. Scope the RLS policy explicitly to service_role. The `(select auth.role())`
--    wrapping is kept from 20260501000001_fix_rls_initplan.sql so this does not
--    reintroduce the initplan (lint 0003) finding.
drop policy if exists "Service role manage rate limits" on service.rate_limits;
create policy "Service role manage rate limits" on service.rate_limits
    for all
    to service_role
    using ((select auth.role()) = 'service_role')
    with check ((select auth.role()) = 'service_role');
