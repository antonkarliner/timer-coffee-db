-- Fix production data-exposure bug (same class just fixed on public.user_stats):
-- public.user_coffee_beans and public.user_recipe_preferences both have RLS
-- enabled but a permissive SELECT policy with qual = true, granting every
-- authenticated-role JWT read access to EVERY row. Because the app performs
-- Supabase anonymous sign-in, every install holds an authenticated-role JWT,
-- so any install could read all other users' bean collections (roaster,
-- name, origin, tasting notes, free-text notes, photo URLs — 6,160 rows /
-- 1,039 users) and all other users' recipe preferences (6,598 rows).
--
-- Compatibility analysis (full audit, not just the obvious call sites):
--
-- Client (lib/providers/*.dart) — every remote SELECT against these two
-- tables already filters by the current user:
--   * coffee_beans_provider.dart batchDownloadCoffeeBeans / syncNewCoffeeBeans
--     both .eq('user_id', user.id).
--   * coffee_beans_provider.dart _fetchFullRemoteBeans filters only by
--     beans_uuid (no user_id filter), but the UUID list it's called with
--     always comes from a prior .eq('user_id', user.id) query in the same
--     sync flow, so it only ever requests the current user's own bean UUIDs.
--   * database_provider.dart fetchAndInsertUserPreferencesFromSupabase
--     .eq('user_id', user.id).
--   * user_recipe_provider.dart and the remaining database_provider.dart call
--     sites against these two tables are all upsert/update/delete (writes),
--     unaffected by a SELECT policy change.
-- No frontend change is required.
--
-- Database-side readers — every function whose body touches either table was
-- checked live via pg_proc.prosecdef:
--   * get_roaster_review_facets, get_roaster_reviews, get_unnormalized_bean_origins,
--     normalize_bean_origins_cron, handle_user_recipe_deletion — ALL
--     SECURITY DEFINER, so they already bypass RLS entirely and are
--     unaffected by this policy change regardless of invoker (edge function
--     service-role key or pg_cron via the 'normalize-bean-origins' job).
-- No triggers exist on either table (checked pg_trigger).
--
-- Edge functions — only clean-before-deletion touches these tables, via the
-- SUPABASE_SERVICE_ROLE_KEY client (bypasses RLS) and only issues user_id-
-- scoped DELETEs. No edge function reads either table cross-user via a user
-- JWT.
--
-- Net: no legitimate cross-user reader depends on the permissive policy.
-- Tightening is backward-compatible with every app version in the wild.
--
-- Replace both permissive SELECT policies with owner-scoped ones, matching
-- the pattern already used by these tables' own INSERT/UPDATE/DELETE
-- policies and by the user_stats fix. Use the (select auth.uid()) form so
-- Postgres caches the result per statement instead of re-evaluating per row.
drop policy "Read access for authenticated users" on public.user_coffee_beans;

create policy "Read access for authenticated users" on public.user_coffee_beans
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy "Allow read access for authenticated users" on public.user_recipe_preferences;

create policy "Allow read access for authenticated users" on public.user_recipe_preferences
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
