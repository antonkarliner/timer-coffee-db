import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { connectedAppForbiddenResponse } from "../_shared/connected-app.ts";
import { OPENAI_SPECIALIZED_MODELS } from "../_shared/ai-models.ts";
import {
  createModerationClient,
  MODERATION_SURFACE_LABEL,
  type ModerationSurface,
} from "../_shared/moderation.ts";
import { jevAsk, prewarmJevConnection } from "../_shared/jev-client.ts";
import { getEnvBoolean, getEnvNumber } from "../_shared/env-validation.ts";
import { resolveVerifiedUser } from "./auth.ts";
// --- Rate Limiting Configuration ---
const FUNCTION_NAME = "content-moderation";
const MAX_REQUESTS = 3;
const WINDOW_SECONDS = 60;
// --- Environment Variables ---
const openaiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL");
const groqApiKey = Deno.env.get("GROQ_API_KEY");
const geminiServiceAccountKeyJson = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS_JSON");
const geminiProjectId = Deno.env.get("GEMINI_PROJECT_ID") ?? "";
const geminiRegion = Deno.env.get("GEMINI_REGION") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!openaiApiKey) {
  console.error("OPENAI_API_KEY_NON_PERSONAL is not set.");
  Deno.exit(1);
}
if (!groqApiKey && !geminiServiceAccountKeyJson) {
  console.error("No secondary moderation provider is configured. Set GROQ_API_KEY or Gemini credentials.");
  Deno.exit(1);
}
if (!supabaseUrl) {
  console.error("SUPABASE_URL is not set.");
  Deno.exit(1);
}
if (!supabaseServiceRoleKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  Deno.exit(1);
}
// Jev is the primary text classifier; the Groq/omni chain is its offline
// fallback. See _shared/moderation.ts for the held-out evidence. Both knobs
// are secrets so a cutover can be reverted without a code change.
const jevEnabled = getEnvBoolean("MODERATION_JEV_ENABLED", true);
const moderator = createModerationClient({
  openaiApiKey,
  groqApiKey,
  geminiServiceAccountKeyJson,
  geminiProjectId,
  geminiRegion,
  jevAsk,
  jevEnabled,
  jevTimeoutMs: getEnvNumber("MODERATION_JEV_TIMEOUT_MS", 800)
});

// Derived from the label map so the accepted values cannot drift from the
// ones the Jev rubric was evaluated against. An unknown or absent value is
// not an error: moderation.ts falls back to a generic `where_it_appears`
// label. The app sends this from lib/config/moderation_surfaces.dart.
const KNOWN_SURFACES = new Set<string>(Object.keys(MODERATION_SURFACE_LABEL));
function parseSurface(value: unknown): ModerationSurface | undefined {
  return typeof value === "string" && KNOWN_SURFACES.has(value)
    ? value as ModerationSurface
    : undefined;
}
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false
  }
});
// --- Image moderation via omni-moderation ---
async function moderateImage(imageBase64: string): Promise<{
  safe: boolean;
  reason?: string;
}> {
  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_SPECIALIZED_MODELS.MODERATION,
      input: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${imageBase64}`
          }
        }
      ]
    })
  });
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`omni-moderation image error ${response.status}: ${errorBody}`);
    throw new Error(`omni-moderation image request failed: ${response.status}`);
  }
  const data = await response.json();
  const result = data.results?.[0];
  if (!result) {
    throw new Error("Unexpected omni-moderation response shape.");
  }
  if (result.flagged) {
    const flaggedCategories = Object.entries(result.categories).filter(([, flagged])=>flagged).map(([cat])=>cat).join(", ");
    return {
      safe: false,
      reason: `Image flagged: ${flaggedCategories}`
    };
  }
  return {
    safe: true
  };
}
// --- Main Server Logic ---
serve(async (req)=>{
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors
    });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: cors
    });
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return new Response("Bad Request: Content-Type must be application/json", {
      status: 400,
      headers: cors
    });
  }
  // Open the TypeSafe connection while auth and rate limiting run, so the
  // Jev call does not pay DNS+TCP+TLS inside its 800 ms budget (measured
  // ~654 ms cold vs ~246 ms warm from the edge). Never awaited, never
  // rejects, never billed; the catch only keeps it from becoming an
  // unhandled rejection when the request ends first.
  if (jevEnabled) {
    prewarmJevConnection().catch(()=>null);
  }
  // --- Verified user identity ---
  const authResult = await resolveVerifiedUser(
    req.headers.get("Authorization"),
    supabaseAdmin.auth,
  );
  if (!authResult.ok && authResult.reason === "connected_app") {
    return connectedAppForbiddenResponse(cors);
  }
  if (!authResult.ok && authResult.reason === "missing_or_invalid_header") {
    return new Response("Unauthorized: Missing or invalid Authorization header", {
      status: 401,
      headers: cors
    });
  }
  if (!authResult.ok) {
    return new Response("Unauthorized: User ID could not be determined", {
      status: 401,
      headers: cors
    });
  }
  const userId = authResult.userId;
  // --- Database Rate Limiting ---
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
        console.log(`Rate limit exceeded for user ${userId}.`);
        return new Response(JSON.stringify({
          error: "Too Many Requests",
          message: "Rate limit exceeded. Please wait a minute before trying again."
        }), {
          status: 429,
          headers: {
            ...cors,
            "Content-Type": "application/json"
          }
        });
      }
      const { error: updateError } = await supabaseAdmin.schema("service").from("moderation_rate_limits").update({
        request_count: limitRecord.request_count + 1
      }).eq("user_id", userId).eq("function_name", FUNCTION_NAME);
      if (updateError) throw new Error("Failed to update rate limit count.");
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
      if (upsertError) throw new Error("Failed to initialize/reset rate limit record.");
      console.log(`User ${userId} rate limit window reset. Count: 1`);
    }
  } catch (dbError) {
    const dbErrorMessage =
        dbError instanceof Error ? dbError.message : String(dbError);
    console.error("Database error during rate limiting:", dbError);
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      message: `Rate limiting check failed: ${dbErrorMessage}`
    }), {
      status: 500,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  }
  // --- Parse Request ---
  let requestPayload;
  try {
    requestPayload = await req.json();
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return new Response(`Bad Request: Invalid JSON payload. ${errorMessage}`, {
      status: 400,
      headers: cors
    });
  }
  const { text, imageBase64 } = requestPayload;
  const surface = parseSurface(requestPayload.surface);
  if (!text && !imageBase64) {
    return new Response("Bad Request: Missing 'text' or 'imageBase64' in request body.", {
      status: 400,
      headers: cors
    });
  }
  if (text && imageBase64) {
    return new Response("Bad Request: Provide either 'text' or 'imageBase64', not both.", {
      status: 400,
      headers: cors
    });
  }
  console.log("Received moderation request:", {
    text: text ? text.substring(0, 50) + "..." : undefined,
    imageBase64: imageBase64 ? "Present" : undefined,
    surface: surface ?? "unspecified"
  });
  // --- Moderation ---
  try {
    let result;
    if (text) {
      result = await moderator.moderateText(text, {
        surface,
        correlationId: `content-moderation:${userId}`
      });
    } else {
      result = await moderateImage(imageBase64);
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error during moderation:", error);
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      message: errorMessage
    }), {
      status: 500,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  }
});
console.log("content-moderation function started.");
