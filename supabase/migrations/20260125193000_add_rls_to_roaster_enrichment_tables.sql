-- RLS policies for roaster enrichment tables (admin + service role)

create policy "roaster_candidate_clusters_read_admin"
  on service.roaster_candidate_clusters
  for select
  using (public.is_admin());

create policy "roaster_candidate_clusters_update_admin"
  on service.roaster_candidate_clusters
  for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "roaster_candidate_clusters_service_role_manage"
  on service.roaster_candidate_clusters
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "roaster_enrichment_results_read_admin"
  on service.roaster_enrichment_results
  for select
  using (public.is_admin());

create policy "roaster_enrichment_results_update_admin"
  on service.roaster_enrichment_results
  for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "roaster_enrichment_results_service_role_manage"
  on service.roaster_enrichment_results
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "roaster_enrichment_jobs_read_admin"
  on service.roaster_enrichment_jobs
  for select
  using (public.is_admin());

create policy "roaster_enrichment_jobs_service_role_manage"
  on service.roaster_enrichment_jobs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
