-- Wrap bare auth.uid() / auth.role() calls in (select ...) so they are
-- evaluated once per query (initplan) rather than once per row.
-- Pure performance fix — no behavior change.

-- public.bean_reviews
DROP POLICY IF EXISTS "bean_reviews_own_update" ON public.bean_reviews;
CREATE POLICY "bean_reviews_own_update" ON public.bean_reviews
  FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- public.review_replies
DROP POLICY IF EXISTS "review_replies_own_update" ON public.review_replies;
CREATE POLICY "review_replies_own_update" ON public.review_replies
  FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- public.roaster_profiles
DROP POLICY IF EXISTS "roaster_profiles_service_role_manage" ON public.roaster_profiles;
CREATE POLICY "roaster_profiles_service_role_manage" ON public.roaster_profiles
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- public.user_recipe_localizations
DROP POLICY IF EXISTS "Allow user update own recipe localizations" ON public.user_recipe_localizations;
CREATE POLICY "Allow user update own recipe localizations" ON public.user_recipe_localizations
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.user_recipes r
    WHERE r.id = user_recipe_localizations.recipe_id
      AND (select auth.uid())::text = substring(r.vendor_id, 5)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_recipes r
    WHERE r.id = user_recipe_localizations.recipe_id
      AND (select auth.uid())::text = substring(r.vendor_id, 5)
  ));

-- public.user_recipes
DROP POLICY IF EXISTS "Update access for users based on user_id" ON public.user_recipes;
CREATE POLICY "Update access for users based on user_id" ON public.user_recipes
  FOR UPDATE
  USING (vendor_id = ('usr-'::text || (select auth.uid())::text))
  WITH CHECK (vendor_id = ('usr-'::text || (select auth.uid())::text));

-- public.user_steps
DROP POLICY IF EXISTS "Allow user update own recipe steps" ON public.user_steps;
CREATE POLICY "Allow user update own recipe steps" ON public.user_steps
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.user_recipes r
    WHERE r.id = user_steps.recipe_id
      AND (select auth.uid())::text = substring(r.vendor_id, 5)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_recipes r
    WHERE r.id = user_steps.recipe_id
      AND (select auth.uid())::text = substring(r.vendor_id, 5)
  ));

-- service.app_release_notifications
DROP POLICY IF EXISTS "Service role manage app release notifications" ON service.app_release_notifications;
CREATE POLICY "Service role manage app release notifications" ON service.app_release_notifications
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.giftbox_offer_clicks
DROP POLICY IF EXISTS "giftbox_offer_clicks_service_role_manage" ON service.giftbox_offer_clicks;
CREATE POLICY "giftbox_offer_clicks_service_role_manage" ON service.giftbox_offer_clicks
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.notification_analytics
DROP POLICY IF EXISTS "Service role manage analytics" ON service.notification_analytics;
CREATE POLICY "Service role manage analytics" ON service.notification_analytics
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.notification_delivery_logs
DROP POLICY IF EXISTS "Service role manage delivery logs" ON service.notification_delivery_logs;
CREATE POLICY "Service role manage delivery logs" ON service.notification_delivery_logs
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.notification_templates
DROP POLICY IF EXISTS "Service role manage templates" ON service.notification_templates;
CREATE POLICY "Service role manage templates" ON service.notification_templates
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.rate_limits
DROP POLICY IF EXISTS "Service role manage rate limits" ON service.rate_limits;
CREATE POLICY "Service role manage rate limits" ON service.rate_limits
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.recipe_draft_lab_access
DROP POLICY IF EXISTS "recipe_draft_lab_access_service_role_manage" ON service.recipe_draft_lab_access;
CREATE POLICY "recipe_draft_lab_access_service_role_manage" ON service.recipe_draft_lab_access
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.roaster_candidate_clusters
DROP POLICY IF EXISTS "roaster_candidate_clusters_service_role_manage" ON service.roaster_candidate_clusters;
CREATE POLICY "roaster_candidate_clusters_service_role_manage" ON service.roaster_candidate_clusters
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.roaster_enrichment_jobs
DROP POLICY IF EXISTS "roaster_enrichment_jobs_service_role_manage" ON service.roaster_enrichment_jobs;
CREATE POLICY "roaster_enrichment_jobs_service_role_manage" ON service.roaster_enrichment_jobs
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.roaster_enrichment_results
DROP POLICY IF EXISTS "roaster_enrichment_results_service_role_manage" ON service.roaster_enrichment_results;
CREATE POLICY "roaster_enrichment_results_service_role_manage" ON service.roaster_enrichment_results
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- service.scheduled_notifications (both policies)
DROP POLICY IF EXISTS "Service role manage scheduled notifications" ON service.scheduled_notifications;
CREATE POLICY "Service role manage scheduled notifications" ON service.scheduled_notifications
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS "Users manage own scheduled notifications" ON service.scheduled_notifications;
CREATE POLICY "Users manage own scheduled notifications" ON service.scheduled_notifications
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- service.user_fcm_tokens (both policies)
DROP POLICY IF EXISTS "Service role manage tokens" ON service.user_fcm_tokens;
CREATE POLICY "Service role manage tokens" ON service.user_fcm_tokens
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS "Users can manage own tokens" ON service.user_fcm_tokens;
CREATE POLICY "Users can manage own tokens" ON service.user_fcm_tokens
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- service.user_notification_preferences (both policies)
DROP POLICY IF EXISTS "Service role manage notification prefs" ON service.user_notification_preferences;
CREATE POLICY "Service role manage notification prefs" ON service.user_notification_preferences
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS "Users manage own notification prefs" ON service.user_notification_preferences;
CREATE POLICY "Users manage own notification prefs" ON service.user_notification_preferences
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- storage.objects (profile picture update)
DROP POLICY IF EXISTS "Allow Authenticated Update Own Profile Picture" ON storage.objects;
CREATE POLICY "Allow Authenticated Update Own Profile Picture" ON storage.objects
  FOR UPDATE
  USING ((bucket_id = 'user-profile-pictures'::text) AND ((select auth.uid())::text = name))
  WITH CHECK ((bucket_id = 'user-profile-pictures'::text) AND ((select auth.uid())::text = name));
