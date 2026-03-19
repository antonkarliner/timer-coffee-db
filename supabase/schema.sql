SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE SCHEMA IF NOT EXISTS "schema_name";

ALTER SCHEMA "schema_name" OWNER TO "postgres";

CREATE EXTENSION IF NOT EXISTS "http" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "hypopg" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "index_advisor" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "public"."aggregate_coffee_volume"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$DECLARE
    last_hour_volume NUMERIC;
    last_day_volume NUMERIC;
    last_week_volume NUMERIC;
    last_month_volume NUMERIC;
BEGIN
    -- Calculate the volume for the last hour and divide by 1000
    SELECT SUM(water_amount) / 1000 INTO last_hour_volume
    FROM global_stats
    WHERE created_at >= NOW() - INTERVAL '1 hour';

    -- Calculate the volume for the last day and divide by 1000
    SELECT SUM(water_amount) / 1000 INTO last_day_volume
    FROM global_stats
    WHERE created_at >= NOW() - INTERVAL '1 day';

    -- Calculate the volume for the last week and divide by 1000
    SELECT SUM(water_amount) / 1000 INTO last_week_volume
    FROM global_stats
    WHERE created_at >= NOW() - INTERVAL '1 week';

    -- Calculate the volume for the last month and divide by 1000
    SELECT SUM(water_amount) / 1000 INTO last_month_volume
    FROM global_stats
    WHERE created_at >= NOW() - INTERVAL '1 month';

    -- Insert or update the volume for the last hour
    INSERT INTO aggregated_coffee_volume (period, volume)
    VALUES ('last_hour', last_hour_volume)
    ON CONFLICT (period) DO UPDATE
    SET volume = EXCLUDED.volume;

    -- Insert or update the volume for the last day
    INSERT INTO aggregated_coffee_volume (period, volume)
    VALUES ('last_day', last_day_volume)
    ON CONFLICT (period) DO UPDATE
    SET volume = EXCLUDED.volume;

    -- Insert or update the volume for the last week
    INSERT INTO aggregated_coffee_volume (period, volume)
    VALUES ('last_week', last_week_volume)
    ON CONFLICT (period) DO UPDATE
    SET volume = EXCLUDED.volume;

    -- Insert or update the volume for the last month
    INSERT INTO aggregated_coffee_volume (period, volume)
    VALUES ('last_month', last_month_volume)
    ON CONFLICT (period) DO UPDATE
    SET volume = EXCLUDED.volume;
    RETURN NULL;
END;$$;

ALTER FUNCTION "public"."aggregate_coffee_volume"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."schedule_translation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    PERFORM net.http_post(
        url:='https://api.openai.com/v1/chat/completions',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'OPENAI_API_KEY') || '"}'::jsonb,
        body:=jsonb_build_object(
            'model', 'gpt-4-turbo',
            'messages', jsonb_build_array(
                jsonb_build_object(
                    'role', 'system',
                    'content', 'Translate this text into ' || new.locale || ' focusing on accuracy and context.'
                ),
                jsonb_build_object(
                    'role', 'user',
                    'content', new.content
                )
            )
        )
    );
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."schedule_translation"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_recipe_last_modified"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$BEGIN
    -- Assuming that both tables have a 'recipe_id' column which references the 'recipes' table.
    UPDATE recipes
    SET last_modified = CURRENT_TIMESTAMP
    WHERE id = NEW.recipe_id;
    RETURN NEW;
END;$$;

ALTER FUNCTION "public"."update_recipe_last_modified"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."aggregated_coffee_volume" (
    "id" bigint NOT NULL,
    "period" character varying,
    "volume" double precision
);

ALTER TABLE "public"."aggregated_coffee_volume" OWNER TO "postgres";

ALTER TABLE "public"."aggregated_coffee_volume" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."aggregated_coffee_volume_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."brewing_methods" (
    "brewing_method_id" character varying NOT NULL,
    "brewing_method" character varying NOT NULL,
    "show_on_main" boolean NOT NULL
);

ALTER TABLE "public"."brewing_methods" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."coffee_facts" (
    "id" character varying NOT NULL,
    "fact" character varying,
    "locale" character varying NOT NULL
);

ALTER TABLE "public"."coffee_facts" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."contributors" (
    "id" character varying NOT NULL,
    "content" character varying,
    "locale" character varying NOT NULL
);

ALTER TABLE "public"."contributors" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."global_stats" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "brewing_method" character varying,
    "recipe_id" character varying,
    "water_amount" double precision,
    "created_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE "public"."global_stats" OWNER TO "postgres";

ALTER TABLE "public"."global_stats" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."global_stats_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."launch_popup" (
    "id" bigint NOT NULL,
    "content" character varying,
    "locale" character varying,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_translated" boolean DEFAULT false
);

ALTER TABLE "public"."launch_popup" OWNER TO "postgres";

ALTER TABLE "public"."launch_popup" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."launch_popup_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."recipe_localization" (
    "id" character varying(255) NOT NULL,
    "recipe_id" character varying(255) NOT NULL,
    "locale" character varying(255) NOT NULL,
    "name" character varying(255) NOT NULL,
    "grind_size" character varying(255) NOT NULL,
    "short_description" "text" NOT NULL
);

ALTER TABLE "public"."recipe_localization" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."recipes" (
    "id" character varying(255) NOT NULL,
    "brewing_method_id" character varying(255) NOT NULL,
    "coffee_amount" double precision NOT NULL,
    "water_amount" double precision NOT NULL,
    "water_temp" double precision,
    "vendor_id" character varying(255) DEFAULT NULL::character varying NOT NULL,
    "last_modified" timestamp with time zone,
    "brew_time" bigint
);

ALTER TABLE "public"."recipes" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."start_popup" (
    "id" character varying NOT NULL,
    "content" character varying NOT NULL,
    "app_version" character varying NOT NULL,
    "locale" character varying NOT NULL
);

ALTER TABLE "public"."start_popup" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."steps" (
    "id" character varying(255) NOT NULL,
    "recipe_id" character varying(255) NOT NULL,
    "step_order" integer NOT NULL,
    "description" "text" NOT NULL,
    "time" character varying NOT NULL,
    "locale" character varying NOT NULL
);

ALTER TABLE "public"."steps" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."supported_locales" (
    "locale" character varying NOT NULL,
    "locale_name" character varying NOT NULL
);

ALTER TABLE "public"."supported_locales" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."vendors" (
    "vendor_id" character varying NOT NULL,
    "vendor_name" character varying NOT NULL,
    "active" boolean NOT NULL,
    "vendor_description" character varying,
    "banner_url" character varying
);

ALTER TABLE "public"."vendors" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "schema_name"."table_name" (
    "id" bigint NOT NULL
);

ALTER TABLE "schema_name"."table_name" OWNER TO "postgres";

ALTER TABLE "schema_name"."table_name" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "schema_name"."table_name_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY "public"."aggregated_coffee_volume"
    ADD CONSTRAINT "aggregated_coffee_volume_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."brewing_methods"
    ADD CONSTRAINT "brewing_methods_brewing_method_id_key" UNIQUE ("brewing_method_id");

ALTER TABLE ONLY "public"."brewing_methods"
    ADD CONSTRAINT "brewing_methods_pkey" PRIMARY KEY ("brewing_method_id");

ALTER TABLE ONLY "public"."coffee_facts"
    ADD CONSTRAINT "coffee_facts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."contributors"
    ADD CONSTRAINT "contributors_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."global_stats"
    ADD CONSTRAINT "global_stats_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."launch_popup"
    ADD CONSTRAINT "launch_popup_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."recipe_localization"
    ADD CONSTRAINT "recipe_localization_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."start_popup"
    ADD CONSTRAINT "startpopup_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."steps"
    ADD CONSTRAINT "steps_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."supported_locales"
    ADD CONSTRAINT "supported_locales_locale_key" UNIQUE ("locale");

ALTER TABLE ONLY "public"."supported_locales"
    ADD CONSTRAINT "supported_locales_pkey" PRIMARY KEY ("locale");

ALTER TABLE ONLY "public"."aggregated_coffee_volume"
    ADD CONSTRAINT "unique_period" UNIQUE ("period");

ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("vendor_id");

ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_vendor_id_key" UNIQUE ("vendor_id");

ALTER TABLE ONLY "schema_name"."table_name"
    ADD CONSTRAINT "table_name_pkey" PRIMARY KEY ("id");

CREATE INDEX "aggregated_coffee_volume_period_idx" ON "public"."aggregated_coffee_volume" USING "btree" ("period");

CREATE INDEX "global_stats_brewing_method_water_amount_created_at_recipe__idx" ON "public"."global_stats" USING "btree" ("brewing_method", "water_amount", "created_at", "recipe_id");

CREATE INDEX "idx_recipes_last_modified" ON "public"."recipes" USING "btree" ("last_modified");

CREATE OR REPLACE TRIGGER "aggregate_coffee_volume_update" AFTER INSERT ON "public"."global_stats" FOR EACH STATEMENT EXECUTE FUNCTION "public"."aggregate_coffee_volume"();

CREATE OR REPLACE TRIGGER "recipe_localization_after_update" AFTER INSERT OR UPDATE ON "public"."recipe_localization" FOR EACH ROW EXECUTE FUNCTION "public"."update_recipe_last_modified"();

CREATE OR REPLACE TRIGGER "steps_after_update" AFTER INSERT OR UPDATE ON "public"."steps" FOR EACH ROW EXECUTE FUNCTION "public"."update_recipe_last_modified"();

CREATE OR REPLACE TRIGGER "translate_launch_popup_after_update" AFTER INSERT ON "public"."launch_popup" FOR EACH ROW WHEN (NEW.is_translated = false) EXECUTE FUNCTION "public"."schedule_translation"();

ALTER TABLE ONLY "public"."coffee_facts"
    ADD CONSTRAINT "public_coffee_facts_locale_fkey" FOREIGN KEY ("locale") REFERENCES "public"."supported_locales"("locale") ON UPDATE CASCADE;

ALTER TABLE ONLY "public"."contributors"
    ADD CONSTRAINT "public_contributors_locale_fkey" FOREIGN KEY ("locale") REFERENCES "public"."supported_locales"("locale") ON UPDATE CASCADE;

ALTER TABLE ONLY "public"."global_stats"
    ADD CONSTRAINT "public_global_stats_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id");

ALTER TABLE ONLY "public"."global_stats"
    ADD CONSTRAINT "public_global_stats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");

ALTER TABLE ONLY "public"."launch_popup"
    ADD CONSTRAINT "public_launch_popup_locale_fkey" FOREIGN KEY ("locale") REFERENCES "public"."supported_locales"("locale") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."recipe_localization"
    ADD CONSTRAINT "public_recipe_localization_locale_fkey" FOREIGN KEY ("locale") REFERENCES "public"."supported_locales"("locale") ON UPDATE CASCADE;

ALTER TABLE ONLY "public"."recipe_localization"
    ADD CONSTRAINT "public_recipe_localization_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "public_recipes_brewing_method_id_fkey" FOREIGN KEY ("brewing_method_id") REFERENCES "public"."brewing_methods"("brewing_method_id") ON UPDATE CASCADE;

ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "public_recipes_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("vendor_id") ON UPDATE CASCADE;

ALTER TABLE ONLY "public"."start_popup"
    ADD CONSTRAINT "public_startpopup_locale_fkey" FOREIGN KEY ("locale") REFERENCES "public"."supported_locales"("locale") ON UPDATE CASCADE;

ALTER TABLE ONLY "public"."steps"
    ADD CONSTRAINT "public_steps_locale_fkey" FOREIGN KEY ("locale") REFERENCES "public"."supported_locales"("locale") ON UPDATE CASCADE;

ALTER TABLE ONLY "public"."steps"
    ADD CONSTRAINT "public_steps_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;

CREATE POLICY "Enable insert for authenticated users only" ON "public"."global_stats" FOR INSERT TO "authenticated" WITH CHECK (true);

CREATE POLICY "Enable read access for all users" ON "public"."aggregated_coffee_volume" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."brewing_methods" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."coffee_facts" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."contributors" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."launch_popup" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."recipe_localization" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."recipes" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."start_popup" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."steps" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."supported_locales" FOR SELECT USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."vendors" FOR SELECT USING (true);

ALTER TABLE "public"."aggregated_coffee_volume" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."brewing_methods" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."coffee_facts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."contributors" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."global_stats" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."launch_popup" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."recipe_localization" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."recipes" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."start_popup" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."steps" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."supported_locales" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for all users" ON "schema_name"."table_name" FOR SELECT USING (true);

ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

GRANT ALL ON FUNCTION "public"."aggregate_coffee_volume"() TO "anon";
GRANT ALL ON FUNCTION "public"."aggregate_coffee_volume"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."aggregate_coffee_volume"() TO "service_role";

GRANT ALL ON FUNCTION "public"."schedule_translation"() TO "anon";
GRANT ALL ON FUNCTION "public"."schedule_translation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."schedule_translation"() TO "service_role";

GRANT ALL ON FUNCTION "public"."update_recipe_last_modified"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_recipe_last_modified"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_recipe_last_modified"() TO "service_role";

GRANT ALL ON TABLE "public"."aggregated_coffee_volume" TO "anon";
GRANT ALL ON TABLE "public"."aggregated_coffee_volume" TO "authenticated";
GRANT ALL ON TABLE "public"."aggregated_coffee_volume" TO "service_role";

GRANT ALL ON SEQUENCE "public"."aggregated_coffee_volume_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."aggregated_coffee_volume_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."aggregated_coffee_volume_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."brewing_methods" TO "anon";
GRANT ALL ON TABLE "public"."brewing_methods" TO "authenticated";
GRANT ALL ON TABLE "public"."brewing_methods" TO "service_role";

GRANT ALL ON TABLE "public"."coffee_facts" TO "anon";
GRANT ALL ON TABLE "public"."coffee_facts" TO "authenticated";
GRANT ALL ON TABLE "public"."coffee_facts" TO "service_role";

GRANT ALL ON TABLE "public"."contributors" TO "anon";
GRANT ALL ON TABLE "public"."contributors" TO "authenticated";
GRANT ALL ON TABLE "public"."contributors" TO "service_role";

GRANT ALL ON TABLE "public"."global_stats" TO "anon";
GRANT ALL ON TABLE "public"."global_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."global_stats" TO "service_role";

GRANT ALL ON SEQUENCE "public"."global_stats_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."global_stats_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."global_stats_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."launch_popup" TO "anon";
GRANT ALL ON TABLE "public"."launch_popup" TO "authenticated";
GRANT ALL ON TABLE "public"."launch_popup" TO "service_role";

GRANT ALL ON SEQUENCE "public"."launch_popup_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."launch_popup_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."launch_popup_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."recipe_localization" TO "anon";
GRANT ALL ON TABLE "public"."recipe_localization" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_localization" TO "service_role";

GRANT ALL ON TABLE "public"."recipes" TO "anon";
GRANT ALL ON TABLE "public"."recipes" TO "authenticated";
GRANT ALL ON TABLE "public"."recipes" TO "service_role";

GRANT ALL ON TABLE "public"."start_popup" TO "anon";
GRANT ALL ON TABLE "public"."start_popup" TO "authenticated";
GRANT ALL ON TABLE "public"."start_popup" TO "service_role";

GRANT ALL ON TABLE "public"."steps" TO "anon";
GRANT ALL ON TABLE "public"."steps" TO "authenticated";
GRANT ALL ON TABLE "public"."steps" TO "service_role";

GRANT ALL ON TABLE "public"."supported_locales" TO "anon";
GRANT ALL ON TABLE "public"."supported_locales" TO "authenticated";
GRANT ALL ON TABLE "public"."supported_locales" TO "service_role";

GRANT ALL ON TABLE "public"."vendors" TO "anon";
GRANT ALL ON TABLE "public"."vendors" TO "authenticated";
GRANT ALL ON TABLE "public"."vendors" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";

-- Giftbox Offers Table
CREATE TABLE IF NOT EXISTS "public"."giftbox_offers" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "partner_name" text NOT NULL,
    "website_url" text,
    "image_url" text,
    "festive_color" text,
    "promo_code" text,
    "discount_text" text,
    "discount_min_percent" numeric,
    "discount_max_percent" numeric,
    "regions" text[] DEFAULT '{"WW"}',
    "localizations" jsonb NOT NULL DEFAULT '{}',
    "valid_from" timestamp with time zone,
    "valid_to" timestamp with time zone,
    "priority" integer DEFAULT 0,
    "is_active" boolean NOT NULL DEFAULT true,
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "public"."giftbox_offers" OWNER TO "postgres";

ALTER TABLE ONLY "public"."giftbox_offers"
    ADD CONSTRAINT "giftbox_offers_pkey" PRIMARY KEY ("id");

CREATE INDEX "giftbox_active_idx" ON "public"."giftbox_offers" USING "btree" ("is_active", "priority", "valid_to");
CREATE INDEX "giftbox_regions_gin" ON "public"."giftbox_offers" USING "gin" ("regions");

-- Add RLS policies
ALTER TABLE "public"."giftbox_offers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "giftbox_read_active" ON "public"."giftbox_offers"
    FOR SELECT
    USING (
        is_active
        AND (valid_from IS NULL OR valid_from <= now())
        AND (valid_to IS NULL OR valid_to >= now())
    );

CREATE POLICY "giftbox_write_service" ON "public"."giftbox_offers"
    FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- Add grants
GRANT ALL ON TABLE "public"."giftbox_offers" TO "anon";
GRANT ALL ON TABLE "public"."giftbox_offers" TO "authenticated";
GRANT ALL ON TABLE "public"."giftbox_offers" TO "service_role";

RESET ALL;
