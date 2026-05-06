/**
 * Shared logo variant generation helpers.
 *
 * IMPORTANT: ImageMagick must be initialised in the calling edge function
 * before any of these helpers are invoked. Initialisation is not done here
 * so that the WASM binary is only loaded once per function cold-start.
 *
 * Usage pattern in each edge function:
 *   import { generateLogoVariants, VARIANT_SIZES } from "../_shared/image-variants.ts";
 *   // ... initialise ImageMagick at module level ...
 *   const variants = generateLogoVariants(optimizedBytes);
 */

import {
  ImageMagick,
  MagickFormat,
  MagickGeometry,
} from "npm:@imagemagick/magick-wasm@0.0.30";

/** Canonical variant sizes (px, longest edge). */
export const VARIANT_SIZES = [96, 400] as const;
export type VariantSize = (typeof VARIANT_SIZES)[number];

/**
 * Resize `imageBytes` so its longest edge is at most `size` pixels,
 * preserving aspect ratio. Strips metadata and encodes as WebP.
 *
 * Does NOT upscale: if the source is already smaller than `size` in both
 * dimensions ImageMagick will leave it untouched (MagickGeometry without
 * Greater/Less flags is a "fit within" constraint, so very small images
 * are passed through as-is at their original size).
 */
export function resizeToWebP(
  imageBytes: Uint8Array,
  size: number,
  quality = 82,
): Uint8Array {
  const geometry = new MagickGeometry(size, size);
  geometry.ignoreAspectRatio = false;

  return ImageMagick.read(imageBytes, (image): Uint8Array => {
    image.resize(geometry);

    const mutable = image as unknown as {
      strip?: () => void;
      quality?: number;
    };
    if (typeof mutable.strip === "function") mutable.strip();
    mutable.quality = quality;

    // Slice copies the bytes out of WASM heap memory before it's freed.
    // Without the copy, the first 8 bytes of the RIFF container header get
    // overwritten with WASM free-list pointers, producing an invalid WebP file.
    return image.write(MagickFormat.WebP, (data) => data.slice());
  });
}

/**
 * Generate all standard logo variants from already-optimised WebP bytes.
 * Returns a `Map<size, webpBytes>` for each size in `VARIANT_SIZES`.
 */
export function generateLogoVariants(
  imageBytes: Uint8Array,
): Map<VariantSize, Uint8Array> {
  const variants = new Map<VariantSize, Uint8Array>();
  for (const size of VARIANT_SIZES) {
    variants.set(size, resizeToWebP(imageBytes, size));
  }
  return variants;
}

/**
 * Map a variant size to its filename suffix.
 * e.g. 96 → "-96w", 400 → "-400w"
 */
export function variantSuffix(size: VariantSize): string {
  return `-${size}w`;
}

// ---------------------------------------------------------------------------
// Image format detection & validation
// ---------------------------------------------------------------------------

/**
 * Thrown when an image URL returns a format that is predictably unsupported
 * (AVIF/HEIC, HTML responses from auth-gated CDNs, etc.).
 * These errors are expected data-quality issues and do NOT warrant an admin alert.
 */
export class ImageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFormatError";
  }
}

/**
 * Detect the raster image format from the leading bytes of the file.
 * Returns a lowercase format name, "html" for non-image text responses,
 * or null if the format is unrecognised.
 */
export function detectImageFormat(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "jpeg";
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "png";
  // WebP: RIFF????WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  // GIF: GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  // AVIF / HEIC / HEIF — ISO Base Media File Format (bytes 4–7 = "ftyp")
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (["avif", "avis", "heic", "heif", "mif1", "msf1"].includes(brand)) return "avif";
    return "isobmff"; // other ISO BMFF container — not safe for ImageMagick
  }
  // BMP: BM
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return "bmp";
  // HTML / XML / text (starts with "<", possibly after whitespace)
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 128));
  if (head.trimStart().startsWith("<")) return "html";

  return null;
}

/**
 * Throw an `ImageFormatError` if `bytes` are not a supported raster format
 * that ImageMagick WASM can decode safely.
 *
 * NOTE: Callers must handle SVG separately (via content-type / URL extension)
 * *before* invoking this — SVG bytes also start with "<" and would be
 * misclassified as HTML.
 */
export function assertSupportedImageFormat(bytes: Uint8Array): void {
  const fmt = detectImageFormat(bytes);
  if (fmt === "html") {
    throw new ImageFormatError(
      "URL returned HTML — server requires authentication or the URL has expired",
    );
  }
  if (fmt === "avif" || fmt === "isobmff") {
    throw new ImageFormatError(
      "AVIF/HEIC format is not supported in this WASM build — use a JPEG or PNG source URL",
    );
  }
  if (fmt !== null && !["jpeg", "png", "webp", "gif", "bmp"].includes(fmt)) {
    throw new ImageFormatError(`Unsupported image format detected: ${fmt}`);
  }
  // fmt === null: unknown binary — let ImageMagick attempt decoding
}

/**
 * Content-Type values that are definitively unsupported.
 * Check these *before* downloading the response body to avoid wasting bandwidth.
 */
export const UNSUPPORTED_MIME_TYPES = new Set([
  "image/avif",
  "image/heic",
  "image/heif",
]);
