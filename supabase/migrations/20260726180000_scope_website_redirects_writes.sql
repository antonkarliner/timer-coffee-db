-- Fix production RLS misconfiguration: service.website_redirects and
-- service.website_redirect_clicks each have a policy named "Allow service
-- role all" (cmd = ALL, qual = true, with_check = true) that is granted to
-- {public} instead of being restricted to the service_role. Service role
-- bypasses RLS entirely, so this policy grants nothing extra to service
-- role -- its only real effect is granting full public SELECT/INSERT/
-- UPDATE/DELETE to anon AND to authenticated. Both roles also hold
-- blanket table-level DML grants (legacy dump), and the `service` schema
-- IS exposed via PostgREST (the Flutter app calls .schema('service') for
-- feature flags / FCM; the same PostgREST surface is reachable with the
-- public anon key for these two tables). Every app install additionally
-- performs Supabase anonymous sign-in, so every install also holds an
-- `authenticated`-role JWT -- meaning the bug was exploitable with EITHER
-- key, not just anon.
--
-- Impact: any caller holding the anon (or an anonymous-auth authenticated)
-- key could repoint a redirect slug to an arbitrary URL -- an open
-- redirect on the timer.coffee domain -- or delete/overwrite the
-- redirect and click-log tables outright.
--
-- Call-site inventory (this migration's compatibility analysis):
--
-- 1. supabase/functions/website-redirect-go/index.ts (edge function)
--    Reads website_redirects and inserts website_redirect_clicks using
--    SUPABASE_SERVICE_ROLE_KEY exclusively. Bypasses RLS; unaffected by
--    any policy change here.
--
-- 2. timer-coffee-landing-2 src/pages/go/[slug].ts
--    Direct-DB fallback path (used when SUPABASE_SERVICE_ROLE_KEY is
--    configured in Vercel) reads website_redirects and inserts
--    website_redirect_clicks using a client built with
--    SUPABASE_SERVICE_ROLE_KEY. Bypasses RLS; unaffected. (The preferred
--    path proxies through the edge function above using the anon key over
--    HTTP, but that edge function itself only ever touches the DB with
--    the service role -- the anon key never reaches Postgres for this
--    table.)
--
-- 3. timer-coffee-landing-2 src/pages/api/admin/redirects.ts
--    The ONLY legitimate non-service-role writer. Built with
--    createPagesServerClient (auth-helpers-nextjs), i.e. it executes as
--    the signed-in user's `authenticated`-role JWT -- NOT service role.
--    It manually verifies the caller is an admin (via the check-admin-user
--    edge function, which checks service.admin_users) before doing
--    GET/POST/PUT/DELETE against service.website_redirects, and GET also
--    selects a website_redirect_clicks(count) aggregate for the same
--    admin-only view (src/pages/admin/redirects.tsx, which only ever
--    calls this API route -- no direct client-side Supabase calls).
--    This flow was relying on the buggy public ALL policy to work; it is
--    NOT covered by service role and would break under a naive
--    service-role-only lockdown. Preserved below via an is_admin()-gated
--    policy for the `authenticated` role, which mirrors the caller's own
--    admin check instead of trusting client-side code alone.
--
-- 4. Flutter app (timer-coffee lib/): no references to either table
--    (grep across lib/ and test/ is empty). No client changes needed.
--
-- 5. DB functions/triggers/cron: no pg_proc body, pg_trigger, or
--    cron.job references either table. No other server-side writers.
--
-- Anon INSERT on website_redirect_clicks: NOT needed. Every click-logging
-- call site (edge function and landing direct-DB path) inserts with the
-- service role, never with anon/authenticated. There is no browser-side
-- or anon-context click insert anywhere in the codebase, so no anon
-- policy is added for website_redirect_clicks.
--
-- service.website_redirects also has a separate, correctly-scoped policy
-- "Allow public read" ({public}, SELECT, qual = true) which is left
-- untouched. Redirect resolution is meant to be publicly resolvable
-- (that's the point of a redirect slug), so public SELECT is intentional
-- and low-risk to keep -- unlike the write policy, an over-permissive
-- SELECT here does not enable tampering, only lets someone read which
-- slugs exist and where they point, which is discoverable anyway by
-- visiting the slug.
--
-- This migration follows the same pattern already established for the
-- analogous service.giftbox_offer_clicks table (see
-- 20251215124000_add_rls_to_service_giftbox_offer_clicks.sql): drop the
-- mis-scoped catch-all policy, replace it with an explicit
-- service_role-only "manage" policy and an is_admin()-gated policy for
-- the real authenticated writer/reader. Table-level GRANTs to anon/
-- authenticated are left as-is (consistent with that precedent) because
-- RLS, not GRANT, is the actual enforcement boundary for the DML verbs
-- PostgREST exposes (SELECT/INSERT/UPDATE/DELETE); the surviving legacy
-- GRANTs cannot be exercised without also satisfying one of the policies
-- below.

drop policy "Allow service role all" on service.website_redirects;
drop policy "Allow service role all" on service.website_redirect_clicks;

-- service_role: explicit (redundant with RLS bypass, but documents intent
-- and matches the giftbox_offer_clicks precedent).
create policy "website_redirects_service_role_manage"
  on service.website_redirects
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "website_redirect_clicks_service_role_manage"
  on service.website_redirect_clicks
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- authenticated: only real admins (per service.admin_users, checked via
-- the SECURITY DEFINER public.is_admin() helper already used elsewhere)
-- may create/update/delete redirects. This is what actually preserves
-- src/pages/api/admin/redirects.ts, which already gates the same action
-- at the application layer -- the RLS policy now enforces the same rule
-- at the database layer instead of relying solely on client-side code.
create policy "website_redirects_admin_manage"
  on service.website_redirects
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- authenticated: admins may read click counts (the
-- website_redirect_clicks(count) aggregate in the admin GET handler).
-- No write policy for authenticated -- nothing in the codebase writes
-- clicks as authenticated; all click inserts are service-role only.
create policy "website_redirect_clicks_admin_read"
  on service.website_redirect_clicks
  for select
  to authenticated
  using (public.is_admin());
