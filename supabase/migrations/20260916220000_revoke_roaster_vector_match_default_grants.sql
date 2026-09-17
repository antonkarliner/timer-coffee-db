-- Close the default-privilege EXECUTE grants on
-- public.find_potential_roaster_matches_with_vector.
--
-- Verified against pg_proc on 2026-09-16, the function sits at
--   {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
-- i.e. executable by PUBLIC, anon and authenticated. That is the
-- ALTER DEFAULT PRIVILEGES pattern described in CLAUDE.md: this database
-- grants EXECUTE to anon, authenticated and service_role on newly created
-- public functions, and because those are grants to *named* roles, a
-- `revoke ... from public` at creation time never removed them.
--
-- The function is the embedding-based variant of the roaster matcher. It has
-- no callers: no reference anywhere outside its own defining migrations, and
-- none in PostgREST request logs. The non-vector matcher was tightened to
-- {postgres, service_role} in 20260916215000; this brings its sibling in line.
--
-- Revoking rather than dropping. The function is dead code and a drop would
-- also be defensible, but a revoke closes the exposure without removing the
-- record of the approach, and is trivially reversible. It reads only
-- public.coffee_roasters (public data), so this is surface reduction rather
-- than the closing of an active hole.

revoke execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) from public;
revoke execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) from anon;
revoke execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) from authenticated;
grant execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) to service_role;
grant execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) to postgres;
