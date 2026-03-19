set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.enqueue_popup(_content text, _locale text, _run_at timestamp with time zone)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    msg_id bigint;
    delay_seconds integer;
BEGIN
    delay_seconds := EXTRACT(EPOCH FROM (_run_at - now()));
    IF delay_seconds < 0 THEN
        delay_seconds := 0;
    END IF;
    SELECT pgmq.send(
        'scheduled_launch_popup',
        jsonb_build_object('content', _content, 'locale', _locale),
        delay_seconds
    ) INTO msg_id;
    RETURN msg_id;
END;
$function$
;

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

  IF NEW.is_translated THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(locale) INTO locales FROM supported_locales WHERE locale <> 'en';

  PERFORM net.http_post(
    edge_function_url,
    jsonb_build_object('text', NEW.content, 'locales', locales),
    '{}'::jsonb,
    jsonb_build_object('Content-Type','application/json'),
    300000
  );

  NEW.is_translated := true;
  RETURN NEW;
END;
$function$
;

grant select on table "public"."aggregated_coffee_volume" to "cline_mcp_readonly_role";

grant select on table "public"."blog_subscribers" to "cline_mcp_readonly_role";

grant select on table "public"."brewing_methods" to "cline_mcp_readonly_role";

grant select on table "public"."coffee_countries" to "cline_mcp_readonly_role";

grant select on table "public"."coffee_descriptors" to "cline_mcp_readonly_role";

grant select on table "public"."coffee_facts" to "cline_mcp_readonly_role";

grant select on table "public"."coffee_processing_methods" to "cline_mcp_readonly_role";

grant select on table "public"."coffee_roasters" to "cline_mcp_readonly_role";

grant select on table "public"."contributors" to "cline_mcp_readonly_role";

grant select on table "public"."global_coffee_beans" to "cline_mcp_readonly_role";

grant select on table "public"."global_stats" to "cline_mcp_readonly_role";

grant select on table "public"."launch_popup" to "cline_mcp_readonly_role";

grant select on table "public"."parse_coffee_label_invocations" to "cline_mcp_readonly_role";

grant select on table "public"."pro_users" to "cline_mcp_readonly_role";

grant select on table "public"."recipe_localization" to "cline_mcp_readonly_role";

grant select on table "public"."recipes" to "cline_mcp_readonly_role";

grant select on table "public"."start_popup" to "cline_mcp_readonly_role";

grant select on table "public"."steps" to "cline_mcp_readonly_role";

grant select on table "public"."supported_locales" to "cline_mcp_readonly_role";

grant select on table "public"."user_coffee_beans" to "cline_mcp_readonly_role";

grant select on table "public"."user_public_profiles" to "cline_mcp_readonly_role";

grant select on table "public"."user_recipe_localizations" to "cline_mcp_readonly_role";

grant select on table "public"."user_recipe_preferences" to "cline_mcp_readonly_role";

grant select on table "public"."user_recipes" to "cline_mcp_readonly_role";

grant select on table "public"."user_stats" to "cline_mcp_readonly_role";

grant select on table "public"."user_steps" to "cline_mcp_readonly_role";

grant select on table "public"."vendors" to "cline_mcp_readonly_role";

grant select on table "public"."yearly_stats" to "cline_mcp_readonly_role";


