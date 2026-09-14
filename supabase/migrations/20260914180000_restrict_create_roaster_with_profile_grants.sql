-- Plan 030 follow-up: actually restrict the privileged roaster create RPC.
--
-- 20260914174500 created public.create_roaster_with_profile as SECURITY
-- DEFINER, did `revoke all ... from public`, and granted execute to
-- service_role. That is not sufficient on Supabase: the project has default
-- privileges that grant EXECUTE on new functions in the `public` schema to
-- `anon` and `authenticated`. Those are role grants, and `REVOKE ... FROM
-- PUBLIC` removes only the PUBLIC pseudo-role grant, so both roles kept
-- EXECUTE on a SECURITY DEFINER function that inserts into
-- public.coffee_roasters and updates public.roaster_profiles.
--
-- Verified on production after 20260914174500 was applied:
--   has_function_privilege('anon',          '...', 'execute') = true
--   has_function_privilege('authenticated', '...', 'execute') = true
-- Audit of public.coffee_roasters over the exposure window found no
-- illegitimate rows.
--
-- The pure, read-only helpers (canonicalize_instagram_url,
-- is_instagram_website_url) are deliberately left callable: they take text and
-- return text/boolean, touch no tables, and the reconciliation query and the
-- owner-facing profile RPC both rely on them.

revoke execute on function public.create_roaster_with_profile(
  text, text, text, text, text, text, text, text, text
) from anon, authenticated, public;

grant execute on function public.create_roaster_with_profile(
  text, text, text, text, text, text, text, text, text
) to service_role;

do $do$
begin
  if has_function_privilege(
       'anon',
       'public.create_roaster_with_profile(text,text,text,text,text,text,text,text,text)',
       'execute')
     or has_function_privilege(
       'authenticated',
       'public.create_roaster_with_profile(text,text,text,text,text,text,text,text,text)',
       'execute')
  then
    raise exception
      'create_roaster_with_profile is still executable by anon or authenticated';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.create_roaster_with_profile(text,text,text,text,text,text,text,text,text)',
       'execute')
  then
    raise exception
      'create_roaster_with_profile is not executable by service_role';
  end if;
end;
$do$;
