// parser.ts in this directory is also imported by
// supabase/functions/verify-user-recipe-draft. Supabase bundles each
// function separately at deploy time, so the two silently desynchronise if
// only one is redeployed — deploy them as a pair. See plans/010 for the
// incident this caused and plans/README.md's Notes for the standing rule.
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { resolveRecipeDraftLabAccess } from "../_shared/recipe-draft-lab-access.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { createParseUserRecipeDraftHandler } from "./handler.ts";
import { createRecipeDraftParser } from "./parser.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const openAiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL") ?? "";
const geminiServiceAccountKeyJson =
  Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS_JSON") ?? "";
const geminiProjectId = Deno.env.get("GEMINI_PROJECT_ID") ?? "";
const geminiRegion = Deno.env.get("GEMINI_REGION") ?? "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

// Phase E: this function's default provider list (see parser.ts
// buildProviders) no longer falls back to Groq or Cerebras — it is
// openai@MEDIUM, openai@BIG, then Gemini as a provider-outage fallback
// only. GROQ_API_KEY/CEREBRAS_API_KEY env reads were removed from this
// file because they are now dead here: createRecipeDraftParser's default
// path never reads config.groqApiKey/config.cerebrasApiKey, so a
// deployment configured with only a Groq key would previously have passed
// this guard and then died inside createRecipeDraftParser with "No AI
// providers configured". The guard below requires what is actually usable
// instead: an OpenAI key, or a complete Gemini configuration.
const hasCompleteGeminiConfig = Boolean(
  geminiServiceAccountKeyJson && geminiProjectId && geminiRegion,
);

if (!openAiApiKey && !hasCompleteGeminiConfig) {
  throw new Error(
    "parse-user-recipe-draft requires OPENAI_API_KEY_NON_PERSONAL, or a complete Gemini configuration (GOOGLE_APPLICATION_CREDENTIALS_JSON, GEMINI_PROJECT_ID, and GEMINI_REGION). Groq/Cerebras keys alone are no longer sufficient — this function's default provider list no longer falls back to them.",
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const parser = createRecipeDraftParser({
  openAiApiKey,
  geminiServiceAccountKeyJson,
  geminiProjectId,
  geminiRegion,
});

const handler = createParseUserRecipeDraftHandler({
  parser,
  async getUserFromToken(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return null;
    }

    return {
      id: data.user.id,
    };
  },
  async getRecipeDraftLabAccess(userId) {
    return resolveRecipeDraftLabAccess({
      supabase,
      userId,
    });
  },
  async getBrewingMethods() {
    const { data, error } = await supabase
      .from("brewing_methods")
      .select("brewing_method_id, brewing_method")
      .order("brewing_method_id", {
        ascending: true,
      });

    if (error) {
      throw new Error(`Failed to load brewing methods: ${error.message}`);
    }

    return data;
  },
  async getOpenAiDailyTokensUsed() {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("parse_user_recipe_draft_invocations")
      .select("openai_tokens_used")
      .gte("invoked_at", today);
    if (error) {
      throw new Error("Failed to load OpenAI daily usage: " + error.message);
    }
    return (data ?? []).reduce(
      (sum: number, row: { openai_tokens_used: number }) =>
        sum + (row.openai_tokens_used ?? 0),
      0,
    );
  },
  async logInvocation(
    { userId, tokensUsed, openaiTokensUsed, providerUsed, providerModelUsed },
  ) {
    await supabase.from("parse_user_recipe_draft_invocations").insert({
      user_id: userId,
      tokens_used: tokensUsed,
      openai_tokens_used: openaiTokensUsed,
      provider_used: providerUsed,
      provider_model_used: providerModelUsed,
    });
  },
  async captureStages(
    {
      userId,
      requestText,
      requestMode,
      requestBrewingMethodId,
      requestSourceLanguageHint,
      providerUsed,
      providerModelUsed,
      providerTrail,
      stageOutputs,
      response,
    },
  ) {
    const { data, error } = await supabase
      .schema("service")
      .from("parse_user_recipe_draft_captures")
      .insert({
        user_id: userId,
        request_text: requestText,
        request_mode: requestMode,
        request_brewing_method_id: requestBrewingMethodId,
        request_source_language_hint: requestSourceLanguageHint,
        provider_used: providerUsed,
        provider_model_used: providerModelUsed,
        provider_trail: providerTrail,
        stage_outputs: stageOutputs,
        response,
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(`Failed to capture parse stage output: ${error.message}`);
    }

    return data.id as string;
  },
  getCorsHeaders,
  createResponse(body, init) {
    return createSecureResponse(body, init);
  },
});

serve(handler);
