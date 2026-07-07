/**
 * Backfills missing logo size variants for roasters in the roaster_logo_mirrors bucket.
 *
 * Two groups are handled:
 *   Group 1 (7 roasters)  – no mirror URL; downloads from roaster_logo_url, converts
 *                            to WebP, uploads canonical + variants, updates DB.
 *   Group 2 (123 roasters) – canonical exists in storage but -96w/-400w variants are
 *                            missing (variants were added to the pipeline after bulk
 *                            ingest). Reads canonical from storage. Falls back to
 *                            re-downloading from roaster_logo_url if the stored file
 *                            is corrupt (RIFF header bug from before data.slice() fix).
 *
 * Run:
 *   SUPABASE_SERVICE_ROLE_KEY=<key> deno run \
 *     --allow-net --allow-read --allow-env \
 *     scripts/backfill-logo-variants.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickGeometry,
} from "npm:@imagemagick/magick-wasm@0.0.30";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = "https://mprokbemdullwezwwscn.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "roaster_logo_mirrors";
const VARIANT_SIZES = [96, 400] as const;
const MAX_SOURCE_SIZE = 3_000_000;

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY env var is required");
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// ImageMagick init (module-level, runs once)
// ---------------------------------------------------------------------------

const magickWasmBytes = await Deno.readFile(
  new URL(
    "magick.wasm",
    import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30"),
  ),
);
await initializeImageMagick(magickWasmBytes);

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// ID lists (from storage audit query run on 2026-05-15)
// ---------------------------------------------------------------------------

/** Roasters with roaster_logo_url set but roaster_logo_mirror_url is NULL. */
const GROUP_1_IDS = [1273, 1567, 1565, 1441, 1561, 1413, 1318];

/**
 * Roasters whose canonical file exists in roaster_logo_mirrors but are missing
 * -96w / -400w variants. Variants were added to the pipeline after bulk ingest.
 */
const GROUP_2_IDS = [
  4, 6, 7, 8, 9, 13, 14, 16, 18, 20, 21, 22, 23, 26, 36, 37, 40, 43, 44, 46,
  47, 48, 49, 50, 51, 52, 53, 54, 55, 57, 59, 64, 68, 70, 75, 77, 78, 81, 82,
  85, 88, 89, 92, 93, 95, 96, 97, 99, 100, 101, 103, 106, 112, 113, 114, 115,
  117, 122, 123, 124, 126, 127, 130, 131, 132, 135, 140, 141, 144, 145, 147,
  148, 155, 161, 162, 165, 167, 170, 175, 179, 184, 187, 204, 206, 211, 212,
  216, 220, 221, 224, 242, 243, 248, 256, 258, 260, 264, 275, 277, 279, 281,
  283, 284, 285, 291, 294, 311, 340, 344, 350, 355, 422, 478, 503, 554, 566,
  917, 1133, 1189, 1448, 1473, 1560, 1597,
];

// ---------------------------------------------------------------------------
// Image processing helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  const map: Record<string, string> = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
  };
  return name.toLowerCase()
    .split("").map((c) => map[c] ?? c).join("")
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "_");
}

function buildBasePath(id: number, name: string): string {
  return `${id}_${sanitizeFilename(name)}`;
}

function convertToWebP(bytes: Uint8Array): Uint8Array {
  return ImageMagick.read(bytes, (img): Uint8Array => {
    const MAX = 1200;
    if (img.width > MAX || img.height > MAX) {
      const geo = new MagickGeometry(MAX, MAX);
      geo.ignoreAspectRatio = false;
      img.resize(geo);
    }
    const m = img as unknown as { strip?: () => void; quality?: number };
    if (typeof m.strip === "function") m.strip();
    m.quality = 82;
    return img.write(MagickFormat.WebP, (data) => data.slice());
  });
}

function resizeToWebP(bytes: Uint8Array, size: number): Uint8Array {
  const geo = new MagickGeometry(size, size);
  geo.ignoreAspectRatio = false;
  return ImageMagick.read(bytes, (img): Uint8Array => {
    img.resize(geo);
    const m = img as unknown as { strip?: () => void; quality?: number };
    if (typeof m.strip === "function") m.strip();
    m.quality = 82;
    return img.write(MagickFormat.WebP, (data) => data.slice());
  });
}

async function fetchSourceImage(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { Accept: "image/png, image/jpeg, image/gif, image/svg+xml, image/bmp" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SOURCE_SIZE) {
    throw new Error(`Source image too large: ${Math.round(contentLength / 1024)}KB`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function uploadWithVariants(
  canonicalBytes: Uint8Array,
  basePath: string,
): Promise<string> {
  const webpBytes = convertToWebP(canonicalBytes);
  const mainPath = `${basePath}.webp`;

  const { error: mainErr } = await supabase.storage
    .from(BUCKET)
    .upload(mainPath, webpBytes, { contentType: "image/webp", cacheControl: "31536000", upsert: true });
  if (mainErr) throw new Error(`Upload canonical failed: ${mainErr.message}`);

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(mainPath);

  for (const size of VARIANT_SIZES) {
    const variantBytes = resizeToWebP(webpBytes, size);
    const variantPath = `${basePath}-${size}w.webp`;
    const { error: varErr } = await supabase.storage
      .from(BUCKET)
      .upload(variantPath, variantBytes, { contentType: "image/webp", cacheControl: "31536000", upsert: true });
    if (varErr) throw new Error(`Upload ${size}w failed: ${varErr.message}`);
  }

  return urlData.publicUrl;
}

async function uploadVariantsOnly(
  canonicalBytes: Uint8Array,
  basePath: string,
): Promise<void> {
  for (const size of VARIANT_SIZES) {
    const variantBytes = resizeToWebP(canonicalBytes, size);
    const variantPath = `${basePath}-${size}w.webp`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(variantPath, variantBytes, { contentType: "image/webp", cacheControl: "31536000", upsert: true });
    if (error) throw new Error(`Upload ${size}w failed: ${error.message}`);
  }
}

/** Extract the storage object key from a public storage URL. */
function storageKeyFromUrl(publicUrl: string): string {
  const marker = `/roaster_logo_mirrors/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) throw new Error(`Cannot parse storage key from: ${publicUrl}`);
  return publicUrl.slice(idx + marker.length).replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// Group 1 — full download + convert + upload + DB update
// ---------------------------------------------------------------------------

console.log(`\n=== Group 1: ${GROUP_1_IDS.length} roasters needing full mirror ===`);

const { data: g1Roasters, error: g1Err } = await supabase
  .from("coffee_roasters")
  .select("id, roaster_name, roaster_logo_url")
  .in("id", GROUP_1_IDS);

if (g1Err) { console.error("Failed to query group 1:", g1Err.message); Deno.exit(1); }

let g1Success = 0, g1Failed = 0;

for (const roaster of g1Roasters ?? []) {
  try {
    const bytes = await fetchSourceImage(roaster.roaster_logo_url);
    const basePath = buildBasePath(roaster.id, roaster.roaster_name);
    const publicUrl = await uploadWithVariants(bytes, basePath);

    const { error: dbErr } = await supabase
      .from("coffee_roasters")
      .update({ roaster_logo_mirror_url: publicUrl })
      .eq("id", roaster.id);
    if (dbErr) throw new Error(`DB update failed: ${dbErr.message}`);

    console.log(`  ✓ [${roaster.id}] ${roaster.roaster_name}`);
    g1Success++;
  } catch (err) {
    console.error(`  ✗ [${roaster.id}] ${roaster.roaster_name}: ${err instanceof Error ? err.message : err}`);
    g1Failed++;
  }
}

// ---------------------------------------------------------------------------
// Group 2 — variant-only from stored canonical; fallback to source URL
// ---------------------------------------------------------------------------

console.log(`\n=== Group 2: ${GROUP_2_IDS.length} roasters needing variants ===`);

const { data: g2Roasters, error: g2Err } = await supabase
  .from("coffee_roasters")
  .select("id, roaster_name, roaster_logo_url, roaster_logo_mirror_url")
  .in("id", GROUP_2_IDS);

if (g2Err) { console.error("Failed to query group 2:", g2Err.message); Deno.exit(1); }

let g2Success = 0, g2Failed = 0, g2Fallback = 0;

for (const roaster of g2Roasters ?? []) {
  const mirrorUrl = roaster.roaster_logo_mirror_url as string;
  const storageKey = storageKeyFromUrl(mirrorUrl);
  const basePath = storageKey.replace(/\.(webp|png|jpg|jpeg)$/i, "");

  // Try reading from stored canonical
  try {
    const fetchRes = await fetch(mirrorUrl);
    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
    const canonicalBytes = new Uint8Array(await fetchRes.arrayBuffer());
    await uploadVariantsOnly(canonicalBytes, basePath);
    console.log(`  ✓ [${roaster.id}] ${roaster.roaster_name}`);
    g2Success++;
    continue;
  } catch (_err) {
    // Canonical is corrupt or fetch failed — fall back to source URL
  }

  // Fallback: re-download from original source, upload canonical + variants, update DB
  if (!roaster.roaster_logo_url) {
    console.error(`  ✗ [${roaster.id}] ${roaster.roaster_name}: corrupt canonical, no source URL`);
    g2Failed++;
    continue;
  }

  try {
    const bytes = await fetchSourceImage(roaster.roaster_logo_url);
    const publicUrl = await uploadWithVariants(bytes, basePath);

    // Update mirror URL since canonical was replaced with a fresh copy
    const { error: dbErr } = await supabase
      .from("coffee_roasters")
      .update({ roaster_logo_mirror_url: publicUrl })
      .eq("id", roaster.id);
    if (dbErr) throw new Error(`DB update failed: ${dbErr.message}`);

    console.log(`  ✓ [${roaster.id}] ${roaster.roaster_name} (fallback — canonical re-processed from source)`);
    g2Fallback++;
    g2Success++;
  } catch (err) {
    console.error(`  ✗ [${roaster.id}] ${roaster.roaster_name}: fallback failed — ${err instanceof Error ? err.message : err}`);
    g2Failed++;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results ===`);
console.log(`Group 1 (full mirror):   ${g1Success} succeeded, ${g1Failed} failed`);
console.log(`Group 2 (variants only): ${g2Success} succeeded (${g2Fallback} via source fallback), ${g2Failed} failed`);
console.log(`Total: ${g1Success + g2Success} succeeded, ${g1Failed + g2Failed} failed`);
