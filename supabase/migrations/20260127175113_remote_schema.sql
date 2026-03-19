CREATE INDEX IF NOT EXISTS new_roaster_candidates_cluster_id_idx ON service.new_roaster_candidates USING btree (cluster_id);

grant delete on table "service"."roaster_embedding_backfill" to "anon";

grant insert on table "service"."roaster_embedding_backfill" to "anon";

grant references on table "service"."roaster_embedding_backfill" to "anon";

grant select on table "service"."roaster_embedding_backfill" to "anon";

grant trigger on table "service"."roaster_embedding_backfill" to "anon";

grant truncate on table "service"."roaster_embedding_backfill" to "anon";

grant update on table "service"."roaster_embedding_backfill" to "anon";

grant delete on table "service"."roaster_embedding_backfill" to "authenticated";

grant insert on table "service"."roaster_embedding_backfill" to "authenticated";

grant references on table "service"."roaster_embedding_backfill" to "authenticated";

grant select on table "service"."roaster_embedding_backfill" to "authenticated";

grant trigger on table "service"."roaster_embedding_backfill" to "authenticated";

grant truncate on table "service"."roaster_embedding_backfill" to "authenticated";

grant update on table "service"."roaster_embedding_backfill" to "authenticated";

grant delete on table "service"."roaster_embedding_backfill" to "service_role";

grant insert on table "service"."roaster_embedding_backfill" to "service_role";

grant references on table "service"."roaster_embedding_backfill" to "service_role";

grant select on table "service"."roaster_embedding_backfill" to "service_role";

grant trigger on table "service"."roaster_embedding_backfill" to "service_role";

grant truncate on table "service"."roaster_embedding_backfill" to "service_role";

grant update on table "service"."roaster_embedding_backfill" to "service_role";


