import {
  type ColorCoreDeps,
  deriveRasterAssetUrl,
  extractRoasterDominantColor,
  isSvgMirrorUrl,
  normalizeRawPixelsToRgba,
} from "./roaster-color-core.ts";
import {
  HttpSourceError,
  MalformedSourceError,
  SourceTooLargeError,
  SvgRasterizationUnsupportedError,
} from "./roaster-postprocess-errors.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function assertThrows<T extends Error>(
  fn: () => Promise<unknown>,
  expectedClass: new (...args: never[]) => T,
  messageIncludes?: string,
): Promise<T> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof expectedClass)) {
      throw new Error(
        `Expected ${expectedClass.name}, got: ${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`,
      );
    }
    if (messageIncludes && !error.message.includes(messageIncludes)) {
      throw new Error(
        `Expected message to include "${messageIncludes}", got: "${error.message}"`,
      );
    }
    return error;
  }
  throw new Error(`Expected ${expectedClass.name} to be thrown`);
}

const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
  0x00,
  0x01,
  0x02,
  0x03,
]);
const SVG_BYTES = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>`,
);

interface StubWorld {
  fetchCalls: string[];
  decodeCalls: Uint8Array[];
  dbWrites: Array<{ roasterId: string | number; hex: string | null }>;
}

function stubDeps(
  respond: (url: string) => { bytes: Uint8Array; contentType: string | null },
  decodeColor: (bytes: Uint8Array) => string | null = () => "#3B82F6",
): { deps: ColorCoreDeps; world: StubWorld } {
  const world: StubWorld = { fetchCalls: [], decodeCalls: [], dbWrites: [] };
  const deps: ColorCoreDeps = {
    fetchAsset: async (url) => {
      world.fetchCalls.push(url);
      return respond(url);
    },
    decodeColor: (bytes) => {
      world.decodeCalls.push(bytes);
      return decodeColor(bytes);
    },
    updateDominantColor: async (roasterId, hex) => {
      world.dbWrites.push({ roasterId, hex });
    },
    ensureReady: async () => {},
  };
  return { deps, world };
}

Deno.test("isSvgMirrorUrl detects .svg paths and ignores queries", () => {
  assertEquals(
    isSvgMirrorUrl("https://storage.test/7_roaster.svg?token=1"),
    true,
    ".svg with query string",
  );
  assertEquals(
    isSvgMirrorUrl("https://storage.test/7_roaster.webp"),
    false,
    "webp mirror",
  );
  assertEquals(
    isSvgMirrorUrl("https://storage.test/7_roaster.SVG"),
    true,
    "case-insensitive",
  );
});

Deno.test("deriveRasterAssetUrl rewrites {base}.svg to {base}-raster.webp", () => {
  assertEquals(
    deriveRasterAssetUrl(
      "https://storage.test/roaster_logo_mirrors/7_roaster.svg",
    ),
    "https://storage.test/roaster_logo_mirrors/7_roaster-raster.webp",
    "explicit naming relationship",
  );
  assertEquals(
    deriveRasterAssetUrl(
      "https://storage.test/roaster_logo_mirrors/7_roaster.webp",
    ),
    null,
    "non-SVG mirrors have no derived raster URL",
  );
});

Deno.test("extract_color uses the raster working asset for SVG-derived mirrors", async () => {
  const { deps, world } = stubDeps((url) => {
    if (url.endsWith("-raster.webp")) {
      return { bytes: PNG_BYTES, contentType: "image/webp" };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const result = await extractRoasterDominantColor(deps, {
    roasterId: 7,
    mirrorUrl: "https://storage.test/mirrors/7_roaster.svg",
  });
  assertEquals(
    world.fetchCalls,
    ["https://storage.test/mirrors/7_roaster-raster.webp"],
    "raster asset fetched, never the SVG itself",
  );
  assertEquals(
    result,
    { color: "#3B82F6", colorReason: "extracted" },
    "colour extracted",
  );
  assertEquals(
    world.dbWrites,
    [{ roasterId: 7, hex: "#3B82F6" }],
    "colour persisted",
  );
});

Deno.test("missing raster working asset for an SVG mirror is terminal svg_rasterization_unsupported", async () => {
  const { deps, world } = stubDeps((url) => {
    if (url.endsWith("-raster.webp")) {
      throw new HttpSourceError(404, "Failed to fetch logo: HTTP 404");
    }
    return { bytes: SVG_BYTES, contentType: "image/svg+xml" };
  });
  const error = await assertThrows(
    () =>
      extractRoasterDominantColor(deps, {
        roasterId: 7,
        mirrorUrl: "https://storage.test/mirrors/7_roaster.svg",
      }),
    SvgRasterizationUnsupportedError,
    "no raster working asset",
  );
  assertEquals(
    error.message.includes("replace roaster_logo_url"),
    true,
    "actionable message",
  );
  assertEquals(world.dbWrites.length, 0, "NO null colour is silently stored");
  assertEquals(world.decodeCalls.length, 0, "no decode attempted");
});

Deno.test("transient upstream errors on the raster asset stay retryable (not swallowed into svg errors)", async () => {
  const { deps } = stubDeps((url) => {
    if (url.endsWith("-raster.webp")) {
      throw new HttpSourceError(503, "Failed to fetch logo: HTTP 503");
    }
    throw new Error("unexpected fetch");
  });
  await assertThrows(
    () =>
      extractRoasterDominantColor(deps, {
        roasterId: 7,
        mirrorUrl: "https://storage.test/mirrors/7_roaster.svg",
      }),
    HttpSourceError,
    "503",
  );
});

Deno.test("raster mirrors are decoded directly", async () => {
  const { deps, world } = stubDeps(() => ({
    bytes: PNG_BYTES,
    contentType: "image/webp",
  }), () => "#AABB00");
  const result = await extractRoasterDominantColor(deps, {
    roasterId: 3,
    mirrorUrl: "https://storage.test/mirrors/3_roaster.webp",
  });
  assertEquals(world.fetchCalls, [
    "https://storage.test/mirrors/3_roaster.webp",
  ], "fetched as-is");
  assertEquals(world.decodeCalls.length, 1, "decoded once");
  assertEquals(
    result,
    { color: "#AABB00", colorReason: "extracted" },
    "colour extracted",
  );
});

Deno.test("null colour is SUCCESS only for the documented fully-transparent rule", async () => {
  const { deps, world } = stubDeps(() => ({
    bytes: PNG_BYTES,
    contentType: "image/webp",
  }), () => null);
  const result = await extractRoasterDominantColor(deps, {
    roasterId: 3,
    mirrorUrl: "https://storage.test/mirrors/3_roaster.webp",
  });
  assertEquals(
    result,
    { color: null, colorReason: "fully_transparent" },
    "explicit documented rule: zero opaque pixels has no representative colour",
  );
  assertEquals(
    world.dbWrites,
    [{ roasterId: 3, hex: null }],
    "null persisted as an explicit success",
  );
});

Deno.test("oversized mirror assets are terminal source_too_large", async () => {
  const oversized = new Uint8Array(12);
  // BMP header declaring 5000x5000 (25 Mpx > 16 Mpx cap)
  const bytes = new Uint8Array(26);
  bytes[0] = 0x42;
  bytes[1] = 0x4D;
  const width = 5000;
  const height = 5000;
  bytes.set([width & 0xFF, (width >>> 8) & 0xFF, 0, 0], 18);
  bytes.set([height & 0xFF, (height >>> 8) & 0xFF, 0, 0], 22);
  void oversized;
  const { deps } = stubDeps(() => ({ bytes, contentType: "image/bmp" }));
  await assertThrows(
    () =>
      extractRoasterDominantColor(deps, {
        roasterId: 3,
        mirrorUrl: "https://storage.test/mirrors/3_roaster.webp",
      }),
    SourceTooLargeError,
    "exceeds 16 Mpx cap",
  );
});

Deno.test("raster mirror that serves SVG markup without a derivable raster URL fails visibly", async () => {
  const { deps, world } = stubDeps(() => ({
    bytes: SVG_BYTES,
    contentType: "image/svg+xml",
  }));
  await assertThrows(
    () =>
      extractRoasterDominantColor(deps, {
        roasterId: 3,
        mirrorUrl: "https://storage.test/mirrors/3_roaster.webp",
      }),
    SvgRasterizationUnsupportedError,
  );
  assertEquals(world.dbWrites.length, 0, "no silent null");
});

Deno.test("absent mirror URL is terminal malformed_url", async () => {
  const { deps } = stubDeps(() => {
    throw new Error("must not fetch");
  });
  await assertThrows(
    () => extractRoasterDominantColor(deps, { roasterId: 3, mirrorUrl: null }),
    MalformedSourceError,
    "no roaster_logo_mirror_url",
  );
});

Deno.test("normalizeRawPixelsToRgba maps every ImageMagick raw layout to RGBA", () => {
  // Already RGBA: passed through untouched.
  const rgba = new Uint8Array([1, 2, 3, 255]);
  assertEquals(
    normalizeRawPixelsToRgba(rgba, 1),
    rgba,
    "RGBA payload passes through",
  );
  // RGB → RGBA with opaque alpha.
  assertEquals(
    [...normalizeRawPixelsToRgba(new Uint8Array([10, 20, 30]), 1)],
    [10, 20, 30, 255],
    "RGB gains opaque alpha",
  );
  // Gray+alpha → RGBA.
  assertEquals(
    [...normalizeRawPixelsToRgba(new Uint8Array([40, 128]), 1)],
    [40, 40, 40, 128],
    "gray+alpha expands channels",
  );
  // Gray → opaque RGBA.
  assertEquals(
    [...normalizeRawPixelsToRgba(new Uint8Array([77]), 1)],
    [77, 77, 77, 255],
    "gray gains opaque alpha",
  );
  // CMYK → RGBA (K=0 → full channels; K=255 → black).
  assertEquals(
    [...normalizeRawPixelsToRgba(new Uint8Array([255, 0, 0, 0, 200]), 1)],
    [0, 255, 255, 200],
    "CMYK(255,0,0,K=200) converts with preserved alpha",
  );
  // Unexpected size → error.
  let threw = false;
  try {
    normalizeRawPixelsToRgba(new Uint8Array(7), 1);
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "unexpected payload size must throw");
});
