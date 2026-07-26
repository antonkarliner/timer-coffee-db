-- Fix production RLS misconfiguration on service.new_roaster_candidates.
--
-- The bug: "Allow updates for authenticated users" was UPDATE / to
-- {authenticated} / qual = true, i.e. any authenticated-role JWT could UPDATE
-- ANY row in this table with no ownership check whatsoever. "Enable read
-- access for authenticated users" was similarly SELECT / {authenticated} /
-- qual = true, and "Allow insert for all" was INSERT / {public} /
-- with_check = true. Because the Flutter app performs Supabase anonymous
-- sign-in, every install holds an authenticated-role JWT, and the `service`
-- schema is reachable via PostgREST (`.schema('service')`, see
-- lib/services/feature_flags/feature_flags_repository.dart and
-- lib/services/fcm_service.dart in the timer-coffee repo). So any install
-- could read every pending roaster candidate and -- worse -- edit or inject a
-- pending candidate's roaster name / bean name / location before a human
-- reviewer approves it into the production coffee_roasters directory via the
-- admin approval workflow (timer-coffee-landing-2
-- src/pages/api/admin/roaster-candidates/actions.ts). At the time of writing
-- the approval queue holds ~2,053 pending rows, so queue-flooding with
-- plausible-looking fake roasters was a practical attack.
--
-- What legitimately reads/writes this table (full inventory, 2026-07-26):
--   * INSERT: service.check-new-roaster and (indirectly, via the
--     submit-roaster-contribution edge function) end users all go through
--     edge functions authenticated with SUPABASE_SERVICE_ROLE_KEY -- service
--     role bypasses RLS entirely, so the "Allow insert for all" (public)
--     policy is not what those flows depend on.
--
--     An earlier draft of this migration left that policy in place on the
--     theory that older app builds in the wild might perform a raw PostgREST
--     insert directly against this table. That was checked and is FALSE:
--     `git log -S "new_roaster_candidates" --all -- lib/` in the timer-coffee
--     repo returns no commits, i.e. no version of the Flutter app has ever
--     referenced this table directly, in any release. The app's only
--     touchpoint is the public.roaster_contribution_target RPC (SECURITY
--     DEFINER, reads service.roaster_candidate_clusters -- a different table)
--     plus the submit-roaster-contribution edge function. The public INSERT
--     policy is therefore dead weight AND an open injection vector into the
--     approval queue, so it is dropped here.
--   * UPDATE (processed = true, on approve/reject/approve_alias): only
--     timer-coffee-landing-2's admin routes, which run under the admin's own
--     `authenticated` session via createPagesServerClient (NOT service role).
--     This is what the bogus qual=true policy was propping up.
--   * SELECT (raw candidate rows: roaster, coffee_bean_name, location): only
--     the same admin route ([clusterId].ts). The Flutter app never selects
--     this table directly.
--   * Triggers: service.assign_roaster_candidate_cluster (BEFORE INSERT, not
--     SECURITY DEFINER -- runs as whatever role performed the insert, which is
--     always service_role in practice) and service.notify_roaster_candidates
--     (AFTER INSERT) / service.sync_roaster_processed (AFTER UPDATE), both
--     SECURITY DEFINER, so both run as the function owner and are exempt from
--     RLS regardless of these policies.
--   * Cron: the "roaster-enrichment-worker" pg_cron job (every 5 min) calls
--     public.roaster_enrichment_worker_cron(), SECURITY DEFINER, which only
--     invokes the roaster-enrichment-worker edge function over HTTP with a
--     service-role/API-key header -- it never touches this table directly
--     with caller privileges.
--
-- Approach: rather than moving the admin routes to a service-role client
-- (which would leave the app-layer check-admin-user gate as the ONLY thing
-- protecting this table), the admin routes keep using the caller's own
-- session and the admin check is enforced at the DATABASE layer via the
-- existing SECURITY DEFINER public.is_admin() helper (checks
-- service.admin_users for auth.uid() with role in admin/super_admin). This
-- matches the pattern used for service.website_redirects in
-- 20260726180000_scope_website_redirects_writes.sql and means a bug in the
-- Next.js authorization code cannot by itself become a data breach.
--
-- Net effect: anon and non-admin authenticated callers lose all access
-- (SELECT/INSERT/UPDATE). service_role (the edge functions) is unaffected
-- because it bypasses RLS. Real admins retain full access, now verified
-- against service.admin_users by Postgres itself.

drop policy "Allow updates for authenticated users" on service.new_roaster_candidates;
drop policy "Enable read access for authenticated users" on service.new_roaster_candidates;
drop policy "Allow insert for all" on service.new_roaster_candidates;

-- service_role: explicit (redundant with RLS bypass, but documents intent and
-- matches the website_redirects precedent).
create policy "new_roaster_candidates_service_role_manage"
  on service.new_roaster_candidates
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- authenticated: only real admins (per service.admin_users, via the SECURITY
-- DEFINER public.is_admin() helper) may read the pending queue or mark
-- candidates processed. This is what preserves
-- src/pages/api/admin/roaster-candidates/[clusterId].ts (SELECT) and
-- actions.ts (UPDATE processed = true on the reject / approve_alias / approve
-- branches), which already gate on check-admin-user at the application layer;
-- the policy now enforces the same rule at the database layer.
create policy "new_roaster_candidates_admin_manage"
  on service.new_roaster_candidates
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
