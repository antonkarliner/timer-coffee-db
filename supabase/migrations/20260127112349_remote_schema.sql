CREATE INDEX new_roaster_candidates_processed_idx ON service.new_roaster_candidates USING btree (processed);

CREATE INDEX roaster_candidate_clusters_confidence_idx ON service.roaster_candidate_clusters USING btree (confidence);

CREATE INDEX roaster_candidate_clusters_updated_at_idx ON service.roaster_candidate_clusters USING btree (updated_at);

CREATE INDEX roaster_enrichment_jobs_attempts_idx ON service.roaster_enrichment_jobs USING btree (attempts);

CREATE INDEX roaster_enrichment_jobs_created_at_idx ON service.roaster_enrichment_jobs USING btree (created_at);

CREATE INDEX roaster_enrichment_results_updated_at_idx ON service.roaster_enrichment_results USING btree (updated_at);

grant delete on table "service"."roaster_candidate_clusters" to "anon";

grant insert on table "service"."roaster_candidate_clusters" to "anon";

grant references on table "service"."roaster_candidate_clusters" to "anon";

grant select on table "service"."roaster_candidate_clusters" to "anon";

grant trigger on table "service"."roaster_candidate_clusters" to "anon";

grant truncate on table "service"."roaster_candidate_clusters" to "anon";

grant update on table "service"."roaster_candidate_clusters" to "anon";

grant delete on table "service"."roaster_candidate_clusters" to "authenticated";

grant insert on table "service"."roaster_candidate_clusters" to "authenticated";

grant references on table "service"."roaster_candidate_clusters" to "authenticated";

grant select on table "service"."roaster_candidate_clusters" to "authenticated";

grant trigger on table "service"."roaster_candidate_clusters" to "authenticated";

grant truncate on table "service"."roaster_candidate_clusters" to "authenticated";

grant update on table "service"."roaster_candidate_clusters" to "authenticated";

grant delete on table "service"."roaster_candidate_clusters" to "service_role";

grant insert on table "service"."roaster_candidate_clusters" to "service_role";

grant references on table "service"."roaster_candidate_clusters" to "service_role";

grant select on table "service"."roaster_candidate_clusters" to "service_role";

grant trigger on table "service"."roaster_candidate_clusters" to "service_role";

grant truncate on table "service"."roaster_candidate_clusters" to "service_role";

grant update on table "service"."roaster_candidate_clusters" to "service_role";

grant delete on table "service"."roaster_enrichment_jobs" to "anon";

grant insert on table "service"."roaster_enrichment_jobs" to "anon";

grant references on table "service"."roaster_enrichment_jobs" to "anon";

grant select on table "service"."roaster_enrichment_jobs" to "anon";

grant trigger on table "service"."roaster_enrichment_jobs" to "anon";

grant truncate on table "service"."roaster_enrichment_jobs" to "anon";

grant update on table "service"."roaster_enrichment_jobs" to "anon";

grant delete on table "service"."roaster_enrichment_jobs" to "authenticated";

grant insert on table "service"."roaster_enrichment_jobs" to "authenticated";

grant references on table "service"."roaster_enrichment_jobs" to "authenticated";

grant select on table "service"."roaster_enrichment_jobs" to "authenticated";

grant trigger on table "service"."roaster_enrichment_jobs" to "authenticated";

grant truncate on table "service"."roaster_enrichment_jobs" to "authenticated";

grant update on table "service"."roaster_enrichment_jobs" to "authenticated";

grant delete on table "service"."roaster_enrichment_jobs" to "service_role";

grant insert on table "service"."roaster_enrichment_jobs" to "service_role";

grant references on table "service"."roaster_enrichment_jobs" to "service_role";

grant select on table "service"."roaster_enrichment_jobs" to "service_role";

grant trigger on table "service"."roaster_enrichment_jobs" to "service_role";

grant truncate on table "service"."roaster_enrichment_jobs" to "service_role";

grant update on table "service"."roaster_enrichment_jobs" to "service_role";

grant delete on table "service"."roaster_enrichment_results" to "anon";

grant insert on table "service"."roaster_enrichment_results" to "anon";

grant references on table "service"."roaster_enrichment_results" to "anon";

grant select on table "service"."roaster_enrichment_results" to "anon";

grant trigger on table "service"."roaster_enrichment_results" to "anon";

grant truncate on table "service"."roaster_enrichment_results" to "anon";

grant update on table "service"."roaster_enrichment_results" to "anon";

grant delete on table "service"."roaster_enrichment_results" to "authenticated";

grant insert on table "service"."roaster_enrichment_results" to "authenticated";

grant references on table "service"."roaster_enrichment_results" to "authenticated";

grant select on table "service"."roaster_enrichment_results" to "authenticated";

grant trigger on table "service"."roaster_enrichment_results" to "authenticated";

grant truncate on table "service"."roaster_enrichment_results" to "authenticated";

grant update on table "service"."roaster_enrichment_results" to "authenticated";

grant delete on table "service"."roaster_enrichment_results" to "service_role";

grant insert on table "service"."roaster_enrichment_results" to "service_role";

grant references on table "service"."roaster_enrichment_results" to "service_role";

grant select on table "service"."roaster_enrichment_results" to "service_role";

grant trigger on table "service"."roaster_enrichment_results" to "service_role";

grant truncate on table "service"."roaster_enrichment_results" to "service_role";

grant update on table "service"."roaster_enrichment_results" to "service_role";


