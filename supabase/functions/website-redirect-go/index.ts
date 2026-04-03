import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405
    });
  }
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) {
    return new Response("Missing slug", {
      status: 400
    });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false
    }
  });
  const { data: redirect, error } = await supabase.schema("service").from("website_redirects").select("id, target_url, is_active").eq("slug", slug).maybeSingle();
  if (error || !redirect || !redirect.target_url || !redirect.is_active) {
    return new Response("Not found", {
      status: 404
    });
  }
  // Log click (skip bots)
  const ua = req.headers.get("user-agent") ?? "";
  const isBot = /bot|crawl|spider|slurp|facebookexternalhit|preview/i.test(ua);
  if (!isBot) {
    // Fire-and-forget
    supabase.schema("service").from("website_redirect_clicks").insert({
      redirect_id: redirect.id,
      slug,
      referer: req.headers.get("referer") ?? null,
      user_agent: ua || null
    }).then(()=>{}).catch(()=>{});
  }
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders,
      Location: redirect.target_url,
      "Cache-Control": "no-store"
    }
  });
});
