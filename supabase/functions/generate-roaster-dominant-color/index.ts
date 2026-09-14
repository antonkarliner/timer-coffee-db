/**
 * Legacy entry point for roaster dominant-colour extraction.
 *
 * The extraction pipeline now lives in `_shared/roaster-color-core.ts` so
 * that this function and the durable `roaster-postprocess-worker` share ONE
 * implementation. Supports the same request shapes as before: a direct
 * `{ roaster_id }` body, or a database webhook payload.
 *
 * Behavioural change (2026-09 hardening): SVG mirrors are no longer answered
 * with a silent null colour. When no colour can be produced the response is
 * `success: false` with a typed error; only the documented "fully
 * transparent image" rule yields success with a null colour.
 */

import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getEnvVar } from "../_shared/env-validation.ts";
import { ensureImageMagickReady } from "../_shared/magick-init.ts";
import {
  ColorCoreDeps,
  decodeColorWithImageMagick,
  extractRoasterDominantColor,
} from "../_shared/roaster-color-core.ts";
import {
  DbError,
  errorToMessage,
  SvgRasterizationUnsupportedError,
} from "../_shared/roaster-postprocess-errors.ts";
import { fetchLogoWithGuards } from "../_shared/roaster-logo-mirror-core.ts";

const corsHeaders = getCorsHeaders();

const supabaseUrl = getEnvVar("SUPABASE_URL");
const supabaseServiceRoleKey = getEnvVar("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing required Supabase configuration");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const colorDeps: ColorCoreDeps = {
  fetchAsset: fetchLogoWithGuards,
  decodeColor: decodeColorWithImageMagick,
  ensureReady: ensureImageMagickReady,
  updateDominantColor: async (roasterId, hex) => {
    const { error } = await supabase
      .from("coffee_roasters")
      .update({ dominant_color_hex: hex })
      .eq("id", roasterId);
    if (error) {
      throw new DbError(
        `Failed to update dominant color for roaster ${roasterId}: ${error.message}`,
      );
    }
  },
};

interface RoasterRow {
  id: number;
  roaster_name: string | null;
  roaster_logo_mirror_url: string | null;
}

interface DirectRequest {
  roaster_id: number;
}

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: RoasterRow | null;
  old_record: RoasterRow | null;
}

function isDirectRequest(value: unknown): value is DirectRequest {
  return typeof value === "object" &&
    value !== null &&
    "roaster_id" in value &&
    typeof (value as Record<string, unknown>).roaster_id === "number";
}

function isWebhookPayload(value: unknown): value is WebhookPayload {
  return typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "table" in value &&
    "schema" in value;
}

async function loadRoaster(roasterId: number): Promise<RoasterRow | null> {
  const { data, error } = await supabase
    .from("coffee_roasters")
    .select("id, roaster_name, roaster_logo_mirror_url")
    .eq("id", roasterId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load roaster ${roasterId}: ${error.message}`);
  }

  return data as RoasterRow | null;
}

async function processRoaster(roaster: RoasterRow): Promise<{
  success: boolean;
  roaster_id: number;
  dominant_color_hex: string | null;
  error?: string;
}> {
  if (!roaster.roaster_logo_mirror_url) {
    // No mirror: the documented null rule — nothing to represent.
    await colorDeps.updateDominantColor(roaster.id, null);
    return {
      success: true,
      roaster_id: roaster.id,
      dominant_color_hex: null,
    };
  }

  try {
    const result = await extractRoasterDominantColor(colorDeps, {
      roasterId: roaster.id,
      mirrorUrl: roaster.roaster_logo_mirror_url,
    });
    return {
      success: true,
      roaster_id: roaster.id,
      dominant_color_hex: result.color,
    };
  } catch (error) {
    const message = errorToMessage(error);

    // SVG-without-raster-asset must stay VISIBLE: writing null here would
    // recreate the silently-null-colour behaviour this module is being
    // migrated away from. Every other failure keeps the legacy behaviour of
    // clearing the stored colour.
    if (!(error instanceof SvgRasterizationUnsupportedError)) {
      await colorDeps.updateDominantColor(roaster.id, null).catch(() => {});
    }
    console.error("Failed to generate dominant color", {
      roasterId: roaster.id,
      roasterName: roaster.roaster_name,
      imageUrl: roaster.roaster_logo_mirror_url,
      error: message,
    });

    return {
      success: false,
      roaster_id: roaster.id,
      dominant_color_hex: null,
      error: message,
    };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  try {
    if (isDirectRequest(body)) {
      const roaster = await loadRoaster(body.roaster_id);
      if (!roaster) {
        return new Response(
          JSON.stringify({ error: `Roaster ${body.roaster_id} not found` }),
          {
            status: 404,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const result = await processRoaster(roaster);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    if (isWebhookPayload(body)) {
      if (
        body.type !== "UPDATE" || body.table !== "coffee_roasters" ||
        body.schema !== "public" || !body.record
      ) {
        return new Response(
          JSON.stringify({ error: "Unsupported webhook payload" }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const result = await processRoaster(body.record);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    return new Response(
      JSON.stringify({ error: "Unsupported request payload" }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    const message = errorToMessage(error);
    console.error("Unhandled dominant-color error", { error: message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
});
