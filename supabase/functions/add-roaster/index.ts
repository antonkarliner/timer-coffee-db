import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { classifyRoasterUrl } from "../_shared/roaster-url.ts";
import { corsHeaders } from "./_shared/cors.ts";
import { parseAddRoasterInput } from "./input.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Required environment variables are not set");
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = parseAddRoasterInput(body as Record<string, unknown>);
  if (!parsed.ok) {
    return json({ error: parsed.error }, parsed.status);
  }

  // Log whenever the router made any decision, not only when it moved a URL:
  // a website input the classifier rejects is dropped to null, and that must
  // not happen silently.
  if (parsed.routing.routed || parsed.routing.notes.length > 0) {
    console.log("Routed add-roaster URL fields", {
      routed: parsed.routing.routed,
      original_website_input: (body as Record<string, unknown>)
        .roaster_website_url,
      original_instagram_input: (body as Record<string, unknown>).instagram_url,
      website_url: parsed.routing.website_url,
      instagram_url: parsed.routing.instagram_url,
      notes: parsed.routing.notes,
    });
  }

  const { data, error } = await supabase.rpc(
    "create_roaster_with_profile",
    parsed.value,
  );
  if (error) {
    if (error.code === "23505") {
      return json({ error: "Roaster with this name already exists" }, 409);
    }
    return json({ error: error.message }, 500);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return json(
      { error: "RPC returned an invalid persisted roaster row" },
      500,
    );
  }
  const persisted = data as Record<string, unknown>;
  const persistedWebsite = persisted.roaster_website_url;
  if (
    persistedWebsite !== null &&
    (typeof persistedWebsite !== "string" ||
      classifyRoasterUrl(persistedWebsite).kind.startsWith("instagram"))
  ) {
    return json({
      error:
        "Persisted roaster verification failed: roaster_website_url contains an Instagram URL",
    }, 500);
  }
  if (persisted.instagram_url !== parsed.value.p_instagram_url) {
    return json({
      error:
        "Persisted roaster verification failed: instagram_url does not match the canonical value sent",
    }, 500);
  }

  return json({
    roaster: {
      id: persisted.roaster_id,
      roaster_name: persisted.roaster_name,
      roaster_logo_url: persisted.roaster_logo_url,
      roaster_website_url: persisted.roaster_website_url,
      aliases: persisted.aliases,
      city: persisted.city,
      state: persisted.state,
      country: persisted.country,
      address_text: persisted.address_text,
      instagram_url: persisted.instagram_url,
      profile_id: persisted.profile_id,
    },
  }, 201);
});
