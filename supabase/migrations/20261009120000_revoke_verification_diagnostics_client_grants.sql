-- Plan 080 Phase 0 ("Freeze and secure"): only postgres and service_role may
-- touch the AI-review diagnostics.
--
-- service.user_recipe_verification_diagnostics (20260511120000) was created
-- before the explicit-REVOKE rule and still carried the schema's default
-- grants. Checked in production on 2026-10-09:
--   table    {postgres=arwdDxt, anon=arwd, authenticated=arwd, service_role=arwdDxt}
--   sequence user_recipe_verification_diagnostics_id_seq
--            {postgres=rwU, anon=rwU, authenticated=rwU, service_role=rwU}
-- RLS is on with no policies, so the client roles could not read or write
-- rows through PostgREST, but `service` is PostgREST-exposed and the rows hold
-- users' recipe text, so the grants go too. Revoking a table privilege also
-- revokes it on every column.
--
-- service.user_recipe_verification_invocations is already
-- {postgres, service_role} only (table and sequence) and is not touched.

revoke all on table service.user_recipe_verification_diagnostics from anon;
revoke all on table service.user_recipe_verification_diagnostics from authenticated;

revoke all on sequence service.user_recipe_verification_diagnostics_id_seq from anon;
revoke all on sequence service.user_recipe_verification_diagnostics_id_seq from authenticated;
