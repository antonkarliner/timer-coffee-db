import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { corsHeaders } from "../_shared/cors.ts";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const cronSecret = Deno.env.get("CRON_JOB_SECRET");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}
if (!cronSecret) {
  console.warn("CRON_JOB_SECRET is not configured; token-maintenance will reject cron calls");
}
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false
  },
  db: {
    schema: "service"
  }
});
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const token = req.headers.get("x-system-token");
  if (!cronSecret || token !== cronSecret) {
    return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 403,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  try {
    const body = await safeJson(req);
    const action = body?.action ?? "cleanup";
    switch(action){
      case "cleanup":
        return await handleCleanup(body);
      case "metrics":
        return await handleMetrics();
      default:
        return new Response(JSON.stringify({
          error: `Unsupported action: ${action}`
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
    }
  } catch (error) {
    console.error("token-maintenance error", error);
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
async function handleCleanup(payload = {}) {
  const maxAge = payload.maxAgeDays ?? Number(Deno.env.get("TOKEN_MAX_AGE_DAYS") ?? "90");
  const { data, error } = await supabase.rpc("cleanup_invalid_tokens", {
    p_max_age_days: maxAge
  });
  if (error) {
    throw new Error(`cleanup_invalid_tokens failed: ${error.message}`);
  }
  return new Response(JSON.stringify({
    success: true,
    deleted: data ?? 0
  }), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
async function handleMetrics() {
  const { count: activeCount, error: activeError } = await supabase.from("user_fcm_tokens").select("id", {
    count: "exact",
    head: true
  }).eq("is_active", true);
  if (activeError) {
    throw new Error(`Failed to count active tokens: ${activeError.message}`);
  }
  const { count: inactiveCount, error: inactiveError } = await supabase.from("user_fcm_tokens").select("id", {
    count: "exact",
    head: true
  }).eq("is_active", false);
  if (inactiveError) {
    throw new Error(`Failed to count inactive tokens: ${inactiveError.message}`);
  }
  return new Response(JSON.stringify({
    success: true,
    activeTokens: activeCount ?? 0,
    inactiveTokens: inactiveCount ?? 0
  }), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
async function safeJson(req) {
  try {
    return await req.json();
  } catch (_err) {
    return {};
  }
}
