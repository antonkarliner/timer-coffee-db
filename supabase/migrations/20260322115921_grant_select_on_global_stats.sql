-- Grant read access on global_stats to public roles and Grafana
grant select on table "public"."global_stats" to "anon";
grant select on table "public"."global_stats" to "authenticated";
grant select on table "public"."global_stats" to "grafana";
