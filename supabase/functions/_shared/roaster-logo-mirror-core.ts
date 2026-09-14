/**
 * Shared roaster-logo mirroring pipeline.
 *
 * ONE implementation used by BOTH callers:
 *   - `roaster-logo-mirror/index.ts` (legacy database-webhook entry point,
 *     kept as a thin wrapper)
 *   - `roaster-postprocess-worker/index.ts` (durable job worker — the
 *     `mirror_logo` job kind)
 *
 * Hard-won behaviours preserved here — do not regress:
 *   1. The `Accept` header that prevents Shopify/other CDNs from negotiating
 *      VP8X WebP, which ImageMagick WASM 0.0.30 cannot decode.
 *   2. The `.slice()` copy out of WASM heap memory when writing WebP —
 *      without it the RIFF header is corrupted by free-list pointers.
 *   3. The 1200 px longest-edge cap and WebP quality 82.
 *   4. `sanitizeFilename` + `buildBasePath` (`{id}_{name}`) storage layout
 *      and the 96w/400w variants.
 *   5. `ImageFormatError` suppressing the admin error email (handled by the
 *      wrapper via `isExpectedDataQualityError`).
 *
 * New hardening (2026-09):
 *   - Pixel-count cap (16 Mpx) enforced from magic-byte headers BEFORE any
 *     decode. Compressed byte size does not protect the WASM heap: the
 *     2026-09-01 incidents were 220 KB / 686 KB sources decoding to 23.6 /
 *     42.8 Mpx and OOMing the function. See _shared/image-dimensions.ts.
 *   - The 3 MB byte cap is enforced on the declared content-length AND by
 *     reading the body with a bounded stream (a missing content-length used
 *     to mean "no check at all").
 *   - SVG/raster decision uses response content-type + magic bytes; a `.svg`
 *     URL suffix is only a tiebreaker for absent/generic content-types. A
 *     `.svg` URL serving PNG bytes is processed as PNG.
 *   - SVG mirrors additionally get a `{base}-raster.webp` working asset for
 *     variants and colour work. The current ImageMagick WASM build cannot
 *     rasterise SVG (no delegate — it shells out to a non-existent
 *     `inkscape`); the attempt is kept so the day the build supports SVG
 *     this starts working unchanged. The failure is surfaced as a typed
 *     error so the colour job fails VISIBLY instead of storing null.
 */

import {
  ImageMagick,
  MagickFormat,
  MagickGeometry,
} from "npm:@imagemagick/magick-wasm@0.0.30";
import {
  assertSupportedImageFormat,
  detectImageFormat,
  generateLogoVariants,
  ImageFormatError,
  UNSUPPORTED_MIME_TYPES,
  VARIANT_SIZES,
  type VariantSize,
  variantSuffix,
} from "./image-variants.ts";
import {
  assertWithinPixelCap,
  formatMegapixels,
  MAX_SOURCE_PIXELS,
  parseImageDimensions,
} from "./image-dimensions.ts";
import { ensureImageMagickReady } from "./magick-init.ts";
import { fetchWithTimeout } from "./fetch-with-timeout.ts";
import {
  DbError,
  HttpSourceError,
  ImageDecodeError,
  MalformedSourceError,
  SourceTimeoutError,
  SourceTooLargeError,
  StorageUploadError,
  SvgRasterizationUnsupportedError,
} from "./roaster-postprocess-errors.ts";

export const MIRROR_BUCKET = "roaster_logo_mirrors";
const SVG_CONTENT_TYPE = "image/svg+xml";

/** Existing hard cap on compressed source bytes. */
export const MAX_SOURCE_BYTES = 3_000_000;

/**
 * Timeout for the source-image fetch. The legacy code used a bare fetch with
 * no timeout; a hung CDN would eat the whole function budget.
 */
export const LOGO_FETCH_TIMEOUT_MS = 20_000;

/**
 * Filename suffix of the raster working asset produced for SVG sources.
 * Naming relationship: `{base}.svg` (verbatim mirror) + `{base}-raster.webp`
 * (rasterised working asset used for variants and colour extraction).
 */
export const RASTER_ASSET_SUFFIX = "-raster.webp";

/**
 * Prevent CDN content negotiation to WebP/AVIF — ImageMagick WASM 0.0.30
 * cannot decode VP8X extended WebP (served by Shopify CDN when Accept
 * includes image/webp). Deno's native fetch sends browser-like Accept
 * headers by default, triggering this behaviour.
 */
const ACCEPT_HEADER =
  "image/png, image/jpeg, image/gif, image/svg+xml, image/bmp";

// ---------------------------------------------------------------------------
// Storage path helpers (moved verbatim from roaster-logo-mirror)
// ---------------------------------------------------------------------------

/** Sanitise a roaster name to a safe filename fragment. */
export function sanitizeFilename(name: string): string {
  const transliterationMap: Record<string, string> = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ё": "yo",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "y",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "h",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "sch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
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
export function buildBasePath(
  roasterId: string | number,
  roasterName: string,
): string {
  return `${roasterId}_${sanitizeFilename(roasterName)}`;
}

// ---------------------------------------------------------------------------
// Format decision: content-type + magic bytes beat the URL suffix
// ---------------------------------------------------------------------------

export type AssetDecision =
  | { kind: "svg" }
  | { kind: "raster" }
  | {
    kind: "unsupported";
    reason: "html_response" | "unsupported_format";
    message: string;
  };

/** True when bytes look like SVG markup (optional BOM/ws, then `<svg` near the head). */
export function looksLikeSvgText(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, 1024),
  ).replace(/^﻿/, "").trimStart();
  if (!head.startsWith("<")) return false;
  return /<svg[\s>]/i.test(head.slice(0, 1024));
}

function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isGenericContentType(contentType: string | null): boolean {
  return contentType === null || contentType === "" ||
    contentType === "application/octet-stream";
}

/**
 * Decide what kind of asset the response actually is.
 *
 * Precedence (inverted from the legacy `issvgUrl`, which trusted the URL
 * suffix first): magic bytes and the response content-type decide; the
 * `.svg` suffix is only a tiebreaker when the content-type is absent or
 * generic (`application/octet-stream`).
 *
 *   `.svg` URL serving PNG bytes  → raster PNG
 *   `.png` URL serving image/svg+xml or SVG text → svg
 */
export function decideAssetKind(
  url: string,
  contentType: string | null,
  bytes: Uint8Array,
): AssetDecision {
  const fmt = detectImageFormat(bytes); // null when unrecognised

  // 1. Known raster magic bytes win over everything.
  if (
    fmt === "jpeg" || fmt === "png" || fmt === "webp" || fmt === "gif" ||
    fmt === "bmp"
  ) {
    return { kind: "raster" };
  }

  const lowerContentType = contentType?.toLowerCase() ?? "";

  // 2. Actual SVG markup in the bytes.
  if (looksLikeSvgText(bytes)) return { kind: "svg" };

  // 3. Authoritative SVG content-type.
  if (lowerContentType.includes("image/svg")) return { kind: "svg" };

  // 4. Non-SVG "<" text is an HTML error page (auth-gated CDN, expired link).
  if (fmt === "html") {
    return {
      kind: "unsupported",
      reason: "html_response",
      message:
        "URL returned HTML — server requires authentication or the URL has expired",
    };
  }

  // 5. Definitively unsupported media (AVIF/HEIC by type or by ISOBMFF magic).
  if (UNSUPPORTED_MIME_TYPES.has(lowerContentType)) {
    return {
      kind: "unsupported",
      reason: "unsupported_format",
      message:
        `Unsupported content-type '${contentType}' — update the source URL`,
    };
  }
  if (fmt === "avif" || fmt === "isobmff") {
    return {
      kind: "unsupported",
      reason: "unsupported_format",
      message:
        "AVIF/HEIC format is not supported in this WASM build — use a JPEG or PNG source URL",
    };
  }

  // 6. Tiebreaker only: `.svg` suffix with absent/generic content-type.
  if (
    urlPathname(url).toLowerCase().endsWith(".svg") &&
    isGenericContentType(contentType)
  ) {
    return { kind: "svg" };
  }

  // Unknown binary — let the decoder try (a garbage source surfaces as a
  // terminal decode_failed rather than being silently stored).
  return { kind: "raster" };
}

// ---------------------------------------------------------------------------
// Encoders (require ensureImageMagickReady() to have resolved first)
// ---------------------------------------------------------------------------

/** Convert raw image bytes to WebP, stripping metadata and capping at 1200px. */
export function convertToWebP(imageBytes: Uint8Array): Uint8Array {
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
    const mutable = image as unknown as {
      strip?: () => void;
      quality?: number;
    };
    if (typeof mutable.strip === "function") mutable.strip();
    mutable.quality = 82;
    // Slice copies the bytes out of WASM heap memory before it's freed.
    // Without the copy, the first 8 bytes of the RIFF container header get
    // overwritten with WASM free-list pointers, producing an invalid WebP file.
    return image.write(MagickFormat.WebP, (data) => data.slice());
  });
}

/**
 * Rasterise SVG bytes to the WebP working asset.
 *
 * NOTE (verified 2026-09-14): ImageMagick WASM 0.0.30 has NO working SVG
 * coder — `read()` on SVG bytes fails with
 * `FailedToExecuteCommand 'inkscape' ... (-1)` because the build delegates
 * SVG to an external inkscape binary that does not exist in Supabase Edge
 * Runtime (or anywhere in this stack). The call is kept intentionally: if a
 * future WASM build bundles a real SVG coder, this starts working with no
 * code change. Until then this throws SvgRasterizationUnsupportedError, which
 * the pipeline and the colour job surface as a TERMINAL
 * `svg_rasterization_unsupported` failure instead of a silently-null colour.
 */
export function rasterizeSvgToWebP(svgBytes: Uint8Array): Uint8Array {
  try {
    return convertToWebP(svgBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SvgRasterizationUnsupportedError(
      `SVG rasterisation is unavailable in ImageMagick WASM 0.0.30 (no SVG delegate in this build): ${message}`,
    );
  }
}

/** Real ImageMagick encode functions wired into `mirrorRoasterLogo`. */
export const realImageEncoders: ImageEncoders = {
  webp: convertToWebP,
  rasterizeSvg: rasterizeSvgToWebP,
  variants: generateLogoVariants,
};

export interface ImageEncoders {
  webp(imageBytes: Uint8Array): Uint8Array;
  rasterizeSvg(svgBytes: Uint8Array): Uint8Array;
  /** 96w/400w variant generation from already-optimised WebP bytes. */
  variants(imageBytes: Uint8Array): Map<VariantSize, Uint8Array>;
}

// ---------------------------------------------------------------------------
// Guarded source fetch
// ---------------------------------------------------------------------------

export interface FetchedLogo {
  bytes: Uint8Array;
  contentType: string | null;
}

/**
 * Cancel an unconsumed response body before throwing. This releases the
 * connection AND clears fetchWithTimeout's abort timer (its cancel hook runs
 * the timer cleanup), which would otherwise stay armed for the full timeout.
 */
async function cancelBodyQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // best effort — the original error is more important
  }
}

/**
 * Fetch a logo/mirror source with all guards applied:
 *   - anti-negotiation Accept header;
 *   - terminal ImageFormatError for AVIF/HEIC content-types (pre-download);
 *   - 3 MB byte cap enforced on declared content-length AND on the actual
 *     streamed body (a missing content-length used to mean "no check";
 *     chunked responses could OOM the isolate before any check ran).
 */
export async function fetchLogoWithGuards(url: string): Promise<FetchedLogo> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers: { Accept: ACCEPT_HEADER } },
      LOGO_FETCH_TIMEOUT_MS,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Request timeout after ")
    ) {
      throw new SourceTimeoutError(error.message);
    }
    throw error; // network errors surface as TypeError — classified retryable
  }

  if (!response.ok) {
    await cancelBodyQuietly(response);
    throw new HttpSourceError(
      response.status,
      `Failed to fetch logo: HTTP ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type")
    ?.split(";")[0].trim() ?? null;

  // Reject unsupported MIME types before downloading the body.
  if (contentType && UNSUPPORTED_MIME_TYPES.has(contentType)) {
    await cancelBodyQuietly(response);
    throw new ImageFormatError(
      `Unsupported content-type '${contentType}' — update the source URL`,
    );
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
      await cancelBodyQuietly(response);
      throw new SourceTooLargeError(
        `Source image too large: declared ${declaredLength} bytes exceeds ${MAX_SOURCE_BYTES} byte cap — replace roaster_logo_url`,
      );
    }
  }
  // content-length absent or unparseable → unknown, must measure while reading.

  const reader = response.body?.getReader();
  if (!reader) {
    throw new HttpSourceError(response.status, "Logo response has no body");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new SourceTooLargeError(
        `Source image too large: body exceeded ${MAX_SOURCE_BYTES} byte cap while streaming (declared content-length: ${
          declaredLength ?? "absent"
        }) — replace roaster_logo_url`,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, contentType };
}

// ---------------------------------------------------------------------------
// Dependency interfaces (injected so unit tests need no DB / storage / fetch)
// ---------------------------------------------------------------------------

export interface MirrorCoreLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface MirrorStorageDeps {
  uploadObject(
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  getPublicUrl(path: string): string;
}

export interface MirrorDbDeps {
  updateRoasterMirrorUrl(
    roasterId: string | number,
    url: string,
  ): Promise<void>;
}

export interface MirrorCoreDeps extends MirrorStorageDeps, MirrorDbDeps {
  fetchLogo(url: string): Promise<FetchedLogo>;
  encoders: ImageEncoders;
  logger: MirrorCoreLogger;
  /**
   * ImageMagick initialisation (memoised singleton in production). Injected
   * so guards run — and unit tests execute — without touching the WASM
   * binary; entry points wire `ensureImageMagickReady` from magick-init.ts.
   */
  ensureReady(): Promise<void>;
}

export interface MirrorInput {
  roasterId: string | number;
  roasterName: string;
  logoUrl: string | null;
}

export interface MirrorResult {
  /** Public URL of the verbatim mirror (SVG) or canonical WebP (raster). */
  mirrorUrl: string;
  assetKind: "svg" | "raster";
  /** Storage path of the raster working asset, when one was produced. */
  rasterAssetPath: string | null;
  /** Non-null when the SVG raster working asset could not be produced. */
  rasterWarning: string | null;
}

function wrapUploadError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new StorageUploadError(
    `Storage upload failed: ${message}`,
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Download, validate, and store a roaster logo together with all size
 * variants. Throws typed errors (see roaster-postprocess-errors.ts) —
 * callers decide about emails / job-finish classification.
 *
 * Storage layout in `roaster_logo_mirrors` bucket:
 *   {id}_{name}.webp            ← canonical URL stored in coffee_roasters
 *   {id}_{name}-96w.webp        ← 96 px variant  (catalog cards)
 *   {id}_{name}-400w.webp       ← 400 px variant (detail page)
 * SVG sources:
 *   {id}_{name}.svg             ← verbatim mirror (mirror URL points here)
 *   {id}_{name}-raster.webp     ← raster working asset (+ same variants)
 *                                 when the WASM build can rasterise SVG
 */
export async function mirrorRoasterLogo(
  deps: MirrorCoreDeps,
  input: MirrorInput,
): Promise<MirrorResult> {
  const { roasterId, roasterName, logoUrl } = input;

  if (!logoUrl || !isValidHttpUrl(logoUrl)) {
    throw new MalformedSourceError(
      `Malformed or absent roaster_logo_url for roaster ${roasterId} — replace the source URL`,
    );
  }

  const { bytes, contentType } = await deps.fetchLogo(logoUrl);

  // Pixel-count cap BEFORE decode — the only reliable OOM guard, because
  // compressed byte size does not bound decoded pixels (see module docs).
  const dims = parseImageDimensions(bytes);
  if (dims && dims.width * dims.height > MAX_SOURCE_PIXELS) {
    throw new SourceTooLargeError(
      `source_too_large: ${dims.width}x${dims.height} (${
        formatMegapixels(dims.width * dims.height)
      } Mpx) exceeds ${
        MAX_SOURCE_PIXELS / 1_000_000
      } Mpx cap — replace roaster_logo_url`,
    );
  }

  const basePath = buildBasePath(roasterId, roasterName);
  const decision = decideAssetKind(logoUrl, contentType, bytes);

  if (decision.kind === "unsupported") {
    throw new ImageFormatError(decision.message);
  }

  // ImageMagick is only needed once we are about to encode — guard failures
  // above must not require (or pay for) WASM initialisation.
  await deps.ensureReady();

  if (decision.kind === "svg") {
    return mirrorSvgAsset(deps, {
      roasterId,
      roasterName,
      basePath,
      bytes,
    });
  }

  return mirrorRasterAsset(deps, {
    roasterId,
    roasterName,
    basePath,
    bytes,
  });
}

async function mirrorSvgAsset(
  deps: MirrorCoreDeps,
  ctx: {
    roasterId: string | number;
    roasterName: string;
    basePath: string;
    bytes: Uint8Array;
  },
): Promise<MirrorResult> {
  const { basePath, bytes, roasterId, roasterName } = ctx;
  const svgPath = `${basePath}.svg`;
  try {
    await deps.uploadObject(svgPath, bytes, SVG_CONTENT_TYPE);
  } catch (error) {
    wrapUploadError(error);
  }

  // Raster working asset for variants + colour work. On the current WASM
  // build this always fails (no SVG delegate); the mirror itself is still
  // correct and complete, so the job succeeds with a logged warning and the
  // colour job fails VISIBLY with terminal `svg_rasterization_unsupported`
  // when it finds no raster asset — never a silently-null colour.
  let rasterAssetPath: string | null = null;
  let rasterWarning: string | null = null;
  try {
    const rasterBytes = deps.encoders.rasterizeSvg(bytes);
    rasterAssetPath = `${basePath}${RASTER_ASSET_SUFFIX}`;
    try {
      await deps.uploadObject(rasterAssetPath, rasterBytes, "image/webp");
    } catch (error) {
      wrapUploadError(error);
    }
    await uploadVariants(deps, rasterBytes, basePath, roasterName);
  } catch (error) {
    rasterWarning = error instanceof Error ? error.message : String(error);
    deps.logger.warn("SVG raster working asset could not be produced", {
      roaster_id: roasterId,
      roaster_name: roasterName,
      path: svgPath,
      reason: rasterWarning,
    });
  }

  const mirrorUrl = deps.getPublicUrl(svgPath);
  try {
    await deps.updateRoasterMirrorUrl(roasterId, mirrorUrl);
  } catch (error) {
    throw asDbError(error);
  }

  deps.logger.info("Stored SVG logo", {
    roaster_id: roasterId,
    roaster_name: roasterName,
    path: svgPath,
    raster_asset: rasterAssetPath,
  });
  return { mirrorUrl, assetKind: "svg", rasterAssetPath, rasterWarning };
}

async function mirrorRasterAsset(
  deps: MirrorCoreDeps,
  ctx: {
    roasterId: string | number;
    roasterName: string;
    basePath: string;
    bytes: Uint8Array;
  },
): Promise<MirrorResult> {
  const { basePath, bytes, roasterId, roasterName } = ctx;
  // Validate magic bytes before passing to ImageMagick (catches leftovers the
  // decision step let through, e.g. unrecognised binary) — same semantics as
  // the legacy pipeline.
  assertSupportedImageFormat(bytes);
  assertWithinPixelCap(bytes); // redundant with the pre-decode check; cheap belt-and-braces

  let webpBytes: Uint8Array;
  try {
    webpBytes = deps.encoders.webp(bytes);
  } catch (error) {
    if (error instanceof SvgRasterizationUnsupportedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageDecodeError(
      `ImageMagick failed to decode source: ${message}`,
    );
  }

  const mainPath = `${basePath}.webp`;
  try {
    await deps.uploadObject(mainPath, webpBytes, "image/webp");
  } catch (error) {
    wrapUploadError(error);
  }

  // Size variants are non-fatal — the main logo is already stored.
  await uploadVariants(deps, webpBytes, basePath, roasterName);

  const mirrorUrl = deps.getPublicUrl(mainPath);
  try {
    await deps.updateRoasterMirrorUrl(roasterId, mirrorUrl);
  } catch (error) {
    throw asDbError(error);
  }

  deps.logger.info("Successfully processed raster logo", {
    roaster_id: roasterId,
    roaster_name: roasterName,
    path: mainPath,
  });
  return {
    mirrorUrl,
    assetKind: "raster",
    rasterAssetPath: null,
    rasterWarning: null,
  };
}

/** Upload the 96w/400w variants. Failures are logged, never fatal. */
async function uploadVariants(
  deps: MirrorCoreDeps,
  webpBytes: Uint8Array,
  basePath: string,
  roasterName: string,
): Promise<void> {
  const variants = deps.encoders.variants(webpBytes);
  for (const size of VARIANT_SIZES) {
    const variantBytes = variants.get(size)!;
    const variantPath = `${basePath}${variantSuffix(size)}.webp`;
    try {
      await deps.uploadObject(variantPath, variantBytes, "image/webp");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(
        `Failed to upload ${size}px variant for ${roasterName}: ${message}`,
        { roaster_name: roasterName, path: variantPath },
      );
    }
  }
}

/**
 * DB failures inside the pipeline are retryable — re-wrap plain errors as
 * DbError so the worker classifies them as `db_error` instead of
 * `unknown_error`.
 */
function asDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DbError(message);
}
