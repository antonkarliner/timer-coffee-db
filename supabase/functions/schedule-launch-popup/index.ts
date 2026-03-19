import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { securityHeaders } from "../_shared/security-headers.ts";
import { checkIpRateLimit } from "../_shared/rate-limiter.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Apply rate limiting
  const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
  const rateLimitResult = await checkIpRateLimit(clientIp, 5); // 5 popups per window
  
  if (!rateLimitResult.allowed) {
    return new Response(JSON.stringify({
      error: "Rate limit exceeded",
      message: "You can schedule a maximum of 5 popups per hour",
      retryAfter: rateLimitResult.retryAfter
    }), {
      status: 429,
      headers: { ...corsHeaders, ...securityHeaders, "Content-Type": "application/json" }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { content, locale, publication_time } = body;
  if (!content || !locale || !publication_time) {
    return json({ error: "Missing required fields" }, 400);
  }

  const runAt = new Date(publication_time);
  if (isNaN(runAt.valueOf()))
    return json({ error: "Invalid publication_time" }, 400);

  console.log("Scheduling popup for:", runAt.toISOString());

  const { data, error } = await supabase.rpc("enqueue_popup", {
    _content: content,
    _locale: locale,
    _run_at: runAt.toISOString(), // pass timestampz to pg, it will be converted to integer delay
  });

  if (error) {
    console.error("Error from enqueue_popup:", error);
    return json({ error: error.message, details: error.details }, 500);
  }

  return json({ success: true, msg_id: data });
});
