import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { resolveRecipeDraftLabAccess } from "../_shared/recipe-draft-lab-access.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { createParseUserRecipeDraftHandler } from "./handler.ts";
import { createRecipeDraftParser } from "./parser.ts";

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

if (
  !groqApiKey && !cerebrasApiKey && !openAiApiKey &&
  !geminiServiceAccountKeyJson
) {
  throw new Error(
    "At least one AI provider must be configured for parse-user-recipe-draft.",
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
    const { data } = await supabase
      .from("parse_user_recipe_draft_invocations")
      .select("openai_tokens_used")
      .gte("invoked_at", today);
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
  getCorsHeaders,
  createResponse(body, init) {
    return createSecureResponse(body, init);
  },
});

serve(handler);
