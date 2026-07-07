-- Fix auth_rls_initplan: replace bare auth.uid()/auth.role() calls with
-- (select auth.uid())/(select auth.role()) so Postgres can cache the result
-- once per query instead of re-evaluating it for every row.

-- public.bean_reviews
drop policy if exists "bean_reviews_authenticated_insert" on public.bean_reviews;
create policy "bean_reviews_authenticated_insert" on public.bean_reviews
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "bean_reviews_own_delete" on public.bean_reviews;
create policy "bean_reviews_own_delete" on public.bean_reviews
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- public.parse_user_recipe_draft_invocations
drop policy if exists "users_read_own_invocations" on public.parse_user_recipe_draft_invocations;
create policy "users_read_own_invocations" on public.parse_user_recipe_draft_invocations
  for select
  using ((select auth.uid()) = user_id);

-- public.review_replies
drop policy if exists "review_replies_own_delete" on public.review_replies;
create policy "review_replies_own_delete" on public.review_replies
  for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "review_replies_roaster_admin_insert" on public.review_replies;
create policy "review_replies_roaster_admin_insert" on public.review_replies
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from bean_reviews br
      join roaster_profiles rp on rp.id = br.roaster_profile_id
      where br.id = review_replies.review_id
        and rp.admin_user_id = (select auth.uid())
    )
  );

-- public.user_recipe_localizations
drop policy if exists "Allow user delete own recipe localizations" on public.user_recipe_localizations;
create policy "Allow user delete own recipe localizations" on public.user_recipe_localizations
  for delete to authenticated
  using (exists (
    select 1 from user_recipes r
    where r.id = user_recipe_localizations.recipe_id
      and ((select auth.uid())::text = substring(r.vendor_id, 5))
  ));

drop policy if exists "Allow user insert own recipe localizations" on public.user_recipe_localizations;
create policy "Allow user insert own recipe localizations" on public.user_recipe_localizations
  for insert to authenticated
  with check (exists (
    select 1 from user_recipes r
    where r.id = user_recipe_localizations.recipe_id
      and ((select auth.uid())::text = substring(r.vendor_id, 5))
  ));

drop policy if exists "user_recipe_localizations_select_policy" on public.user_recipe_localizations;
create policy "user_recipe_localizations_select_policy" on public.user_recipe_localizations
  for select to authenticated
  using (exists (
    select 1 from user_recipes r
    where r.id = user_recipe_localizations.recipe_id
      and can_access_user_recipe((select auth.uid())::text, user_recipe_localizations.recipe_id)
  ));

-- public.user_recipes
drop policy if exists "Delete access for users based on user_id" on public.user_recipes;
create policy "Delete access for users based on user_id" on public.user_recipes
  for delete to authenticated
  using (vendor_id = 'usr-' || (select auth.uid())::text);

drop policy if exists "Insert access for users based on user_id" on public.user_recipes;
create policy "Insert access for users based on user_id" on public.user_recipes
  for insert to authenticated
  with check (vendor_id = 'usr-' || (select auth.uid())::text);

drop policy if exists "Read access for authenticated users" on public.user_recipes;
create policy "Read access for authenticated users" on public.user_recipes
  for select to authenticated
  using (can_access_user_recipe((select auth.uid())::text, id));

-- public.user_steps
drop policy if exists "Allow user delete own recipe steps" on public.user_steps;
create policy "Allow user delete own recipe steps" on public.user_steps
  for delete to authenticated
  using (exists (
    select 1 from user_recipes r
    where r.id = user_steps.recipe_id
      and ((select auth.uid())::text = substring(r.vendor_id, 5))
  ));

drop policy if exists "Allow user insert own recipe steps" on public.user_steps;
create policy "Allow user insert own recipe steps" on public.user_steps
  for insert to authenticated
  with check (exists (
    select 1 from user_recipes r
    where r.id = user_steps.recipe_id
      and ((select auth.uid())::text = substring(r.vendor_id, 5))
  ));

drop policy if exists "user_steps_select_policy" on public.user_steps;
create policy "user_steps_select_policy" on public.user_steps
  for select to authenticated
  using (exists (
    select 1 from user_recipes r
    where r.id = user_steps.recipe_id
      and can_access_user_recipe((select auth.uid())::text, user_steps.recipe_id)
  ));

-- public.yearly_user_liters
drop policy if exists "yearly_user_liters_select_own" on public.yearly_user_liters;
create policy "yearly_user_liters_select_own" on public.yearly_user_liters
  for select
  using ((select auth.uid()) = user_id);

-- public.yearly_wish_deliveries
drop policy if exists "yearly_wish_deliveries_select_own" on public.yearly_wish_deliveries;
create policy "yearly_wish_deliveries_select_own" on public.yearly_wish_deliveries
  for select
  using ((select auth.uid()) = recipient_user_id);

-- public.yearly_wishes
drop policy if exists "yearly_wishes_insert_own" on public.yearly_wishes;
create policy "yearly_wishes_insert_own" on public.yearly_wishes
  for insert
  with check ((select auth.uid()) = author_user_id);

drop policy if exists "yearly_wishes_select_own" on public.yearly_wishes;
create policy "yearly_wishes_select_own" on public.yearly_wishes
  for select
  using ((select auth.uid()) = author_user_id);

-- service.cleanup_logs
drop policy if exists "Service role insert cleanup logs" on service.cleanup_logs;
create policy "Service role insert cleanup logs" on service.cleanup_logs
  for insert
  with check ((select auth.role()) = 'service_role');

drop policy if exists "Service role manage cleanup logs" on service.cleanup_logs;
create policy "Service role manage cleanup logs" on service.cleanup_logs
  for all
  using ((select auth.role()) = 'service_role');

-- service.notification_delivery_logs
drop policy if exists "User view own delivery logs" on service.notification_delivery_logs;
create policy "User view own delivery logs" on service.notification_delivery_logs
  for select
  using ((select auth.uid()) = user_id);

-- service.notifications
drop policy if exists "Service role delete notifications" on service.notifications;
create policy "Service role delete notifications" on service.notifications
  for delete
  using ((select auth.role()) = 'service_role');

drop policy if exists "Service role insert notifications" on service.notifications;
create policy "Service role insert notifications" on service.notifications
  for insert
  with check ((select auth.role()) = 'service_role');

drop policy if exists "Service role update notifications" on service.notifications;
create policy "Service role update notifications" on service.notifications
  for update
  using ((select auth.role()) = 'service_role');

drop policy if exists "Users view own notifications" on service.notifications;
create policy "Users view own notifications" on service.notifications
  for select
  using ((select auth.uid()) = user_id);

-- service.user_fcm_tokens
drop policy if exists "Users can view own tokens" on service.user_fcm_tokens;
create policy "Users can view own tokens" on service.user_fcm_tokens
  for select
  using ((select auth.uid()) = user_id);

-- service.year_story_clicks
drop policy if exists "year_story_clicks_insert_authenticated" on service.year_story_clicks;
create policy "year_story_clicks_insert_authenticated" on service.year_story_clicks
  for insert
  with check ((select auth.role()) = 'authenticated');
