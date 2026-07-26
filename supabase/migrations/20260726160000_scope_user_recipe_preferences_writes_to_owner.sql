-- Fix production write-abuse bug on public.user_recipe_preferences, found while
-- auditing the SELECT policies fixed in 20260726143000 / 20260726150000.
--
-- Two of this table's four policies have no owner check at all:
--   * "Enable insert for authenticated users only" — FOR INSERT TO authenticated,
--     with_check = true. Any authenticated-role JWT can insert a row claiming an
--     arbitrary user_id.
--   * "Allow update to authenticated users" — FOR UPDATE TO authenticated,
--     qual = true, with_check = true. Any authenticated-role JWT can update ANY
--     other user's row: is_favorite, custom_coffee_amount, custom_water_amount,
--     custom_grind_size, custom_water_temp and the slider positions — and can
--     also reassign user_id, moving a row to another account.
-- Because the app performs Supabase anonymous sign-in, every install holds an
-- authenticated-role JWT, so any install could vandalize another user's saved
-- brew customizations (6,598 rows). Not a bulk-read leak (the SELECT policy is
-- now owner-scoped), but a live data-integrity / write-abuse hole.
--
-- The DELETE policy on this same table ("Enable delete for users based on
-- user_id", qual = ((select auth.uid()) = user_id)) is already correct, as are
-- all three write policies on the sibling table public.user_coffee_beans. This
-- migration brings INSERT and UPDATE here in line with both.
--
-- Compatibility analysis (full audit of every writer, not just the obvious ones):
--
-- Client — all five Supabase call sites against this table live in
-- lib/providers (timer-coffee repo); every one is already owner-scoped, and
-- each skips remote work entirely for anonymous users:
--   * database_provider.dart uploadUserPreferencesToSupabase — upsert of the
--     full local preference list, every row built with 'user_id': user.id.
--   * database_provider.dart updateUserPreferenceInSupabase — upsert of a single
--     row, payload includes 'user_id': user.id.
--     (Both are upserts, i.e. INSERT ... ON CONFLICT DO UPDATE, so they must
--     satisfy the INSERT with_check AND, on conflict, the UPDATE qual +
--     with_check. Writing only their own user_id, they satisfy all three.)
--   * user_recipe_provider.dart _clearCustomAmountsInSupabase — UPDATE filtered
--     .eq('user_id', user.id).eq('recipe_id', recipeId); it nulls the custom
--     amounts and does not touch user_id, so both qual and with_check hold.
--   * user_recipe_provider.dart deleteUserRecipe — DELETE matched on
--     {user_id: user.id, recipe_id}; governed by the DELETE policy, untouched here.
--   * database_provider.dart fetchAndInsertUserPreferencesFromSupabase — SELECT
--     .eq('user_id', user.id); governed by the SELECT policy, untouched here.
-- No legitimate client flow writes another user's row. No frontend change is
-- required and no app version in the wild breaks.
--
-- Database-side writers — handle_user_recipe_deletion is the only function whose
-- body touches this table (checked pg_proc); it is SECURITY DEFINER and so
-- bypasses RLS entirely. No triggers exist on the table (checked pg_trigger).
--
-- Edge functions — only clean-before-deletion writes here, through the
-- SUPABASE_SERVICE_ROLE_KEY client (bypasses RLS), and only issues user_id-scoped
-- DELETEs. No admin tooling writes cross-user rows via a user JWT.
--
-- Data check: 0 of the 6,598 rows have a NULL user_id, so no legitimate row
-- becomes unwritable under an owner-scoped qual. (28 rows reference deleted
-- auth.users; those were already unreadable after 20260726150000 and remain
-- service_role-only, which is correct.)
--
-- Use the (select auth.uid()) form so Postgres caches the result per statement
-- instead of re-evaluating it per row.
drop policy "Enable insert for authenticated users only" on public.user_recipe_preferences;

create policy "Enable insert for authenticated users only" on public.user_recipe_preferences
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy "Allow update to authenticated users" on public.user_recipe_preferences;

create policy "Allow update to authenticated users" on public.user_recipe_preferences
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
