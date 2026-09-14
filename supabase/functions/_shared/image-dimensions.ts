/**
 * Header-only intrinsic image dimension parsing.
 *
 * Roaster logo post-processing must NEVER fully decode an oversized source in
 * the ImageMagick WASM heap: compressed byte size does not protect it (the
 * 2026-09-01 failures were 220 KB / 686 KB sources that decoded to
 * 8000x2954 and 6543x6543 pixels and OOMed the Edge Function). This module
 * reads just the magic-byte headers to get width/height so callers can
 * enforce a pixel cap BEFORE handing bytes to a decoder.
 *
 * All parsing is offset arithmetic on a Uint8Array (no DataView) so it is
 * safe on subarrays of any byte offset.
 */

import { SourceTooLargeError } from "./roaster-postprocess-errors.ts";

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Pixel-count cap enforced BEFORE decode.
 *
 * 16 Mpx, deliberately NOT 25 Mpx: the two known production failures decode
 * to 23.6 Mpx (8000x2954, 220 KB compressed) and 42.8 Mpx (6543x6543, 686 KB
 * compressed) — a 25 Mpx cap would have admitted the first one. WASM-heap
 * cost scales with DECODED pixels, not compressed bytes (~4 bytes/pixel raw
 * RGBA before ImageMagick's internal copies), so only a pre-decode pixel
 * count is a reliable guard. 16 Mpx still admits any plausible logo: it
 * allows a 4000x4000 source (11x the 1200 px longest-edge output cap) while
 * rejecting both known failures with ~1.5x headroom below the smaller one.
 */
export const MAX_SOURCE_PIXELS = 16_000_000;

/** "42.8" for 42_800_000 pixels — used in terminal error messages. */
export function formatMegapixels(totalPixels: number): string {
  return (totalPixels / 1_000_000).toFixed(1);
}

/**
 * Throw a terminal SourceTooLargeError if the (header-parsed) intrinsic
 * dimensions exceed MAX_SOURCE_PIXELS. Null dimensions (unparseable header)
 * pass through — the byte cap and the decoder still bound the damage.
 */
export function assertWithinPixelCap(bytes: Uint8Array): void {
  const dims = parseImageDimensions(bytes);
  if (!dims) return;
  const total = dims.width * dims.height;
  if (total > MAX_SOURCE_PIXELS) {
    throw new SourceTooLargeError(
      `source_too_large: ${dims.width}x${dims.height} (${
        formatMegapixels(total)
      } Mpx) exceeds ${
        MAX_SOURCE_PIXELS / 1_000_000
      } Mpx cap — replace roaster_logo_url`,
    );
  }
}

/**
 * Parse intrinsic dimensions from the leading bytes of PNG, JPEG, GIF, WebP
 * (VP8 / VP8L / VP8X) and BMP images without any decoding.
 *
 * Returns null when the format is unrecognised or the header is truncated
 * — never throws.
 */
export function parseImageDimensions(
  bytes: Uint8Array,
): ImageDimensions | null {
  if (bytes.length >= 24 && isPng(bytes)) return parsePngIhdr(bytes);
  if (bytes.length >= 4 && isJpeg(bytes)) return parseJpegSof(bytes);
  if (bytes.length >= 10 && isGif(bytes)) return parseGifLsd(bytes);
  if (bytes.length >= 16 && isWebp(bytes)) return parseWebpChunk(bytes);
  if (bytes.length >= 26 && isBmp(bytes)) return parseBmpDib(bytes);
  return null;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>> 0
  );
}

function readI32LE(bytes: Uint8Array, offset: number): number {
  return readU32LE(bytes, offset) | 0;
}

// --- PNG ---------------------------------------------------------------------

/** PNG signature: 89 50 4E 47 0D 0A 1A 0A */
function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E &&
    bytes[3] === 0x47 && bytes[4] === 0x0D && bytes[5] === 0x0A &&
    bytes[6] === 0x1A && bytes[7] === 0x0A;
}

/**
 * IHDR is mandated to be the first chunk: 4-byte length + "IHDR", then
 * width (u32 BE at 16) and height (u32 BE at 20).
 */
function parsePngIhdr(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null; // first chunk is not IHDR — malformed
  }
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

// --- JPEG --------------------------------------------------------------------

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}

/**
 * Walk the segment chain until a Start-Of-Frame marker (SOF0..SOF15, minus
 * DHT/JPG/DAC which share the range) and read its 16-bit height/width.
 * Dimensions live in the first frames of any normal file; the scan is capped
 * so a malformed stream cannot make us traverse megabytes.
 */
function parseJpegSof(bytes: Uint8Array): ImageDimensions | null {
  const SCAN_LIMIT = 1 << 20; // 1 MiB is far beyond any legitimate header
  let offset = 2;
  while (offset + 4 <= bytes.length && offset < SCAN_LIMIT) {
    if (bytes[offset] !== 0xFF) {
      offset += 1; // tolerate non-marker garbage between segments
      continue;
    }
    // Collapse any run of 0xFF fill bytes before the marker.
    while (offset < bytes.length && bytes[offset] === 0xFF) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    // Standalone markers with no length field (TEM, RST0-7).
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2) return null; // malformed; avoid infinite loops
    const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 &&
      marker !== 0xC8 && marker !== 0xCC;
    if (isSof) {
      if (offset + 7 > bytes.length) return null; // truncated header
      // Segment: length(2) precision(1) height(2) width(2) ...
      const height = readU16BE(bytes, offset + 3);
      const width = readU16BE(bytes, offset + 5);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    offset += segmentLength;
  }
  return null;
}

// --- GIF ---------------------------------------------------------------------

/** GIF87a / GIF89a */
function isGif(bytes: Uint8Array): boolean {
  return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
}

/** Logical screen descriptor: width/height u16 LE at offsets 6 and 8. */
function parseGifLsd(bytes: Uint8Array): ImageDimensions | null {
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

// --- WebP --------------------------------------------------------------------

/** RIFF????WEBP */
function isWebp(bytes: Uint8Array): boolean {
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 &&
    bytes[10] === 0x42 && bytes[11] === 0x50;
}

/** First chunk fourcc at offset 12 decides the sub-format. */
function parseWebpChunk(bytes: Uint8Array): ImageDimensions | null {
  const fourcc = String.fromCharCode(
    bytes[12],
    bytes[13],
    bytes[14],
    bytes[15],
  );
  // Payload of the first chunk starts at 20 (12 + fourcc(4) + size(4)).
  if (fourcc === "VP8 ") {
    // Lossy: frame tag(3) + start code 9D 01 2A + width/height u16 LE with
    // the value in the low 14 bits.
    if (bytes.length < 30) return null;
    if (
      bytes[23] !== 0x9D || bytes[24] !== 0x01 || bytes[25] !== 0x2A
    ) {
      return null;
    }
    const width = readU16LE(bytes, 26) & 0x3FFF;
    const height = readU16LE(bytes, 28) & 0x3FFF;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }
  if (fourcc === "VP8L") {
    // Lossless: signature 0x2F then 4 bytes packing (width-1, height-1)
    // as two 14-bit fields, little-endian bit order.
    if (bytes.length < 25) return null;
    if (bytes[20] !== 0x2F) return null;
    const bits = readU32LE(bytes, 21);
    const width = (bits & 0x3FFF) + 1;
    const height = ((bits >>> 14) & 0x3FFF) + 1;
    return { width, height };
  }
  if (fourcc === "VP8X") {
    // Extended: flags(1) reserved(3) canvas-width-1 u24 LE canvas-height-1 u24 LE.
    if (bytes.length < 30) return null;
    const width = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const height = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    if (width === 0 || height === 0) return null;
    return { width: width + 1, height: height + 1 };
  }
  return null; // unknown first chunk
}

// --- BMP ---------------------------------------------------------------------

function isBmp(bytes: Uint8Array): boolean {
  return bytes[0] === 0x42 && bytes[1] === 0x4D;
}

/** DIB header: width i32 LE at 18, height i32 LE at 22 (may be negative). */
function parseBmpDib(bytes: Uint8Array): ImageDimensions | null {
  const width = Math.abs(readI32LE(bytes, 18));
  const height = Math.abs(readI32LE(bytes, 22)); // negative = top-down row order
  if (width === 0 || height === 0) return null;
  return { width, height };
}
