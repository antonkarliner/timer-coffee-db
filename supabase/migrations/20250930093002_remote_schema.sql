-- Enable the unaccent extension for text search functionality
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Create the immutable_unaccent function before any indexes that use it
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT unaccent($1)
$function$
;

alter table "public"."launch_popup" add column "platform" text default 'all'::text;

alter table "public"."user_coffee_beans" add column "package_weight_grams" real;

alter table "public"."user_recipes" add column "needs_moderation_review" boolean default false;

CREATE INDEX cr_city_unaccent_trgm_idx ON public.coffee_roasters USING gin (immutable_unaccent(lower(city)) gin_trgm_ops);

CREATE INDEX cr_country_unaccent_idx ON public.coffee_roasters USING btree (immutable_unaccent(lower(country)));

CREATE INDEX idx_user_recipes_needs_moderation ON public.user_recipes USING btree (needs_moderation_review) WHERE (needs_moderation_review = true);

CREATE INDEX user_recipes_deleted_last_modified_idx ON public.user_recipes USING btree (last_modified) WHERE (is_deleted IS TRUE);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.translate_launch_popup()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  project_url TEXT := (SELECT decrypted_secret FROM supabase_vault.decrypted_secrets WHERE name = 'supabase_url');
  edge_function_url TEXT;
  locales TEXT[];
BEGIN
  IF project_url IS NULL THEN
    RAISE EXCEPTION 'Vault secret ''supabase_url'' is not set';
  END IF;
  edge_function_url := project_url || '/functions/v1/translate-openai';

  -- Skip if this row is already a translated insert
  IF NEW.is_translated THEN
    RETURN NEW;
  END IF;

  -- Gather target locales (exclude source 'en')
  SELECT array_agg(locale) INTO locales
  FROM supported_locales
  WHERE locale <> 'en';

  -- Call Edge function with text, locales, and ORIGINAL platform
  PERFORM net.http_post(
    edge_function_url,
    jsonb_build_object(
      'text', NEW.content,
      'locales', locales,
      'platform', NEW.platform  -- <- added
    ),
    '{}'::jsonb,
    jsonb_build_object('Content-Type','application/json'),
    300000
  );

  -- Mark this source row as processed (note: AFTER trigger; return value won't update row)
  NEW.is_translated := true;
  RETURN NEW;
END;
$function$
;


create sequence "service"."new_roaster_candidates_id_seq";

create table "service"."new_roaster_candidates" (
    "id" bigint not null default nextval('service.new_roaster_candidates_id_seq'::regclass),
    "roaster" text not null,
    "coffee_bean_name" text not null,
    "similar_candidates" jsonb not null,
    "inserted_at" timestamp with time zone not null default now(),
    "processed" boolean not null default false,
    "notes" text,
    "google_search_results" jsonb,
    "bean_search_results" jsonb,
    "location" jsonb
);


alter table "service"."new_roaster_candidates" enable row level security;

alter sequence "service"."new_roaster_candidates_id_seq" owned by "service"."new_roaster_candidates"."id";

CREATE INDEX new_roaster_candidates_location_roaster_coffee_bean_name_si_idx ON service.new_roaster_candidates USING btree (location, roaster, coffee_bean_name, similar_candidates);

CREATE UNIQUE INDEX new_roaster_candidates_pkey ON service.new_roaster_candidates USING btree (id);

CREATE INDEX new_roaster_candidates_roaster_unprocessed_idx ON service.new_roaster_candidates USING btree (roaster) WHERE (processed = false);

alter table "service"."new_roaster_candidates" add constraint "new_roaster_candidates_pkey" PRIMARY KEY using index "new_roaster_candidates_pkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION service.delete_old_deleted_user_recipes()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  delete from public.user_recipes
  where is_deleted is true
    and last_modified is not null
    and last_modified < (now() at time zone 'utc' - interval '30 days');
end;
$function$
;

CREATE OR REPLACE FUNCTION service.notify_roaster_candidates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service', 'public'
AS $function$
begin
  -- pg_net queues the request; it starts after COMMIT
  perform net.http_get(
    url := 'https://timer.coffee/api/admin/roaster-candidates'
  );

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION service.sync_roaster_processed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service', 'public'
AS $function$
begin
  -- Only act when processed actually changed to TRUE
  if tg_op = 'UPDATE'
     and new.processed is true
     and (old.processed is distinct from new.processed) then

    update service.new_roaster_candidates
       set processed = true
     where roaster = new.roaster
       and processed is false;  -- only flip those still false
  end if;

  return new;
end;
$function$
;

grant delete on table "service"."new_roaster_candidates" to "anon";

grant insert on table "service"."new_roaster_candidates" to "anon";

grant references on table "service"."new_roaster_candidates" to "anon";

grant select on table "service"."new_roaster_candidates" to "anon";

grant trigger on table "service"."new_roaster_candidates" to "anon";

grant truncate on table "service"."new_roaster_candidates" to "anon";

grant update on table "service"."new_roaster_candidates" to "anon";

grant delete on table "service"."new_roaster_candidates" to "authenticated";

grant insert on table "service"."new_roaster_candidates" to "authenticated";

grant references on table "service"."new_roaster_candidates" to "authenticated";

grant select on table "service"."new_roaster_candidates" to "authenticated";

grant trigger on table "service"."new_roaster_candidates" to "authenticated";

grant truncate on table "service"."new_roaster_candidates" to "authenticated";

grant update on table "service"."new_roaster_candidates" to "authenticated";

grant delete on table "service"."new_roaster_candidates" to "service_role";

grant insert on table "service"."new_roaster_candidates" to "service_role";

grant references on table "service"."new_roaster_candidates" to "service_role";

grant select on table "service"."new_roaster_candidates" to "service_role";

grant trigger on table "service"."new_roaster_candidates" to "service_role";

grant truncate on table "service"."new_roaster_candidates" to "service_role";

grant update on table "service"."new_roaster_candidates" to "service_role";

create policy "Allow insert for all"
on "service"."new_roaster_candidates"
as permissive
for insert
to public
with check (true);


create policy "Allow updates for authenticated users"
on "service"."new_roaster_candidates"
as permissive
for update
to authenticated
using (true)
with check (true);


create policy "Enable read access for authenticated users"
on "service"."new_roaster_candidates"
as permissive
for select
to authenticated
using (true);


CREATE TRIGGER notify_roaster_candidates_trigger AFTER INSERT ON service.new_roaster_candidates FOR EACH ROW EXECUTE FUNCTION service.notify_roaster_candidates();

CREATE TRIGGER sync_roaster_processed_trigger AFTER UPDATE OF processed ON service.new_roaster_candidates FOR EACH ROW WHEN (((old.processed IS DISTINCT FROM new.processed) AND (new.processed IS TRUE))) EXECUTE FUNCTION service.sync_roaster_processed();


