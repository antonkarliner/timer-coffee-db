import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const VALID_CATEGORIES = new Set([
  "brews",
  "beans",
  "general"
]);
const VALID_PLATFORMS = new Set([
  "ios",
  "android",
  "web"
]);
const MAX_EVENTS_PER_BATCH = 100;
const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-country-code",
  "x-vercel-ip-country"
];
function validateEvent(event) {
  if (typeof event !== "object" || event === null) return false;
  const e = event;
  return typeof e.event_name === "string" && e.event_name.length > 0 && typeof e.category === "string" && VALID_CATEGORIES.has(e.category) && typeof e.session_id === "string" && e.session_id.length > 0 && typeof e.install_id === "string" && e.install_id.length > 0 && typeof e.platform === "string" && VALID_PLATFORMS.has(e.platform) && typeof e.app_version === "string" && e.app_version.length > 0 && typeof e.client_ts === "string" && e.client_ts.length > 0;
}
/** Try to extract country from proxy/CDN headers. */ function extractCountryFromHeaders(req) {
  for (const header of COUNTRY_HEADERS){
    const value = req.headers.get(header);
    if (value && value.length === 2 && value !== "XX" && value !== "T1") {
      return value.toUpperCase();
    }
  }
  return null;
}
/** Extract the real client IP from x-forwarded-for or x-real-ip. */ function extractClientIp(req) {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const ip = xff.split(/\s*,\s*/)[0];
    if (ip && ip.length > 0) return ip;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.length > 0) return realIp;
  return null;
}
/** Look up country from IP via country.is API (free, no key, HTTPS). */ async function lookupCountryByIp(ip) {
  try {
    const res = await fetch(`https://api.country.is/${ip}`, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json();
      const country = data?.country;
      if (typeof country === "string" && country.length === 2 && country !== "XX") {
        return country.toUpperCase();
      }
    }
  } catch (e) {
    console.warn("country.is lookup failed:", e);
  }
  return null;
}
Deno.serve(async (req)=>{
  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  try {
    const body = await req.json();
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return new Response(JSON.stringify({
        error: "Missing or empty events array"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
      return new Response(JSON.stringify({
        error: `Batch too large. Maximum ${MAX_EVENTS_PER_BATCH} events per request.`
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    const validEvents = [];
    for (const event of events){
      if (validateEvent(event)) {
        validEvents.push(event);
      }
    }
    if (validEvents.length === 0) {
      return new Response(JSON.stringify({
        error: "No valid events in batch"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // --- Country detection priority chain ---
    // 1. Client-provided (from RegionService geoip cache, IP-based)
    const clientCountry = validEvents[0]?.country ?? null;
    let country = clientCountry;
    let countrySource = clientCountry ? "client" : "none";
    // 2. CDN/proxy headers (cf-ipcountry etc.)
    if (!country) {
      country = extractCountryFromHeaders(req);
      if (country) countrySource = "header";
    }
    // 3. IP lookup via x-forwarded-for + country.is
    if (!country) {
      const clientIp = extractClientIp(req);
      if (clientIp) {
        country = await lookupCountryByIp(clientIp);
        if (country) countrySource = "ip_lookup";
      }
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const rows = validEvents.map((event)=>({
        event_name: event.event_name,
        category: event.category,
        session_id: event.session_id,
        install_id: event.install_id,
        platform: event.platform,
        app_version: event.app_version,
        properties: event.properties ?? {},
        client_ts: event.client_ts,
        country: country ?? null
      }));
    const { data, error } = await supabase.rpc("insert_analytics_events", {
      events: rows
    });
    if (error) {
      console.error("RPC insert error:", error.message);
      return new Response(JSON.stringify({
        error: "Failed to store events"
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    return new Response(JSON.stringify({
      accepted: validEvents.length,
      dropped: events.length - validEvents.length,
      country_detected: country ?? "none",
      country_source: countrySource
    }), {
      status: 202,
      headers: {
        "Content-Type": "application/json",
        "Connection": "keep-alive"
      }
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({
      error: "Internal server error"
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
