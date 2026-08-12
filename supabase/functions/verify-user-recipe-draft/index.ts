// This function shares supabase/functions/parse-user-recipe-draft/parser.ts
// with parse-user-recipe-draft. Supabase bundles each function separately
// at deploy time, so the two silently desynchronise if only one is
// redeployed — deploy them as a pair. See plans/010 for the incident this
// caused and plans/README.md's Notes for the standing rule.
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { createRecipeDraftParser } from "../parse-user-recipe-draft/parser.ts";
import { createVerifyUserRecipeDraftHandler } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const groqApiKey = Deno.env.get("GROQ_API_KEY") ?? "";
const cerebrasApiKey = Deno.env.get("CEREBRAS_API_KEY") ?? "";
const openAiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL") ?? "";
const geminiServiceAccountKeyJson =
  Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS_JSON") ?? "";
const geminiProjectId = Deno.env.get("GEMINI_PROJECT_ID") ?? "";
const geminiRegion = Deno.env.get("GEMINI_REGION") ?? "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

// Phase E consolidated the shared parser's default provider cascade to
// OpenAI (medium, then big) with Gemini as an outage fallback; Groq and
// Cerebras are no longer built. A Groq- or Cerebras-only deployment would
// therefore pass a looser guard here and then fail inside
// createRecipeDraftParser with "No AI providers configured", so this guard
// must check for what the parser can actually use.
const hasCompleteGeminiConfig = Boolean(
  geminiServiceAccountKeyJson && geminiProjectId && geminiRegion,
);

if (!openAiApiKey && !hasCompleteGeminiConfig) {
  throw new Error(
    "verify-user-recipe-draft requires OPENAI_API_KEY_NON_PERSONAL, or a complete Gemini configuration (GOOGLE_APPLICATION_CREDENTIALS_JSON, GEMINI_PROJECT_ID and GEMINI_REGION).",
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const parser = createRecipeDraftParser({
  groqApiKey,
  cerebrasApiKey,
  openAiApiKey,
  geminiServiceAccountKeyJson,
  geminiProjectId,
  geminiRegion,
});

const handler = createVerifyUserRecipeDraftHandler({
  parser,
  async getUserFromToken(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return null;
    }

    const user = data.user as typeof data.user & {
      is_anonymous?: boolean;
      app_metadata?: Record<string, unknown>;
    };

    return {
      id: user.id,
      isAnonymous: user.is_anonymous === true ||
        user.app_metadata?.provider === "anonymous",
    };
  },
  async getBrewingMethods() {
    const { data, error } = await supabase
      .from("brewing_methods")
      .select("brewing_method_id, brewing_method")
      .order("brewing_method_id", {
        ascending: true,
      });

    if (error) {
      throw new Error("Failed to load brewing methods: " + error.message);
    }

    return data;
  },
  async getOpenAiDailyTokensUsed() {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .schema("service")
      .from("user_recipe_verification_invocations")
      .select("openai_tokens_used")
      .gte("invoked_at", today);
    return (data ?? []).reduce(
      (sum: number, row: { openai_tokens_used: number }) =>
        sum + (row.openai_tokens_used ?? 0),
      0,
    );
  },
  async getRecentInvocationCount(userId, sinceIso) {
    const { count, error } = await supabase
      .schema("service")
      .from("user_recipe_verification_invocations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("invoked_at", sinceIso);

    if (error) {
      throw new Error(
        "Failed to check recipe verification limit: " + error.message,
      );
    }

    return count ?? 0;
  },
  async logInvocation(
    { userId, tokensUsed, openaiTokensUsed, providerUsed, providerModelUsed },
  ) {
    const { data, error } = await supabase
      .schema("service")
      .from("user_recipe_verification_invocations")
      .insert({
        user_id: userId,
        tokens_used: tokensUsed,
        openai_tokens_used: openaiTokensUsed,
        provider_used: providerUsed,
        provider_model_used: providerModelUsed,
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(
        "Failed to log recipe verification invocation: " + error.message,
      );
    }

    return { id: data?.id ?? null };
  },
  async logDiagnostic(
    { invocationId, userId, request, result, correctedSteps },
  ) {
    const { error } = await supabase
      .schema("service")
      .from("user_recipe_verification_diagnostics")
      .insert({
        invocation_id: invocationId,
        user_id: userId,
        app_locale: request.app_locale,
        source_language_hint: request.source_language_hint ?? null,
        recipe: request.recipe,
        source_steps: request.steps,
        corrected_steps: correctedSteps,
        validation_issues: result.validation.issues,
        warnings: result.warnings,
        provider_used: result.provider_used,
        provider_model_used: result.provider_model_used,
        tokens_used: result.tokens_used,
        openai_tokens_used: result.openai_tokens_used,
      });

    if (error) {
      throw new Error(
        "Failed to log recipe verification diagnostic: " + error.message,
      );
    }
  },
  getCorsHeaders,
  createResponse(body, init) {
    return createSecureResponse(body, init);
  },
});

serve(handler);
