-- Production RLS audit: hot-write-path tables (yearly_stats, global_stats,
-- global_coffee_beans, launch_popup, user_public_profiles). The app performs
-- Supabase anonymous sign-in, so every install holds an `authenticated`-role
-- JWT. Several INSERT/UPDATE policies on these tables had `with_check`/`qual`
-- hardcoded to `true`, letting any install write/rewrite rows attributed to
-- an arbitrary user_id, or (for yearly_stats) rewrite ANY row outright.
--
-- Compatibility bar: nothing may break for app versions already in the wild
-- that cannot be updated. Every change below was verified against the actual
-- Flutter call sites (git history checked back well past 6 months) before
-- being tightened; two of the six flagged policies are left untouched
-- because tightening them is not safe or not meaningful — see the per-table
-- notes.
--
-- ---------------------------------------------------------------------
-- 1) global_stats — INSERT (TIGHTENED)
-- ---------------------------------------------------------------------
-- Sole client writer: lib/screens/finish_screen.dart
-- insertBrewingDataToSupabase() — always requires a non-null
-- Supabase.instance.client.auth.currentUser (anonymous sign-in included)
-- and always sets 'user_id': user.id. This pattern was introduced in the
-- original "Supabase anonymous sign-in + global stats" commit and has never
-- changed since (git log -S on the literal string turns up exactly one
-- commit, the one that added it), so every app version in the wild uses it.
-- The only other writers are edge functions update-id-after-signin and
-- clean-before-deletion, both using the service-role key, which bypasses
-- RLS entirely and is unaffected by this policy change.
drop policy "Enable insert for authenticated users only" on public.global_stats;

create policy "Enable insert for authenticated users only" on public.global_stats
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------
-- 2) user_public_profiles — INSERT (TIGHTENED)
-- ---------------------------------------------------------------------
-- Sole writer: lib/providers/database_provider.dart ensureUserProfileExists(),
-- called only from lib/screens/account_screen.dart with
-- `userId: Supabase.instance.client.auth.currentUser?.id` (single call site,
-- lib/screens/hub_home_screen.dart _buildAccountTile) — always the caller's
-- own uid. AccountScreen's userId is a route path param, so this policy also
-- closes a real spoofing gap: a crafted deep link to /account/<other-uid>
-- previously could have inserted a profile row for someone else because
-- with_check was unconditionally true.
drop policy "Allow authenticated users to insert a profile" on public.user_public_profiles;

create policy "Allow authenticated users to insert a profile" on public.user_public_profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------
-- 3) yearly_stats — INSERT + UPDATE (TIGHTENED, different shape)
-- ---------------------------------------------------------------------
-- This table has no user_id column at all — it is a small set of shared
-- global counters (currently just one row, id = 'likes'). The
-- auth.uid() = user_id ownership pattern used elsewhere in this migration
-- does not apply here; there is nothing to own.
--
-- No app or landing code ever INSERTs into yearly_stats (grepped both
-- repos), so the open INSERT policy is dead weight and is dropped outright.
--
-- The only write path is lib/screens/yearly_stats_story_24_screen.dart
-- calling the RPC `increment_likes()`, which does
-- `UPDATE yearly_stats SET count = count + 1 WHERE id = 'likes'`. That
-- function was declared SECURITY INVOKER (the default), so today it only
-- works *because* of the permissive `qual = true` UPDATE policy being
-- removed here — dropping the policy without also fixing the function would
-- break the "like" feature for every app version, old and new.
-- increment_likes() takes no arguments, contains no dynamic SQL, and touches
-- exactly one hardcoded row, so flipping it to SECURITY DEFINER (already has
-- `SET search_path` pinned) is safe and lets it keep working once the
-- table-level policy is gone. This is backward-compatible with every app
-- version: they only ever call the RPC, never write the table directly.
alter function public.increment_likes() security definer;

drop policy "Enable insert for authenticated users only" on public.yearly_stats;
drop policy "Enable update for authenticated users" on public.yearly_stats;

-- ---------------------------------------------------------------------
-- 4) launch_popup — INSERT (TIGHTENED, different shape)
-- ---------------------------------------------------------------------
-- This table has no user_id column either — it is admin-managed popup
-- content, read by every app install (lib/providers/database_provider.dart
-- _fetchAndStoreLaunchPopup, lib/screens/info_screen.dart
-- _fetchLaunchPopupHistory — both SELECT-only). No Flutter code ever
-- inserts into launch_popup.
--
-- The only writer is the landing site's admin route
-- (src/pages/api/admin/launch-popup.ts), which validates the caller is an
-- admin via the check-admin-user edge function, but then performed the
-- immediate-publish INSERT using the admin's own session-bound
-- (`authenticated`-role) Supabase client. Because the RLS policy allowed
-- ANY authenticated principal to insert, that admin-only application check
-- was not actually enforced at the database layer: any install (anonymous
-- sign-in included) could POST directly to
-- /rest/v1/launch_popup and inject popup content shown to every user on
-- next launch. The scheduled-publish path already avoided this by calling
-- the schedule-launch-popup edge function with the service-role key in the
-- Authorization header.
--
-- Fix: drop the open policy entirely (no legitimate authenticated-role
-- writer exists), and switch the landing route's immediate-publish insert to
-- a service-role client (matching the pattern already used for scheduled
-- publishes and for src/pages/api/admin/roaster-candidates/actions.ts) —
-- see the accompanying change in the timer-coffee-landing-2 repo. Service
-- role bypasses RLS, so admin publishing keeps working; direct
-- authenticated-role writes from any other install no longer do.
drop policy "allow insert for authenticated" on public.launch_popup;

-- ---------------------------------------------------------------------
-- 5) global_coffee_beans — INSERT (LEFT ALONE)
-- ---------------------------------------------------------------------
-- No user_id column exists on this table (id, roaster, name, origin,
-- variety, tasting_notes, processing_method, region, cupping_score, farm,
-- farmer, coffee_roaster_id, created_at — confirmed against the live
-- schema). It is intentionally a fully anonymous, unauthenticated-safe
-- per-bean-add community log (per project notes, anonymous installs are
-- expected to contribute to it) with no PII and no per-row owner. The
-- auth.uid() = user_id pattern used above is not just unsafe here, it is
-- impossible — there is no column to check. The only realistic abuse is
-- junk-data pollution of aggregates, which RLS ownership scoping cannot fix
-- anyway (a bad actor already controls their own inserted content whether
-- or not the row records who sent it). Left untouched.
