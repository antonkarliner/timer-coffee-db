-- Fix mutable search_path on functions to prevent search_path hijacking.
-- Without a fixed search_path a malicious user could shadow trusted objects
-- by creating identically-named functions/types in a schema that appears
-- earlier in the session's search_path.

-- analytics
alter function analytics.maintain_partitions()
  set search_path = analytics, public, pg_catalog;

-- grafana
alter function grafana.secure_users_metrics()
  set search_path = grafana, public, pg_catalog;

-- public
alter function public.add_roaster_alias(p_roaster_id bigint, p_alias text, p_source_cluster_id uuid)
  set search_path = public, extensions, pg_catalog;

alter function public.aggregate_coffee_volume()
  set search_path = public, extensions, pg_catalog;

alter function public.backfill_global_stats_daily()
  set search_path = public, extensions, pg_catalog;

alter function public.backfill_global_stats_hourly(p_start_hour timestamp with time zone, p_end_hour timestamp with time zone)
  set search_path = public, extensions, pg_catalog;

alter function public.can_access_user_recipe(user_id text, recipe_id text)
  set search_path = public, extensions, pg_catalog;

alter function public.enqueue_popup(_content text, _locale text, _run_at timestamp with time zone)
  set search_path = public, extensions, pg_catalog;

alter function public.find_potential_roaster_matches(search_normalized_name text, search_display_name text, max_results integer, min_confidence double precision)
  set search_path = public, extensions, pg_catalog;

alter function public.find_potential_roaster_matches_with_vector(search_normalized_name text, search_display_name text, query_embedding vector, max_results integer, min_confidence double precision)
  set search_path = public, extensions, pg_catalog;

alter function public.get_cluster_with_matches(p_cluster_id uuid)
  set search_path = public, extensions, pg_catalog;

alter function public.get_roaster_profile(p_slug text)
  set search_path = public, extensions, pg_catalog;

alter function public.get_roaster_profile_by_name(p_roaster_name text)
  set search_path = public, extensions, pg_catalog;

alter function public.get_roaster_rating_summary(p_roaster_profile_id uuid)
  set search_path = public, extensions, pg_catalog;

alter function public.get_roaster_reviews(p_roaster_profile_id uuid, p_offset integer, p_limit integer)
  set search_path = public, extensions, pg_catalog;

alter function public.get_roasters_needing_dominant_color(batch_size integer)
  set search_path = public, extensions, pg_catalog;

alter function public.get_roasters_needing_embeddings(batch_size integer)
  set search_path = public, extensions, pg_catalog;

alter function public.handle_updated_at()
  set search_path = public, extensions, pg_catalog;

alter function public.handle_user_recipe_deletion()
  set search_path = public, extensions, pg_catalog;

alter function public.immutable_unaccent(text)
  set search_path = public, extensions, pg_catalog;

alter function public.increment_likes()
  set search_path = public, extensions, pg_catalog;

alter function public.link_pending_bean_reviews()
  set search_path = public, extensions, pg_catalog;

alter function public.maintain_normalized_names()
  set search_path = public, extensions, pg_catalog;

alter function public.record_embedding_backfill(p_roaster_id bigint, p_success boolean, p_error_message text)
  set search_path = public, extensions, pg_catalog;

alter function public.record_roaster_dominant_color_backfill(p_roaster_id bigint, p_success boolean, p_error_message text)
  set search_path = public, extensions, pg_catalog;

alter function public.refresh_global_stats_daily(p_target_date date)
  set search_path = public, extensions, pg_catalog;

alter function public.refresh_global_stats_hourly(p_target_hour timestamp with time zone)
  set search_path = public, extensions, pg_catalog;

alter function public.search_roaster_candidates(in_value text, match_threshold double precision)
  set search_path = public, extensions, pg_catalog;

alter function public.search_roaster_unaccent(search_name text)
  set search_path = public, extensions, pg_catalog;

alter function public.search_roasters_by_vector(query_embedding vector, match_threshold double precision, match_count integer)
  set search_path = public, extensions, pg_catalog;

alter function public.search_roasters_fuzzy(search_term text, result_limit integer)
  set search_path = public, extensions, pg_catalog;

alter function public.translate_launch_popup()
  set search_path = public, extensions, pg_catalog;

alter function public.update_recipe_last_modified()
  set search_path = public, extensions, pg_catalog;

-- service
alter function service.aggregate_performance_metrics()
  set search_path = service, public, extensions, pg_catalog;

alter function service.assign_roaster_candidate_cluster()
  set search_path = service, public, extensions, pg_catalog;

alter function service.check_alert_thresholds()
  set search_path = service, public, extensions, pg_catalog;

alter function service.cleanup_old_logs()
  set search_path = service, public, extensions, pg_catalog;

alter function service.cleanup_old_rate_limits()
  set search_path = service, public, extensions, pg_catalog;

alter function service.get_broadcast_target_locales(p_target_device_types text[], p_target_user_ids uuid[])
  set search_path = service, public, extensions, pg_catalog;

alter function service.get_user_target_locales(p_user_id uuid, p_target_device_types text[])
  set search_path = service, public, extensions, pg_catalog;

alter function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text)
  set search_path = service, public, extensions, pg_catalog;

alter function service.hash_fcm_token(token_input text)
  set search_path = service, public, extensions, pg_catalog;

alter function service.is_admin()
  set search_path = service, public, extensions, pg_catalog;

alter function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text)
  set search_path = service, public, extensions, pg_catalog;

alter function service.normalize_roaster_name(input text)
  set search_path = service, public, extensions, pg_catalog;

alter function service.set_updated_at()
  set search_path = service, public, extensions, pg_catalog;

alter function service.update_updated_at_column()
  set search_path = service, public, extensions, pg_catalog;
