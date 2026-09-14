import {
  formatMegapixels,
  MAX_SOURCE_PIXELS,
  parseImageDimensions,
} from "./image-dimensions.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// --- fixture builders (hand-constructed headers, in-memory only) ------------

function u16le(value: number): [number, number] {
  return [value & 0xFF, (value >>> 8) & 0xFF];
}

function u24le(value: number): [number, number, number] {
  return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF];
}

function u32be(value: number): [number, number, number, number] {
  return [
    (value >>> 24) & 0xFF,
    (value >>> 16) & 0xFF,
    (value >>> 8) & 0xFF,
    value & 0xFF,
  ];
}

function u32le(value: number): [number, number, number, number] {
  return [
    value & 0xFF,
    (value >>> 8) & 0xFF,
    (value >>> 16) & 0xFF,
    (value >>> 24) & 0xFF,
  ];
}

/** 26-byte PNG: signature + first-chunk IHDR with the given dimensions. */
function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A, // signature
    0x00,
    0x00,
    0x00,
    0x0D, // IHDR length
    0x49,
    0x48,
    0x44,
    0x52, // "IHDR"
    ...u32be(width),
    ...u32be(height),
    0x08,
    0x06,
    0x00,
    0x00,
    0x00, // bit depth, colour type, etc.
  ]);
  return bytes;
}

/** Minimal JPEG: SOI + APP0 filler + SOF0 segment carrying the dimensions. */
function jpegWithDimensions(
  width: number,
  height: number,
  sofMarker = 0xC0,
): Uint8Array {
  return new Uint8Array([
    0xFF,
    0xD8, // SOI
    0xFF,
    0xE0,
    0x00,
    0x10, // APP0, length 16
    ...Array.from({ length: 14 }, () => 0x00), // APP0 payload
    0xFF,
    sofMarker,
    0x00,
    0x11, // SOF0, length 17
    0x08, // precision
    ...u16leBigEndian(height),
    ...u16leBigEndian(width),
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01, // component spec
    0xFF,
    0xDA,
    0x00,
    0x04, // SOS (not parsed)
  ]);
}

function u16leBigEndian(value: number): [number, number] {
  return [(value >>> 8) & 0xFF, value & 0xFF];
}

function gifWithDimensions(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // "GIF89a"
    ...u16le(width),
    ...u16le(height),
    0xF0,
    0x00,
    0x00, // packed, background, aspect
  ]);
}

/** Lossy WebP (VP8): frame tag + start code + 14-bit-packed dimensions. */
function webpVp8WithDimensions(width: number, height: number): Uint8Array {
  // High two bits of each u16 are bookkeeping the parser must mask off.
  const packedWidth = (width & 0x3FFF) | (0x02 << 14);
  const packedHeight = (height & 0x3FFF) | (0x01 << 14);
  return new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    ...u32le(0x30),
    0x57,
    0x45,
    0x42,
    0x50, // "WEBP"
    0x56,
    0x50,
    0x38,
    0x20, // "VP8 "
    ...u32le(0x10), // chunk size
    0x30,
    0x01,
    0x00, // frame tag
    0x9D,
    0x01,
    0x2A, // start code
    ...u16le(packedWidth),
    ...u16le(packedHeight),
  ]);
}

/** Lossless WebP (VP8L): signature + 14-bit (size-1) fields. */
function webpVp8lWithDimensions(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    ...u32le(0x20),
    0x57,
    0x45,
    0x42,
    0x50,
    0x56,
    0x50,
    0x38,
    0x4C, // "VP8L"
    ...u32le(0x05),
    0x2F, // signature
    ...u32le(bits),
  ]);
}

/** Extended WebP (VP8X): 24-bit (canvas size - 1) fields. */
function webpVp8xWithDimensions(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    ...u32le(0x40),
    0x57,
    0x45,
    0x42,
    0x50,
    0x56,
    0x50,
    0x38,
    0x58, // "VP8X"
    ...u32le(0x18),
    0x10,
    0x00,
    0x00,
    0x00, // flags (1) + reserved (3)
    ...u24le(width - 1),
    ...u24le(height - 1),
  ]);
}

function bmpWithDimensions(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x42,
    0x4D, // "BM"
    ...u32le(0x46), // file size
    0x00,
    0x00,
    0x00,
    0x00, // reserved
    ...u32le(0x36), // pixel data offset
    ...u32le(0x28), // DIB header size (BITMAPINFOHEADER)
    ...u32le(width),
    ...u32le(height),
    0x01,
    0x00,
    0x20,
    0x00,
  ]);
}

// --- tests -------------------------------------------------------------------

Deno.test("parseImageDimensions reads PNG IHDR", () => {
  assertEquals(
    parseImageDimensions(pngWithDimensions(8000, 2954)),
    { width: 8000, height: 2954 },
    "PNG IHDR width/height are big-endian u32 at offset 16/20",
  );
  assertEquals(
    parseImageDimensions(pngWithDimensions(1, 1)),
    { width: 1, height: 1 },
    "1x1 PNG parses",
  );
});

Deno.test("parseImageDimensions reads JPEG SOF0, SOF2, and fill bytes", () => {
  assertEquals(
    parseImageDimensions(jpegWithDimensions(6543, 6543)),
    { width: 6543, height: 6543 },
    "baseline SOF0 parses",
  );
  assertEquals(
    parseImageDimensions(jpegWithDimensions(3200, 800, 0xC2)),
    { width: 3200, height: 800 },
    "progressive SOF2 parses",
  );
  const withFill = new Uint8Array([
    0xFF,
    0xD8,
    0xFF,
    0xFF,
    0xFF, // fill bytes before the marker
    ...jpegWithDimensions(200, 100).slice(2),
  ]);
  assertEquals(
    parseImageDimensions(withFill),
    { width: 200, height: 100 },
    "runs of 0xFF fill bytes are collapsed",
  );
});

Deno.test("parseImageDimensions reads GIF logical screen descriptor", () => {
  assertEquals(
    parseImageDimensions(gifWithDimensions(1234, 789)),
    { width: 1234, height: 789 },
    "GIF89a LSD width/height are little-endian u16 at offset 6/8",
  );
  const gif87a = new Uint8Array(gifWithDimensions(50, 60));
  gif87a[4] = 0x37;
  assertEquals(
    parseImageDimensions(gif87a),
    { width: 50, height: 60 },
    "GIF87a parses identically",
  );
});

Deno.test("parseImageDimensions reads WebP VP8, VP8L, and VP8X", () => {
  assertEquals(
    parseImageDimensions(webpVp8WithDimensions(8000, 2954)),
    { width: 8000, height: 2954 },
    "lossy VP8 14-bit fields are masked",
  );
  assertEquals(
    parseImageDimensions(webpVp8lWithDimensions(500, 300)),
    { width: 500, height: 300 },
    "lossless VP8L stores size-1 in two 14-bit fields",
  );
  assertEquals(
    parseImageDimensions(webpVp8xWithDimensions(8000, 2954)),
    { width: 8000, height: 2954 },
    "extended VP8X stores canvas size-1 in u24 LE fields",
  );
});

Deno.test("parseImageDimensions reads BMP and negative (top-down) heights", () => {
  assertEquals(
    parseImageDimensions(bmpWithDimensions(400, 300)),
    { width: 400, height: 300 },
    "BMP DIB width/height parse",
  );
  assertEquals(
    parseImageDimensions(bmpWithDimensions(400, -300)),
    { width: 400, height: 300 },
    "negative top-down BMP heights are absolute-valued",
  );
});

Deno.test("parseImageDimensions rejects truncated headers without throwing", () => {
  assertEquals(
    parseImageDimensions(pngWithDimensions(10, 10).slice(0, 18)),
    null,
    "PNG cut inside the IHDR payload",
  );
  assertEquals(
    parseImageDimensions(jpegWithDimensions(10, 10).slice(0, 12)),
    null,
    "JPEG cut before the SOF length field",
  );
  assertEquals(
    parseImageDimensions(gifWithDimensions(10, 10).slice(0, 9)),
    null,
    "GIF cut inside the logical screen descriptor",
  );
  assertEquals(
    parseImageDimensions(webpVp8WithDimensions(10, 10).slice(0, 24)),
    null,
    "WebP cut inside the VP8 header",
  );
  assertEquals(
    parseImageDimensions(webpVp8xWithDimensions(10, 10).slice(0, 28)),
    null,
    "VP8X cut inside the canvas fields",
  );
  assertEquals(
    parseImageDimensions(bmpWithDimensions(10, 10).slice(0, 20)),
    null,
    "BMP cut inside the DIB header",
  );
  assertEquals(
    parseImageDimensions(new Uint8Array([0x12, 0x34, 0x56])),
    null,
    "random bytes",
  );
  assertEquals(
    parseImageDimensions(new Uint8Array(0)),
    null,
    "empty input",
  );
});

Deno.test("MAX_SOURCE_PIXELS rejects both known production failures", () => {
  const knownFailures = [
    { width: 8000, height: 2954, label: "220 KB source #1" },
    { width: 6543, height: 6543, label: "686 KB source #2" },
  ];
  for (const failure of knownFailures) {
    const total = failure.width * failure.height;
    if (total <= MAX_SOURCE_PIXELS) {
      throw new Error(
        `${failure.label} (${total} px) must exceed the cap — the cap is too loose`,
      );
    }
  }
  // ...but admits a 4000x4000 source, 11x the 1200px output cap.
  if (4000 * 4000 > MAX_SOURCE_PIXELS) {
    throw new Error("cap is too tight for legitimate large logos");
  }
  assertEquals(formatMegapixels(42_800_000), "42.8", "formats to one decimal");
  assertEquals(formatMegapixels(23_632_000), "23.6", "formats to one decimal");
});
