import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickGeometry,
} from "npm:@imagemagick/magick-wasm@0.0.30";
import {
  assertSupportedImageFormat,
  generateLogoVariants,
  ImageFormatError,
  UNSUPPORTED_MIME_TYPES,
  variantSuffix,
  VARIANT_SIZES,
} from "../_shared/image-variants.ts";

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL");

if (!supabaseUrl || !supabaseServiceRoleKey || !RESEND_API_KEY || !ADMIN_EMAIL) {
  throw new Error("Required environment variables are not set");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ---------------------------------------------------------------------------
// ImageMagick WASM initialisation (module-level, runs once on cold start)
// ---------------------------------------------------------------------------

const magickWasmBytes = await Deno.readFile(
  new URL(
    "magick.wasm",
    import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30"),
  ),
);
await initializeImageMagick(magickWasmBytes);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUCKET_NAME = "roaster_logo_mirrors";
const SVG_CONTENT_TYPE = "image/svg+xml";

/** Sanitise a roaster name to a safe filename fragment. */
function sanitizeFilename(name: string): string {
  const transliterationMap: Record<string, string> = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
  };

  return name.toLowerCase()
    .split("")
    .map((char) => transliterationMap[char] ?? char)
    .join("")
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "_");
}

/**
 * Build the base storage path (no extension) for a roaster's logo.
 * Uses the roaster's numeric ID as a prefix to avoid collisions between
 * roasters whose names sanitise to the same string.
 * e.g. roasterId=42, name="Blue Bottle Coffee" → "42_blue_bottle_coffee"
 */
function buildBasePath(roasterId: string | number, roasterName: string): string {
  return `${roasterId}_${sanitizeFilename(roasterName)}`;
}

function issvgUrl(url: string, contentType: string | null): boolean {
  if (contentType === SVG_CONTENT_TYPE) return true;
  const lower = url.split("?")[0].toLowerCase();
  return lower.endsWith(".svg");
}

/** Convert raw image bytes to WebP, stripping metadata and capping at 1200px. */
function convertToWebP(imageBytes: Uint8Array): Uint8Array {
  return ImageMagick.read(imageBytes, (image): Uint8Array => {
    // Cap at 1200px longest edge — very high-res source images (e.g. 5000px+)
    // cause WASM heap OOM when decoded unscaled. 1200px matches the admin upload
    // pipeline's maximum output size.
    const MAX = 1200;
    if (image.width > MAX || image.height > MAX) {
      const geo = new MagickGeometry(MAX, MAX);
      geo.ignoreAspectRatio = false;
      image.resize(geo);
    }
    const mutable = image as unknown as { strip?: () => void; quality?: number };
    if (typeof mutable.strip === "function") mutable.strip();
    mutable.quality = 82;
    // Slice copies the bytes out of WASM heap memory before it's freed.
    // Without the copy, the first 8 bytes of the RIFF container header get
    // overwritten with WASM free-list pointers, producing an invalid WebP file.
    return image.write(MagickFormat.WebP, (data) => data.slice());
  });
}

async function sendErrorEmail(subject: string, body: string): Promise<void> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "logo_errors@timer.coffee",
        to: ADMIN_EMAIL,
        subject,
        html: body,
      }),
    });
    if (!res.ok) {
      console.error("Failed to send error email:", await res.text());
    }
  } catch (error) {
    console.error(
      "Error sending email:",
      error instanceof Error ? error.message : error,
    );
  }
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

/**
 * Download, optimise, and store a roaster logo together with all size variants.
 *
 * Storage layout in `roaster_logo_mirrors` bucket:
 *   {id}_{name}.webp        ← canonical URL stored in coffee_roasters
 *   {id}_{name}-96w.webp   ← 96 px variant  (catalog cards)
 *   {id}_{name}-400w.webp  ← 400 px variant (detail page)
 *
 * SVG logos are stored as-is without rasterisation; no variants are created.
 *
 * Returns the public URL of the canonical file, or null on failure.
 */
async function processCoffeeRoaster(
  roasterId: string | number,
  roasterName: string,
  logoUrl: string,
): Promise<string | null> {
  try {
    if (!logoUrl) {
      console.log(`No logo URL for roaster ${roasterName}. Skipping.`);
      return null;
    }

    const imageResponse = await fetch(logoUrl, {
      headers: {
        // Prevent CDN content negotiation to WebP/AVIF — ImageMagick WASM 0.0.30
        // cannot decode VP8X extended WebP (served by Shopify CDN when Accept
        // includes image/webp). Deno's native fetch sends browser-like Accept
        // headers by default, triggering this behaviour.
        Accept: "image/png, image/jpeg, image/gif, image/svg+xml, image/bmp",
      },
    });
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch logo: HTTP ${imageResponse.status}`);
    }

    const contentLength = Number(imageResponse.headers.get("content-length") ?? 0);
    if (contentLength > 3_000_000) {
      throw new Error(
        `Source image too large (${Math.round(contentLength / 1024)}KB) — replace roaster_logo_url with a smaller version`,
      );
    }

    const contentType = imageResponse.headers.get("content-type")
      ?.split(";")[0].trim() ?? null;

    // Reject unsupported MIME types before downloading the body.
    if (contentType && UNSUPPORTED_MIME_TYPES.has(contentType)) {
      throw new ImageFormatError(
        `Unsupported content-type '${contentType}' — update the source URL`,
      );
    }

    const imageBuffer = new Uint8Array(await imageResponse.arrayBuffer());
    const basePath = buildBasePath(roasterId, roasterName);

    if (issvgUrl(logoUrl, contentType)) {
      // Store SVGs as-is — rasterising vectors is lossy. No variants needed.
      const svgPath = `${basePath}.svg`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(svgPath, imageBuffer, {
          contentType: SVG_CONTENT_TYPE,
          cacheControl: "31536000",
          upsert: true,
        });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(svgPath);

      const { error: updateError } = await supabase
        .from("coffee_roasters")
        .update({ roaster_logo_mirror_url: urlData.publicUrl })
        .eq("id", roasterId);
      if (updateError) throw updateError;

      console.log(`Stored SVG logo for ${roasterName}`);
      return urlData.publicUrl;
    }

    // Validate magic bytes before passing to ImageMagick (catches HTML from
    // auth-gated CDNs, AVIF/HEIC that slipped past the content-type check, etc.).
    assertSupportedImageFormat(imageBuffer);

    // Raster image: convert to WebP then generate size variants.
    const webpBytes = convertToWebP(imageBuffer);
    const mainPath = `${basePath}.webp`;

    const { error: mainUploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(mainPath, webpBytes, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: true,
      });
    if (mainUploadError) throw mainUploadError;

    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(mainPath);

    const publicUrl = urlData.publicUrl;

    // Upload size variants (non-fatal — main logo is already stored).
    const variants = generateLogoVariants(webpBytes);
    for (const size of VARIANT_SIZES) {
      const variantBytes = variants.get(size)!;
      const variantPath = `${basePath}${variantSuffix(size)}.webp`;
      const { error: variantError } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(variantPath, variantBytes, {
          contentType: "image/webp",
          cacheControl: "31536000",
          upsert: true,
        });
      if (variantError) {
        console.error(
          `Failed to upload ${size}px variant for ${roasterName}: ${variantError.message}`,
        );
      }
    }

    // Persist the canonical WebP URL.
    const { error: updateError } = await supabase
      .from("coffee_roasters")
      .update({ roaster_logo_mirror_url: publicUrl })
      .eq("id", roasterId);
    if (updateError) throw updateError;

    console.log(`Successfully processed logo for ${roasterName}`);
    return publicUrl;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Error processing roaster ${roasterName}: ${errorMessage}`);

    // ImageFormatError = expected data-quality issue (AVIF, auth-gated CDN, etc.).
    // Don't flood the admin inbox for these — they need a source URL fix, not a
    // function fix.
    if (!(error instanceof ImageFormatError)) {
      await sendErrorEmail(
        `Error processing roaster: ${roasterName}`,
        `An error occurred while processing the logo for roaster ${roasterName}:<br><br>
        Error message: ${errorMessage}<br>
        Roaster ID: ${roasterId}<br>
        Logo URL: ${logoUrl}`,
      );
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Edge Function handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const { record, type } = await req.json();

  if (
    (type === "INSERT" || type === "UPDATE") &&
    record?.id &&
    record?.roaster_name &&
    record?.roaster_logo_url
  ) {
    const result = await processCoffeeRoaster(
      record.id,
      record.roaster_name,
      record.roaster_logo_url,
    );

    return new Response(
      JSON.stringify(result
        ? { success: true, url: result }
        : { success: false, error: "Processing failed" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ success: false, error: "Invalid request" }),
    { headers: { "Content-Type": "application/json" } },
  );
});
