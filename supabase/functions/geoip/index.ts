import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { logWarning } from "../_shared/monitoring.ts";
import { createCountryRegionLookup } from "../_shared/country-region.ts";

// Reference data is fetched server-side; caller credentials are never used.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, detectSessionInUrl: false } },
);
const mapCountryToRegion = createCountryRegionLookup(
  () => supabase.from("country_regions").select("country_code, region"),
  (error) => logWarning("Failed to load country regions", { error }),
);
serve(async (req) => {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  try {
    const geo = ip
      ? await fetch(`https://ipapi.co/${ip}/json/`).then((r) => r.json())
      : await fetch("https://ipapi.co/json/").then((r) => r.json());
    const country = (geo.country || "").toUpperCase();
    const region = await mapCountryToRegion(country);
    return createSecureResponse(JSON.stringify({ country, region }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return createSecureResponse(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
