import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { CONNECTED_APP_FORBIDDEN_ERROR, CONNECTED_APP_FORBIDDEN_MESSAGE } from "../_shared/connected-app.ts";
import { createModerationClient } from "../_shared/moderation.ts";
import { jevAsk, prewarmJevConnection } from "../_shared/jev-client.ts";
import { getEnvBoolean, getEnvNumber } from "../_shared/env-validation.ts";
import { resolveVerifiedUser } from "./auth.ts";
const FUNCTION_NAME = "submit_yearly_wish";
const MAX_REQUESTS = 3;
const WINDOW_SECONDS = 60;
const openaiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL");
const groqApiKey = Deno.env.get("GROQ_API_KEY");
const geminiServiceAccountKeyJson = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS_JSON");
const geminiProjectId = Deno.env.get("GEMINI_PROJECT_ID") ?? "";
const geminiRegion = Deno.env.get("GEMINI_REGION") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!openaiApiKey) {
  console.error("OPENAI_API_KEY_NON_PERSONAL is not set in environment variables.");
  Deno.exit(1);
}
if (!groqApiKey && !geminiServiceAccountKeyJson) {
  console.error("No secondary moderation provider is configured. Set GROQ_API_KEY or Gemini credentials.");
  Deno.exit(1);
}
if (!supabaseUrl) {
  console.error("SUPABASE_URL is not set in environment variables.");
  Deno.exit(1);
}
if (!supabaseServiceRoleKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set in environment variables.");
  Deno.exit(1);
}
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false
  }
});
// Jev is the primary text classifier; the Groq/omni chain is its offline
// fallback. See _shared/moderation.ts for the held-out evidence.
const jevEnabled = getEnvBoolean("MODERATION_JEV_ENABLED", true);
const moderator = createModerationClient({
  openaiApiKey: openaiApiKey,
  groqApiKey: groqApiKey,
  geminiServiceAccountKeyJson: geminiServiceAccountKeyJson,
  geminiProjectId: geminiProjectId,
  geminiRegion: geminiRegion,
  jevAsk,
  jevEnabled,
  jevTimeoutMs: getEnvNumber("MODERATION_JEV_TIMEOUT_MS", 800)
});
function jsonResponse(body: unknown, status: number, cors: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
}
serve(async (req)=>{
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors
    });
  }
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Method Not Allowed"
    }, 405, cors);
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse({
      error: "Bad Request",
      message: "Content-Type must be application/json"
    }, 400, cors);
  }
  // Warm the TypeSafe connection while auth and rate limiting run; see the
  // same call in content-moderation. Never awaited, never rejects.
  if (jevEnabled) {
    prewarmJevConnection().catch(()=>null);
  }
  const authResult = await resolveVerifiedUser(
    req.headers.get("Authorization"),
    supabaseAdmin.auth,
  );
  if (!authResult.ok && authResult.reason === "connected_app") {
    return jsonResponse({
      error: CONNECTED_APP_FORBIDDEN_ERROR,
      message: CONNECTED_APP_FORBIDDEN_MESSAGE
    }, 403, cors);
  }
  if (!authResult.ok && authResult.reason === "missing_or_invalid_header") {
    return jsonResponse({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header"
    }, 401, cors);
  }
  if (!authResult.ok) {
    return jsonResponse({
      error: "Unauthorized",
      message: "User ID could not be determined"
    }, 401, cors);
  }
  const userId = authResult.userId;
  try {
    const now = new Date();
    const windowStartTime = new Date(now.getTime() - WINDOW_SECONDS * 1000);
    const { data: limitRecord, error: fetchError } = await supabaseAdmin.schema("service").from("moderation_rate_limits").select("request_count, window_start_time").eq("user_id", userId).eq("function_name", FUNCTION_NAME).maybeSingle();
    if (fetchError) {
      console.error("Error fetching rate limit record:", fetchError);
      throw new Error("Failed to fetch rate limit status.");
    }
    if (limitRecord && new Date(limitRecord.window_start_time) > windowStartTime) {
      if (limitRecord.request_count >= MAX_REQUESTS) {
        console.log(`Rate limit exceeded for user ${userId}. Count: ${limitRecord.request_count}, Limit: ${MAX_REQUESTS}`);
        return jsonResponse({
          error: "Too Many Requests",
          message: "Rate limit exceeded. Please wait a minute before trying again."
        }, 429, cors);
      }
      const { error: updateError } = await supabaseAdmin.schema("service").from("moderation_rate_limits").update({
        request_count: limitRecord.request_count + 1
      }).eq("user_id", userId).eq("function_name", FUNCTION_NAME);
      if (updateError) {
        console.error("Error incrementing rate limit count:", updateError);
        throw new Error("Failed to update rate limit count.");
      }
      console.log(`User ${userId} rate limit count updated to ${limitRecord.request_count + 1}`);
    } else {
      const { error: upsertError } = await supabaseAdmin.schema("service").from("moderation_rate_limits").upsert({
        user_id: userId,
        function_name: FUNCTION_NAME,
        request_count: 1,
        window_start_time: now.toISOString()
      }, {
        onConflict: "user_id, function_name"
      });
      if (upsertError) {
        console.error("Error upserting rate limit record:", upsertError);
        throw new Error("Failed to initialize/reset rate limit record.");
      }
      console.log(`User ${userId} rate limit window reset. Count: 1`);
    }
  } catch (dbError) {
    const message = dbError instanceof Error ? dbError.message : String(dbError);
    console.error("Database error during rate limiting check:", dbError);
    return jsonResponse({
      error: "Internal Server Error",
      message: `Rate limiting check failed: ${message}`
    }, 500, cors);
  }
  let requestPayload;
  try {
    requestPayload = await req.json();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonResponse({
      error: "Bad Request",
      message: `Invalid JSON payload. ${message}`
    }, 400, cors);
  }
  if (typeof requestPayload.text !== "string") {
    return jsonResponse({
      error: "Bad Request",
      message: "Missing or invalid 'text' in request body."
    }, 400, cors);
  }
  const trimmedText = requestPayload.text.trim();
  if (trimmedText.length < 2 || trimmedText.length > 160) {
    return jsonResponse({
      error: "Bad Request",
      message: "Text must be between 2 and 160 characters."
    }, 400, cors);
  }
  let locale = null;
  if (typeof requestPayload.locale === "string") {
    const trimmedLocale = requestPayload.locale.trim();
    if (trimmedLocale.length > 0) {
      locale = trimmedLocale;
    }
  }
  try {
    console.log("Running moderation for yearly wish", {
      userId,
      textLength: trimmedText.length,
      locale
    });
    const moderationResult = await moderator.moderateText(trimmedText, {
      surface: "wish",
      correlationId: `submit-yearly-wish:${userId}`
    });
    const status = moderationResult.safe ? "approved" : "rejected";
    const moderationReason = moderationResult.safe ? null : moderationResult.reason ?? "Rejected by moderation";
    if (!moderationResult.safe) {
      console.warn("Wish rejected by moderation", {
        userId,
        reason: moderationReason
      });
    }
    const { error: insertError } = await supabaseAdmin.from("yearly_wishes").insert({
      author_user_id: userId,
      locale,
      text: trimmedText,
      status,
      moderation_reason: moderationReason
    });
    if (insertError) {
      console.error("Error inserting yearly wish:", insertError);
      return jsonResponse({
        error: "Internal Server Error",
        message: "Failed to store wish."
      }, 500, cors);
    }
    return jsonResponse({
      ok: true,
      status
    }, 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error during wish submission:", error);
    return jsonResponse({
      error: "Internal Server Error",
      message
    }, 500, cors);
  }
});
console.log("submit_yearly_wish function started.");
