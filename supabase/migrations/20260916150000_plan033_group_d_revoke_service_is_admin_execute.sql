-- Plan 033, Group D: revoke default-privilege EXECUTE from anon/authenticated on
-- service.is_admin().
--
-- This function was held back from Group A on the belief that the 22 RLS policies
-- whose qual contains `is_admin()` depend on it. They do not. Checked against
-- pg_depend rather than against the policy text: every one of those 22 policies
-- binds to `public.is_admin`, a separate function with the same name. Nothing in
-- the database depends on service.is_admin(), and no caller exists in the app,
-- the landing site, the edge functions or the scripts.
--
-- Verified on the local stack, on the real policy tables, inside a rolled-back
-- transaction: with service.is_admin() revoked, an `authenticated` read of
-- service.cleanup_logs and service.user_fcm_tokens still works. With
-- public.is_admin() revoked, the same two reads fail with
-- `permission denied for function is_admin`.
--
-- So the RLS-qual hazard is real, but it belongs to public.is_admin() and is
-- plan 031's to handle. public.is_admin() must keep its anon and authenticated
-- grants.

revoke execute on function service.is_admin() from public;
revoke execute on function service.is_admin() from anon;
revoke execute on function service.is_admin() from authenticated;
grant  execute on function service.is_admin() to service_role;
grant  execute on function service.is_admin() to postgres;
