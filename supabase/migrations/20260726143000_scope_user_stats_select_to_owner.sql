-- Fix production data-exposure bug: the SELECT policy on public.user_stats
-- was "Read access for authenticated users" with qual = true, granting every
-- authenticated-role JWT read access to EVERY row in the table. Because the
-- app performs Supabase anonymous sign-in, every install holds an
-- authenticated-role JWT, so any install could read all other users' brews,
-- including free-text notes, beans, roaster, rating, tags, and user_id.
--
-- The only SELECT call site missing a user_id filter
-- (lib/providers/user_stat_provider.dart _fetchFullRemoteStats) only ever
-- queries stat_uuids already scoped to the current user, so tightening this
-- policy is backward-compatible with app versions already in the wild.
--
-- Replace with an owner-scoped policy, matching the pattern already used by
-- the INSERT/UPDATE/DELETE policies on this table. Use the
-- (select auth.uid()) form so Postgres caches the result per statement
-- instead of re-evaluating per row (this table has ~72k rows).
drop policy "Read access for authenticated users" on public.user_stats;

create policy "Read access for authenticated users" on public.user_stats
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
