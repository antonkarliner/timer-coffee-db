-- Supabase default privileges re-grant EXECUTE to anon and authenticated when
-- functions are created, so revoking from public alone is insufficient. Close
-- that privilege gap for Plan 062's functions.

revoke execute on function service.resolve_roaster_for_cluster(uuid) from public;
revoke execute on function service.resolve_roaster_for_cluster(uuid) from anon;
revoke execute on function service.resolve_roaster_for_cluster(uuid) from authenticated;
grant execute on function service.resolve_roaster_for_cluster(uuid) to service_role;
grant execute on function service.resolve_roaster_for_cluster(uuid) to postgres;

revoke execute on function service.apply_contribution_resolution(uuid) from public;
revoke execute on function service.apply_contribution_resolution(uuid) from anon;
revoke execute on function service.apply_contribution_resolution(uuid) from authenticated;
grant execute on function service.apply_contribution_resolution(uuid) to service_role;
grant execute on function service.apply_contribution_resolution(uuid) to postgres;

revoke execute on function service.handle_contribution_resolution_trigger() from public;
revoke execute on function service.handle_contribution_resolution_trigger() from anon;
revoke execute on function service.handle_contribution_resolution_trigger() from authenticated;
grant execute on function service.handle_contribution_resolution_trigger() to service_role;
grant execute on function service.handle_contribution_resolution_trigger() to postgres;

revoke execute on function service.reconcile_contribution_resolutions(integer) from public;
revoke execute on function service.reconcile_contribution_resolutions(integer) from anon;
revoke execute on function service.reconcile_contribution_resolutions(integer) from authenticated;
grant execute on function service.reconcile_contribution_resolutions(integer) to service_role;
grant execute on function service.reconcile_contribution_resolutions(integer) to postgres;

revoke execute on function public.get_my_contribution_acknowledgements(integer) from public;
revoke execute on function public.get_my_contribution_acknowledgements(integer) from anon;
grant execute on function public.get_my_contribution_acknowledgements(integer) to authenticated;
grant execute on function public.get_my_contribution_acknowledgements(integer) to service_role;
grant execute on function public.get_my_contribution_acknowledgements(integer) to postgres;

revoke execute on function public.mark_contribution_acknowledged(bigint, text) from public;
revoke execute on function public.mark_contribution_acknowledged(bigint, text) from anon;
grant execute on function public.mark_contribution_acknowledged(bigint, text) to authenticated;
grant execute on function public.mark_contribution_acknowledged(bigint, text) to service_role;
grant execute on function public.mark_contribution_acknowledged(bigint, text) to postgres;
