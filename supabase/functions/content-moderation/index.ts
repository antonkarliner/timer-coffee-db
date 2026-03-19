import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { decode } from "https://deno.land/std@0.203.0/encoding/base64url.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { createModerationClient } from "../_shared/moderation.ts";

// --- Rate Limiting Configuration ---
const FUNCTION_NAME = "content-moderation";
const MAX_REQUESTS = 3;
const WINDOW_SECONDS = 60;

// --- Environment Variables ---
const openaiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL");
const groqApiKey = Deno.env.get("GROQ_API_KEY");
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!openaiApiKey) {
  console.error("OPENAI_API_KEY_NON_PERSONAL is not set.");
  Deno.exit(1);
}
if (!groqApiKey) {
  console.error("GROQ_API_KEY is not set.");
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

const moderator = createModerationClient({ openaiApiKey, groqApiKey });

// --- JWT Decoding ---
interface JwtPayload {
  sub?: string;
  [key: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      console.error("Invalid JWT structure");
      return null;
    }
    return JSON.parse(new TextDecoder().decode(decode(parts[1])));
  } catch (e) {
    console.error("Error decoding JWT payload:", e);
    return null;
  }
}

// --- Image moderation via omni-moderation ---
async function moderateImage(imageBase64: string): Promise<{ safe: boolean; reason?: string }> {
  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }],
    }),
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
    const flaggedCategories = Object.entries(result.categories as Record<string, boolean>)
      .filter(([, flagged]) => flagged)
      .map(([cat]) => cat)
      .join(", ");
    return { safe: false, reason: `Image flagged: ${flaggedCategories}` };
  }

  return { safe: true };
}

// --- Main Server Logic ---
serve(async (req) => {
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }

  if (req.headers.get("content-type") !== "application/json") {
    return new Response("Bad Request: Content-Type must be application/json", { status: 400, headers: cors });
  }

  // --- JWT / User ID extraction ---
  const authHeader = req.headers.get("Authorization");
  let userId: string | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = decodeJwtPayload(token);
    if (payload?.sub) {
      userId = payload.sub;
    } else {
      console.warn("Could not extract user ID from JWT.");
    }
  } else {
    return new Response("Unauthorized: Missing or invalid Authorization header", { status: 401, headers: cors });
  }

  if (!userId) {
    return new Response("Unauthorized: User ID could not be determined", { status: 401, headers: cors });
  }

  // --- Database Rate Limiting ---
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const now = new Date();
    const windowStartTime = new Date(now.getTime() - WINDOW_SECONDS * 1000);

    const { data: limitRecord, error: fetchError } = await supabaseAdmin
      .schema("service")
      .from("moderation_rate_limits")
      .select("request_count, window_start_time")
      .eq("user_id", userId)
      .eq("function_name", FUNCTION_NAME)
      .maybeSingle();

    if (fetchError) {
      console.error("Error fetching rate limit record:", fetchError);
      throw new Error("Failed to fetch rate limit status.");
    }

    if (limitRecord && new Date(limitRecord.window_start_time) > windowStartTime) {
      if (limitRecord.request_count >= MAX_REQUESTS) {
        console.log(`Rate limit exceeded for user ${userId}.`);
        return new Response(
          JSON.stringify({ error: "Too Many Requests", message: "Rate limit exceeded. Please wait a minute before trying again." }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      const { error: updateError } = await supabaseAdmin
        .schema("service")
        .from("moderation_rate_limits")
        .update({ request_count: limitRecord.request_count + 1 })
        .eq("user_id", userId)
        .eq("function_name", FUNCTION_NAME);

      if (updateError) throw new Error("Failed to update rate limit count.");
      console.log(`User ${userId} rate limit count updated to ${limitRecord.request_count + 1}`);
    } else {
      const { error: upsertError } = await supabaseAdmin
        .schema("service")
        .from("moderation_rate_limits")
        .upsert(
          { user_id: userId, function_name: FUNCTION_NAME, request_count: 1, window_start_time: now.toISOString() },
          { onConflict: "user_id, function_name" }
        );

      if (upsertError) throw new Error("Failed to initialize/reset rate limit record.");
      console.log(`User ${userId} rate limit window reset. Count: 1`);
    }
  } catch (dbError) {
    console.error("Database error during rate limiting:", dbError);
    return new Response(
      JSON.stringify({ error: "Internal Server Error", message: `Rate limiting check failed: ${dbError.message}` }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  // --- Parse Request ---
  let requestPayload: { text?: string; imageBase64?: string };
  try {
    requestPayload = await req.json();
  } catch (e) {
    return new Response(`Bad Request: Invalid JSON payload. ${e.message}`, { status: 400, headers: cors });
  }

  const { text, imageBase64 } = requestPayload;

  if (!text && !imageBase64) {
    return new Response("Bad Request: Missing 'text' or 'imageBase64' in request body.", { status: 400, headers: cors });
  }
  if (text && imageBase64) {
    return new Response("Bad Request: Provide either 'text' or 'imageBase64', not both.", { status: 400, headers: cors });
  }

  console.log("Received moderation request:", {
    text: text ? text.substring(0, 50) + "..." : undefined,
    imageBase64: imageBase64 ? "Present" : undefined,
  });

  // --- Moderation ---
  try {
    let result: { safe: boolean; reason?: string };

    if (text) {
      result = await moderator.moderateText(text);
    } else {
      result = await moderateImage(imageBase64!);
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error during moderation:", error);
    return new Response(
      JSON.stringify({ error: "Internal Server Error", message: error.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});

console.log("content-moderation function started.");
