-- A roaster can always read their own profile, even while it is hidden
-- (is_active = false). The reply and reply-draft insert policies check
-- ownership by reading roaster_profiles as the caller, so without this a
-- roaster whose page is hidden can neither reply nor save drafts.
create policy roaster_profiles_owner_read on public.roaster_profiles
  for select to authenticated
  using (admin_user_id = (select auth.uid()));
