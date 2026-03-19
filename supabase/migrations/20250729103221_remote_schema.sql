alter table "public"."coffee_roasters" add column "city" text;

alter table "public"."coffee_roasters" add column "country" text;

alter table "public"."coffee_roasters" add column "state" text;

alter table "public"."global_coffee_beans" add column "farm" character varying;

alter table "public"."global_coffee_beans" add column "farmer" character varying;

alter table "public"."user_coffee_beans" add column "farm" character varying;

alter table "public"."user_coffee_beans" add column "farmer" character varying;

CREATE INDEX recipe_localization_recipe_id_idx ON public.recipe_localization USING btree (recipe_id);

CREATE INDEX steps_recipe_id_idx ON public.steps USING btree (recipe_id);

CREATE INDEX user_stats_user_id_idx ON public.user_stats USING btree (user_id);


