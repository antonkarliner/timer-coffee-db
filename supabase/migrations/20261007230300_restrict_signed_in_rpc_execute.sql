-- Security F17 (4 of 5): remove anon EXECUTE from RPCs that always run with a
-- session.
--
-- Callers always hold a session (the app signs in anonymously at startup before
-- calling, the roaster portal uses the admin's session), and each function
-- either reads auth.uid() or is a signed-in-only write. End state:
-- {postgres, authenticated, service_role}.
--
--   get_my_roaster_profile, update_my_roaster_profile, log_recipe_import,
--   log_connection_endpoint, increment_likes
--                          signed-in callers only.
--   roaster_contribution_target
--                          app (signed in) and submit-roaster-contribution
--                          (service role).
--   can_access_user_recipe qual of three RLS policies on user_recipes,
--                          user_steps and user_recipe_localizations that are all
--                          TO authenticated. An RLS qual IS an EXECUTE check
--                          against the querying role, so authenticated MUST keep
--                          it; anon is never judged by those policies.
--
-- This migration changes no function body, only privileges.

-- Signed-in RPCs.

revoke execute on function public.get_my_roaster_profile() from public;
revoke execute on function public.get_my_roaster_profile() from anon;
revoke execute on function public.get_my_roaster_profile() from authenticated;
grant  execute on function public.get_my_roaster_profile() to authenticated;
grant  execute on function public.get_my_roaster_profile() to service_role;
grant  execute on function public.get_my_roaster_profile() to postgres;

revoke execute on function public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text) from public;
revoke execute on function public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text) from anon;
revoke execute on function public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text) from authenticated;
grant  execute on function public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text) to authenticated;
grant  execute on function public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text) to service_role;
grant  execute on function public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text) to postgres;

revoke execute on function public.log_recipe_import(text) from public;
revoke execute on function public.log_recipe_import(text) from anon;
revoke execute on function public.log_recipe_import(text) from authenticated;
grant  execute on function public.log_recipe_import(text) to authenticated;
grant  execute on function public.log_recipe_import(text) to service_role;
grant  execute on function public.log_recipe_import(text) to postgres;

revoke execute on function public.log_connection_endpoint(text, text) from public;
revoke execute on function public.log_connection_endpoint(text, text) from anon;
revoke execute on function public.log_connection_endpoint(text, text) from authenticated;
grant  execute on function public.log_connection_endpoint(text, text) to authenticated;
grant  execute on function public.log_connection_endpoint(text, text) to service_role;
grant  execute on function public.log_connection_endpoint(text, text) to postgres;

revoke execute on function public.increment_likes() from public;
revoke execute on function public.increment_likes() from anon;
revoke execute on function public.increment_likes() from authenticated;
grant  execute on function public.increment_likes() to authenticated;
grant  execute on function public.increment_likes() to service_role;
grant  execute on function public.increment_likes() to postgres;

revoke execute on function public.roaster_contribution_target(text) from public;
revoke execute on function public.roaster_contribution_target(text) from anon;
revoke execute on function public.roaster_contribution_target(text) from authenticated;
grant  execute on function public.roaster_contribution_target(text) to authenticated;
grant  execute on function public.roaster_contribution_target(text) to service_role;
grant  execute on function public.roaster_contribution_target(text) to postgres;

revoke execute on function public.can_access_user_recipe(text, text) from public;
revoke execute on function public.can_access_user_recipe(text, text) from anon;
revoke execute on function public.can_access_user_recipe(text, text) from authenticated;
grant  execute on function public.can_access_user_recipe(text, text) to authenticated;
grant  execute on function public.can_access_user_recipe(text, text) to service_role;
grant  execute on function public.can_access_user_recipe(text, text) to postgres;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'public.get_my_roaster_profile()'::regprocedure,
    'public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text, text)'::regprocedure,
    'public.log_recipe_import(text)'::regprocedure,
    'public.log_connection_endpoint(text, text)'::regprocedure,
    'public.increment_likes()'::regprocedure,
    'public.roaster_contribution_target(text)'::regprocedure,
    'public.can_access_user_recipe(text, text)'::regprocedure
  ];
begin
  foreach fn in array fns loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'anon can still execute %', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'execute') is distinct from true then
      raise exception 'authenticated execute on % should be true', fn;
    end if;
    if has_function_privilege('service_role', fn, 'execute') is distinct from true then
      raise exception 'service_role cannot execute %', fn;
    end if;
    if exists (
      select 1
      from pg_proc p
      where p.oid = fn
        and (
          p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
        )
    ) then
      raise exception 'PUBLIC still holds an execute grant on %', fn;
    end if;
  end loop;
end $$;
