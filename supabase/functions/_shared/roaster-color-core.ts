/**
 * Job-aware dominant-colour extraction for roaster mirror assets.
 *
 * ONE implementation used by BOTH callers:
 *   - `generate-roaster-dominant-color/index.ts` (legacy direct/webhook
 *     entry point, kept as a thin wrapper)
 *   - `roaster-postprocess-worker/index.ts` (the `extract_color` job kind)
 *
 * Behavioural contract (2026-09 hardening):
 *   - SVG-derived mirrors are processed via their raster working asset
 *     (`{base}-raster.webp`, produced by the mirror pipeline) — the legacy
 *     behaviour of returning a null colour for SVG assets is REMOVED.
 *   - null colour is SUCCESS only for the explicit, documented rule in
 *     `_shared/roaster-color.ts`: a fully transparent image (zero opaque
 *     pixels) has no representative colour. Anything else that prevents a
 *     colour is a typed failure: terminal when the asset is structurally
 *     unusable (SVG with no raster asset, HTML, unsupported format, decode
 *     failure, malformed URL), retryable for transient fetch/storage errors.
 */

import {
  ImageMagick,
  MagickFormat,
  MagickGeometry,
} from "npm:@imagemagick/magick-wasm@0.0.30";
import {
  DEFAULT_RESIZE_TO,
  extractRepresentativeColorHexFromRgba,
} from "./roaster-color.ts";
import {
  FetchedLogo,
  looksLikeSvgText,
  RASTER_ASSET_SUFFIX,
} from "./roaster-logo-mirror-core.ts";
import { assertWithinPixelCap } from "./image-dimensions.ts";
import {
  DbError,
  HttpSourceError,
  ImageDecodeError,
  MalformedSourceError,
  SvgRasterizationUnsupportedError,
} from "./roaster-postprocess-errors.ts";

export interface ColorCoreDeps {
  fetchAsset(url: string): Promise<FetchedLogo>;
  /**
   * Decode bytes to a representative colour. Returns null ONLY for the
   * documented "fully transparent" rule (see module docs).
   */
  decodeColor(bytes: Uint8Array): string | null;
  updateDominantColor(
    roasterId: string | number,
    hex: string | null,
  ): Promise<void>;
  /**
   * ImageMagick initialisation (memoised singleton in production, wired from
   * magick-init.ts). Injected so unit tests run without the WASM binary.
   */
  ensureReady(): Promise<void>;
}

export interface ColorInput {
  roasterId: string | number;
  /** coffee_roasters.roaster_logo_mirror_url — the extract_color revision. */
  mirrorUrl: string | null;
}

export interface ColorResult {
  color: string | null;
  colorReason: "extracted" | "fully_transparent";
}

/** True when the mirror URL points at an SVG asset (`{base}.svg`). */
export function isSvgMirrorUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".svg");
  } catch {
    return url.toLowerCase().includes(".svg");
  }
}

/**
 * Derive the raster working asset URL for an SVG mirror:
 * `https://…/{base}.svg` → `https://…/{base}-raster.webp`.
 * Returns null when the URL is not a `.svg` path.
 */
export function deriveRasterAssetUrl(svgUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(svgUrl);
  } catch {
    return null;
  }
  const pathname = parsed.pathname;
  if (!pathname.toLowerCase().endsWith(".svg")) return null;
  parsed.pathname = pathname.slice(0, -".svg".length) + RASTER_ASSET_SUFFIX;
  return parsed.toString();
}

function asDbError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DbError(message);
}

/**
 * Extract and persist the dominant colour for a roaster mirror asset.
 * Throws typed errors; callers classify them for the job ledger.
 */
export async function extractRoasterDominantColor(
  deps: ColorCoreDeps,
  input: ColorInput,
): Promise<ColorResult> {
  const { roasterId, mirrorUrl } = input;
  await deps.ensureReady();

  if (!mirrorUrl) {
    throw new MalformedSourceError(
      `extract_color for roaster ${roasterId} has no roaster_logo_mirror_url`,
    );
  }

  const svgDerived = isSvgMirrorUrl(mirrorUrl);
  const assetUrl = svgDerived ? deriveRasterAssetUrl(mirrorUrl) : mirrorUrl;
  if (assetUrl === null) {
    throw new MalformedSourceError(
      `Cannot derive colour asset URL from mirror URL '${mirrorUrl}'`,
    );
  }

  let fetched: FetchedLogo;
  try {
    fetched = await deps.fetchAsset(assetUrl);
  } catch (error) {
    // A 404 on the derived raster asset means the mirror pipeline could not
    // produce it (SVG rasterisation unsupported in this WASM build) — that is
    // the structural, terminal case, not a missing-object retry case.
    if (
      svgDerived && error instanceof HttpSourceError && error.status === 404
    ) {
      throw new SvgRasterizationUnsupportedError(
        `SVG mirror has no raster working asset (${RASTER_ASSET_SUFFIX}); SVG rasterisation is unsupported by ImageMagick WASM 0.0.30 — replace roaster_logo_url with a raster logo`,
      );
    }
    throw error;
  }

  // Defensive: a raster-derived mirror that unexpectedly serves SVG markup
  // (no derivable raster URL) must fail loudly, not store null.
  if (!svgDerived && looksLikeSvgText(fetched.bytes)) {
    throw new SvgRasterizationUnsupportedError(
      "Mirror asset is SVG markup but its URL does not expose a raster working asset — replace roaster_logo_url with a raster logo",
    );
  }

  // Cheap insurance: mirrors are produced ≤1200px, but legacy rows may not be.
  assertWithinPixelCap(fetched.bytes);

  let color: string | null;
  try {
    color = deps.decodeColor(fetched.bytes);
  } catch (error) {
    if (
      error instanceof SvgRasterizationUnsupportedError ||
      error instanceof MalformedSourceError
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ImageDecodeError(`Colour decode failed: ${message}`);
  }

  try {
    await deps.updateDominantColor(roasterId, color);
  } catch (error) {
    throw asDbError(error);
  }

  return {
    color,
    colorReason: color === null ? "fully_transparent" : "extracted",
  };
}

// ---------------------------------------------------------------------------
// Real decoder (wired by the entry points; stubbed in unit tests)
// ---------------------------------------------------------------------------

export function normalizeRawPixelsToRgba(
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
    `Unexpected RGBA payload size ${rawBytes.length}, expected ${
      DEFAULT_RESIZE_TO * DEFAULT_RESIZE_TO * 4
    }`,
  );
}

/**
 * Real colour decoder: downscale to 64x64, extract raw RGBA, and run the
 * shared representative-colour heuristic. Returns null only when the image
 * has zero opaque pixels (the documented fully-transparent rule).
 */
export function decodeColorWithImageMagick(bytes: Uint8Array): string | null {
  const resizeGeometry = new MagickGeometry(
    DEFAULT_RESIZE_TO,
    DEFAULT_RESIZE_TO,
  );
  resizeGeometry.ignoreAspectRatio = true;

  const rawPixelBytes = ImageMagick.read(bytes, (image): Uint8Array => {
    image.resize(resizeGeometry);
    return image.write(MagickFormat.Rgba, (data) => data);
  });
  const pixelCount = DEFAULT_RESIZE_TO * DEFAULT_RESIZE_TO;
  const rgbaBytes = normalizeRawPixelsToRgba(rawPixelBytes, pixelCount);

  return extractRepresentativeColorHexFromRgba(
    rgbaBytes,
    DEFAULT_RESIZE_TO,
    DEFAULT_RESIZE_TO,
  );
}
