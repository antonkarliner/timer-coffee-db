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
import { getCorsHeaders } from "../_shared/cors.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  generateLogoVariants,
  variantSuffix,
  VARIANT_SIZES,
} from "../_shared/image-variants.ts";

const MAX_INPUT_BYTES = 4_500_000;
const MAX_DIMENSION = 1200;
const OUTPUT_QUALITY = 82;
const BUCKET_NAME = "roaster-logos";

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

interface RoasterProfileRow {
  id: string;
  roaster_name: string | null;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
) {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

function decodeBase64Image(base64: string): Uint8Array {
  const sanitized = base64.replace(/\s+/g, "");
  const binaryString = atob(sanitized);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return bytes;
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

async function authenticateUser(req: Request) {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw new Error("Invalid Supabase session");
  }

  return {
    accessToken: token,
    user: data.user,
  };
}

async function getOwnedProfile(userId: string): Promise<RoasterProfileRow> {
  const { data, error } = await supabase
    .from("roaster_profiles")
    .select("id, roaster_name")
    .eq("admin_user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load roaster profile: ${error.message}`);
  }

  if (!data) {
    throw new Error("No roaster profile is assigned to this user");
  }

  return data as RoasterProfileRow;
}

function optimizeImageToWebP(imageBytes: Uint8Array) {
  const resizeGeometry = new MagickGeometry(MAX_DIMENSION, MAX_DIMENSION);
  resizeGeometry.ignoreAspectRatio = false;

  return ImageMagick.read(imageBytes, (image): Uint8Array => {
    const mutableImage = image as unknown as {
      strip?: () => void;
      quality?: number;
    };

    image.resize(resizeGeometry);
    if (typeof mutableImage.strip === "function") {
      mutableImage.strip();
    }
    mutableImage.quality = OUTPUT_QUALITY;
    return image.write(MagickFormat.WebP, (data) => data);
  });
}

function extractDominantColorHex(imageBytes: Uint8Array): string | null {
  const resizeGeometry = new MagickGeometry(DEFAULT_RESIZE_TO, DEFAULT_RESIZE_TO);
  resizeGeometry.ignoreAspectRatio = true;

  const rawPixelBytes = ImageMagick.read(imageBytes, (image): Uint8Array => {
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

async function upsertRoasterLogo(profile: RoasterProfileRow, imageBytes: Uint8Array) {
  const optimizedBytes = optimizeImageToWebP(imageBytes);
  const dominantColorHex = extractDominantColorHex(optimizedBytes);
  const objectPath = `${profile.id}/logo.webp`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(objectPath, optimizedBytes, {
      contentType: "image/webp",
      cacheControl: "31536000",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload logo: ${uploadError.message}`);
  }

  // Upload pre-baked size variants so they can be served without any
  // image transformation service (avoids Supabase + Vercel quota limits).
  const variants = generateLogoVariants(optimizedBytes);
  for (const size of VARIANT_SIZES) {
    const variantBytes = variants.get(size)!;
    const variantPath = `${profile.id}/logo${variantSuffix(size)}.webp`;
    const { error: variantError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(variantPath, variantBytes, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: true,
      });
    if (variantError) {
      // Non-fatal: log and continue. The original logo is already uploaded.
      console.error(`Failed to upload ${size}px variant: ${variantError.message}`);
    }
  }

  const { data: publicUrlData } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(objectPath);

  const publicUrl = publicUrlData.publicUrl;

  const { error: updateError } = await supabase
    .from("roaster_profiles")
    .update({
      roaster_logo_url: publicUrl,
      roaster_logo_mirror_url: publicUrl,
      dominant_color_hex: dominantColorHex,
      updated_at: new Date().toISOString(),
    })
    .eq("id", profile.id);

  if (updateError) {
    throw new Error(`Failed to update roaster profile logo: ${updateError.message}`);
  }

  return {
    roaster_logo_url: publicUrl,
    roaster_logo_mirror_url: publicUrl,
    dominant_color_hex: dominantColorHex,
  };
}

async function removeRoasterLogo(profile: RoasterProfileRow) {
  const pathsToRemove = [
    `${profile.id}/logo.webp`,
    ...VARIANT_SIZES.map((size) => `${profile.id}/logo${variantSuffix(size)}.webp`),
  ];
  const { error: removeError } = await supabase.storage
    .from(BUCKET_NAME)
    .remove(pathsToRemove);

  if (removeError) {
    throw new Error(`Failed to remove logo from storage: ${removeError.message}`);
  }

  const { error: updateError } = await supabase
    .from("roaster_profiles")
    .update({
      roaster_logo_url: null,
      roaster_logo_mirror_url: null,
      dominant_color_hex: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", profile.id);

  if (updateError) {
    throw new Error(`Failed to clear roaster profile logo: ${updateError.message}`);
  }
}

Deno.serve(async (req) => {
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);

  if (req.method === "OPTIONS") {
    return createSecureResponse("ok", { headers: cors });
  }

  if (req.method !== "POST" && req.method !== "DELETE") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  try {
    const authContext = await authenticateUser(req);
    const ownedProfile = await getOwnedProfile(authContext.user.id);

    if (req.method === "DELETE") {
      await removeRoasterLogo(ownedProfile);
      return jsonResponse({ success: true }, 200, cors);
    }

    const payload = await req.json();
    const contentType = payload?.contentType;
    const imageBase64 = payload?.imageBase64;

    if (
      typeof contentType !== "string" ||
      !["image/png", "image/jpeg", "image/webp"].includes(contentType)
    ) {
      return jsonResponse({ error: "Only PNG, JPEG, and WebP images are allowed" }, 400, cors);
    }

    if (typeof imageBase64 !== "string" || imageBase64.trim().length === 0) {
      return jsonResponse({ error: "Missing image payload" }, 400, cors);
    }

    const decodedBytes = decodeBase64Image(imageBase64);
    if (decodedBytes.byteLength > MAX_INPUT_BYTES) {
      return jsonResponse({ error: "Image is too large" }, 400, cors);
    }

    const result = await upsertRoasterLogo(ownedProfile, decodedBytes);

    return jsonResponse(
      {
        success: true,
        profile_id: ownedProfile.id,
        ...result,
      },
      200,
      cors,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = /Authorization|session/i.test(message)
      ? 401
      : /No roaster profile/i.test(message)
      ? 403
      : 500;

    return jsonResponse({ error: message }, status, cors);
  }
});
