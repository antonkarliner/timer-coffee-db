-- Enable RLS on internal service tables for AI recipe verification.
-- service_role bypasses RLS automatically; no client-facing policies needed
-- because these tables are accessed exclusively via the verify-user-recipe-draft
-- edge function which uses the service role key.

alter table service.user_recipe_verification_invocations enable row level security;
alter table service.user_recipe_verification_diagnostics enable row level security;
