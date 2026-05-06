import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickGeometry,
} from "npm:@imagemagick/magick-wasm@0.0.30";
import {
  DEFAULT_RGBA_BYTE_LENGTH,
  DEFAULT_RESIZE_TO,
  extractRepresentativeColorHexFromRgba,
} from "../_shared/roaster-color.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing required Supabase configuration");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const magickWasmBytes = await Deno.readFile(
  new URL(
    "magick.wasm",
    import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30"),
  ),
);

await initializeImageMagick(magickWasmBytes);

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

function isSvgAsset(url: string, contentType: string | null): boolean {
  if (contentType?.toLowerCase().includes("image/svg")) {
    return true;
  }

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".svg");
  } catch {
    return url.toLowerCase().includes(".svg");
  }
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

async function updateDominantColor(
  roasterId: number,
  dominantColorHex: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("coffee_roasters")
    .update({
      dominant_color_hex: dominantColorHex,
    })
    .eq("id", roasterId);

  if (error) {
    throw new Error(
      `Failed to update dominant color for roaster ${roasterId}: ${error.message}`,
    );
  }
}

function normalizeRawPixelsToRgba(
  rawBytes: Uint8Array,
  pixelCount: number,
): Uint8Array {
  if (rawBytes.length === pixelCount * 4) {
    return rawBytes;
  }

  if (rawBytes.length === pixelCount * 3) {
    const rgba = new Uint8Array(pixelCount * 4);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const rawIndex = pixelIndex * 3;
      const rgbaIndex = pixelIndex * 4;
      rgba[rgbaIndex] = rawBytes[rawIndex];
      rgba[rgbaIndex + 1] = rawBytes[rawIndex + 1];
      rgba[rgbaIndex + 2] = rawBytes[rawIndex + 2];
      rgba[rgbaIndex + 3] = 255;
    }
    return rgba;
  }

  if (rawBytes.length === pixelCount * 2) {
    const rgba = new Uint8Array(pixelCount * 4);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const rawIndex = pixelIndex * 2;
      const rgbaIndex = pixelIndex * 4;
      const gray = rawBytes[rawIndex];
      rgba[rgbaIndex] = gray;
      rgba[rgbaIndex + 1] = gray;
      rgba[rgbaIndex + 2] = gray;
      rgba[rgbaIndex + 3] = rawBytes[rawIndex + 1];
    }
    return rgba;
  }

  if (rawBytes.length === pixelCount * 5) {
    const rgba = new Uint8Array(pixelCount * 4);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const rawIndex = pixelIndex * 5;
      const rgbaIndex = pixelIndex * 4;
      const c = rawBytes[rawIndex] / 255;
      const m = rawBytes[rawIndex + 1] / 255;
      const y = rawBytes[rawIndex + 2] / 255;
      const k = rawBytes[rawIndex + 3] / 255;

      rgba[rgbaIndex] = Math.round(255 * (1 - c) * (1 - k));
      rgba[rgbaIndex + 1] = Math.round(255 * (1 - m) * (1 - k));
      rgba[rgbaIndex + 2] = Math.round(255 * (1 - y) * (1 - k));
      rgba[rgbaIndex + 3] = rawBytes[rawIndex + 4];
    }
    return rgba;
  }

  if (rawBytes.length === pixelCount) {
    const rgba = new Uint8Array(pixelCount * 4);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const gray = rawBytes[pixelIndex];
      const rgbaIndex = pixelIndex * 4;
      rgba[rgbaIndex] = gray;
      rgba[rgbaIndex + 1] = gray;
      rgba[rgbaIndex + 2] = gray;
      rgba[rgbaIndex + 3] = 255;
    }
    return rgba;
  }

  throw new Error(
    `Unexpected RGBA payload size ${rawBytes.length}, expected ${DEFAULT_RGBA_BYTE_LENGTH}`,
  );
}

async function extractDominantColorHex(
  imageUrl: string,
): Promise<string | null> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image fetch failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  if (isSvgAsset(imageUrl, contentType)) {
    return null;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const resizeGeometry = new MagickGeometry(DEFAULT_RESIZE_TO, DEFAULT_RESIZE_TO);
  resizeGeometry.ignoreAspectRatio = true;

  const rawPixelBytes = ImageMagick.read(bytes, (image): Uint8Array => {
    image.resize(resizeGeometry);
    return image.write(MagickFormat.Rgba, (data) => data);
  });
  const rgbaBytes = normalizeRawPixelsToRgba(
    rawPixelBytes,
    DEFAULT_RESIZE_TO * DEFAULT_RESIZE_TO,
  );

  return extractRepresentativeColorHexFromRgba(
    rgbaBytes,
    DEFAULT_RESIZE_TO,
    DEFAULT_RESIZE_TO,
  );
}

async function processRoaster(roaster: RoasterRow): Promise<{
  success: boolean;
  roaster_id: number;
  dominant_color_hex: string | null;
  error?: string;
}> {
  if (!roaster.roaster_logo_mirror_url) {
    await updateDominantColor(roaster.id, null);
    return {
      success: true,
      roaster_id: roaster.id,
      dominant_color_hex: null,
    };
  }

  try {
    const dominantColorHex = await extractDominantColorHex(
      roaster.roaster_logo_mirror_url,
    );
    await updateDominantColor(roaster.id, dominantColorHex);

    return {
      success: true,
      roaster_id: roaster.id,
      dominant_color_hex: dominantColorHex,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDominantColor(roaster.id, null);
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
    const message = error instanceof Error ? error.message : String(error);
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
