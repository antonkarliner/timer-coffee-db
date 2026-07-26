-- public.coffee_roasters has RLS enabled with exactly one policy --
-- "Enable read access for all users" (FOR SELECT, to public, using (true)) --
-- and no UPDATE policy at all. anon and authenticated nonetheless hold
-- table-level UPDATE grants on it, so an UPDATE issued from an authenticated
-- session is not rejected with 42501 -- RLS silently filters it down to zero
-- affected rows and PostgREST reports success anyway.
--
-- The admin roaster-candidate approval flow in the timer-coffee-landing-2
-- repo (src/pages/api/admin/roaster-candidates/actions.ts, "approve" action
-- with mode "update") issues exactly such an UPDATE using the admin's own
-- session. As a result, admin edits made through that flow are silently
-- discarded and the roaster row never changes, with no error surfaced
-- anywhere in the stack.
--
-- service_role has BYPASSRLS, so edge functions that write to this table are
-- already unaffected and do not need a policy here.
--
-- Add an admin-only UPDATE policy, mirroring the shape of
-- service.roaster_candidate_clusters_update_admin.
drop policy if exists coffee_roasters_update_admin on public.coffee_roasters;
create policy coffee_roasters_update_admin on public.coffee_roasters
    for update
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
