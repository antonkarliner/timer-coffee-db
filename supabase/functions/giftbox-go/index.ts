import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { corsHeaders } from "../_shared/cors.ts";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing Supabase configuration");
}
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false
  }
});
const nullIfEmpty = (value)=>{
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const isProbablyBot = (userAgent)=>/bot|crawl|spider|slurp|facebookexternalhit|preview/i.test(userAgent);
const isValidHttpUrl = (value)=>{
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch  {
    return false;
  }
};
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  const headersBase = {
    ...corsHeaders,
    "Cache-Control": "no-store"
  };
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        ...headersBase,
        Allow: "GET"
      }
    });
  }
  const url = new URL(req.url);
  const slug = nullIfEmpty(url.searchParams.get("slug"));
  if (!slug) return new Response("Not Found", {
    status: 404,
    headers: headersBase
  });
  const { data: offer, error: offerError } = await supabaseAdmin.from("giftbox_offers").select("id, website_url, is_active, valid_from, valid_to").eq("slug", slug).maybeSingle();
  if (offerError) {
    console.error("Error fetching giftbox offer:", offerError);
    return new Response("Internal Server Error", {
      status: 500,
      headers: headersBase
    });
  }
  const websiteUrl = nullIfEmpty(offer?.website_url ?? null);
  if (!offer || !websiteUrl || !offer.is_active) {
    return new Response("Offer unavailable", {
      status: 404,
      headers: headersBase
    });
  }
  const now = new Date();
  if (offer.valid_from && now < new Date(offer.valid_from)) {
    return new Response("Offer not active yet", {
      status: 404,
      headers: headersBase
    });
  }
  if (offer.valid_to && now > new Date(offer.valid_to)) {
    return new Response("Offer expired", {
      status: 404,
      headers: headersBase
    });
  }
  if (!isValidHttpUrl(websiteUrl)) {
    console.error("Invalid website_url for offer", {
      offer_id: offer.id,
      website_url: offer.website_url
    });
    return new Response("Offer unavailable", {
      status: 404,
      headers: headersBase
    });
  }
  const ua = req.headers.get("user-agent") ?? "";
  if (!isProbablyBot(ua)) {
    supabaseAdmin.schema("service").from("giftbox_offer_clicks").insert({
      offer_id: offer.id,
      slug,
      src: nullIfEmpty(url.searchParams.get("src")),
      platform: nullIfEmpty(url.searchParams.get("p")),
      app_version: nullIfEmpty(url.searchParams.get("v")),
      locale: nullIfEmpty(url.searchParams.get("l")),
      install_id: nullIfEmpty(url.searchParams.get("iid")),
      user_agent: nullIfEmpty(ua)
    }).then(()=>{}).catch((error)=>console.error("Error inserting giftbox click:", error));
  }
  return new Response(null, {
    status: 302,
    headers: {
      ...headersBase,
      Location: websiteUrl
    }
  });
});
