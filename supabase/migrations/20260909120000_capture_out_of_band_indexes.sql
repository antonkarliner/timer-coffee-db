-- Capture eight indexes that exist on the remote project but were created
-- out-of-band (dashboard / ad-hoc SQL) and appear in no migration. `supabase
-- db diff --linked` reported all eight as missing from the migration-derived
-- schema on 2026-09-09.
--
-- Most are Supabase performance-advisor recommendations for unindexed foreign
-- keys (recipes.brewing_method_id, user_recipes.brewing_method_id,
-- user_steps.recipe_id, global_stats.user_id).
--
-- Every statement uses IF NOT EXISTS, so applying this to the remote project --
-- where all eight already exist -- is a no-op; it only brings a freshly
-- replayed database in line.

create index if not exists brewing_methods_brewing_method_idx
    on public.brewing_methods using btree (brewing_method);

create index if not exists coffee_roasters_state_idx
    on public.coffee_roasters using btree (state);

create index if not exists global_stats_user_id_idx
    on public.global_stats using btree (user_id);

create index if not exists recipes_brew_time_idx
    on public.recipes using btree (brew_time);

create index if not exists recipes_brewing_method_id_idx
    on public.recipes using btree (brewing_method_id);

create index if not exists roaster_profiles_dominant_color_hex_idx
    on public.roaster_profiles using btree (dominant_color_hex);

create index if not exists user_recipes_brewing_method_id_idx
    on public.user_recipes using btree (brewing_method_id);

create index if not exists user_steps_recipe_id_idx
    on public.user_steps using btree (recipe_id);
