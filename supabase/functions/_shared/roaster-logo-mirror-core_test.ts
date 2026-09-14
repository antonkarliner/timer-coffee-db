import {
  buildBasePath,
  decideAssetKind,
  fetchLogoWithGuards,
  type MirrorCoreDeps,
  type MirrorResult,
  mirrorRoasterLogo,
  RASTER_ASSET_SUFFIX,
} from "./roaster-logo-mirror-core.ts";
import {
  MalformedSourceError,
  SourceTooLargeError,
  StorageUploadError,
  SvgRasterizationUnsupportedError,
} from "./roaster-postprocess-errors.ts";
import { ImageFormatError } from "./image-variants.ts";

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
  fn: () => Promise<unknown> | unknown,
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
    if (
      messageIncludes && !error.message.includes(messageIncludes)
    ) {
      throw new Error(
        `Expected message to include "${messageIncludes}", got: "${error.message}"`,
      );
    }
    return error;
  }
  throw new Error(`Expected ${expectedClass.name} to be thrown`);
}

// --- fixture builders --------------------------------------------------------

const PNG_SIGNATURE = [
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
];

/** Small legit PNG header (320x240) — under every cap. */
function smallPngBytes(): Uint8Array {
  return new Uint8Array([
    ...PNG_SIGNATURE,
    0x00,
    0x00,
    0x00,
    0x0D,
    0x49,
    0x48,
    0x44,
    0x52,
    0x00,
    0x00,
    0x01,
    0x40, // 320
    0x00,
    0x00,
    0x00,
    0xF0, // 240
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
  ]);
}

/** PNG header declaring huge dimensions — the 2026-09-01 OOM profile. */
function hugePngHeader(width: number, height: number): Uint8Array {
  const pad = new Uint8Array(220 * 1024); // compressed size is irrelevant
  return new Uint8Array([
    ...PNG_SIGNATURE,
    0x00,
    0x00,
    0x00,
    0x0D,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xFF,
    (width >>> 16) & 0xFF,
    (width >>> 8) & 0xFF,
    width & 0xFF,
    (height >>> 24) & 0xFF,
    (height >>> 16) & 0xFF,
    (height >>> 8) & 0xFF,
    height & 0xFF,
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
    ...pad,
  ]);
}

const SVG_BYTES = new TextEncoder().encode(
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`,
);
const HTML_BYTES = new TextEncoder().encode(
  "<!DOCTYPE html><html><head><title>Sign in</title></head><body>401</body></html>",
);
const AVIF_BYTES = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x20,
  0x66,
  0x74,
  0x79,
  0x70,
  0x61,
  0x76,
  0x69,
  0x66,
  ...new Uint8Array(20),
]);

// --- stub deps ---------------------------------------------------------------

interface StubUpload {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

interface StubWorld {
  uploads: StubUpload[];
  dbUpdates: Array<{ roasterId: string | number; url: string }>;
  publicUrls: Record<string, string>;
  warnings: string[];
  decoderCalled: boolean;
  rasterizerCalled: boolean;
}

function stubDeps(
  fetched: { bytes: Uint8Array; contentType: string | null },
  overrides: Partial<MirrorCoreDeps> = {},
): { deps: MirrorCoreDeps; world: StubWorld } {
  const world: StubWorld = {
    uploads: [],
    dbUpdates: [],
    publicUrls: {},
    warnings: [],
    decoderCalled: false,
    rasterizerCalled: false,
  };
  const deps: MirrorCoreDeps = {
    fetchLogo: async () => fetched,
    encoders: {
      webp: (bytes) => {
        world.decoderCalled = true;
        return new Uint8Array([0x52, 0x49, 0x46, 0x46, ...bytes.slice(0, 4)]);
      },
      rasterizeSvg: (bytes) => {
        world.rasterizerCalled = true;
        // Pretend the WASM build can rasterise: return fake WebP bytes.
        return new Uint8Array([0x52, 0x49, 0x46, 0x46, ...bytes.slice(0, 4)]);
      },
      variants: (bytes) => {
        // Fake 96w/400w variants derived from the (stub) WebP bytes.
        const fake = new Uint8Array([...bytes.slice(0, 2), 96]);
        const fake400 = new Uint8Array([...bytes.slice(0, 2), 240]);
        return new Map([
          [96, fake],
          [400, fake400],
        ]);
      },
    },
    logger: {
      info: () => {},
      warn: (message) => {
        world.warnings.push(message);
      },
    },
    uploadObject: async (path, bytes, contentType) => {
      world.uploads.push({ path, bytes, contentType });
      world.publicUrls[path] = `https://storage.test/${path}`;
    },
    getPublicUrl: (path) =>
      world.publicUrls[path] ?? `https://storage.test/${path}`,
    updateRoasterMirrorUrl: async (roasterId, url) => {
      world.dbUpdates.push({ roasterId, url });
    },
    ensureReady: async () => {},
    ...overrides,
  };
  return { deps, world };
}

// --- decision tests ----------------------------------------------------------

Deno.test("decideAssetKind: a .svg URL serving PNG bytes is processed as PNG", () => {
  const decision = decideAssetKind(
    "https://cdn.example/logo.svg",
    "image/png",
    smallPngBytes(),
  );
  assertEquals(
    decision,
    { kind: "raster" },
    "PNG magic bytes beat the .svg suffix",
  );
});

Deno.test("decideAssetKind: a .svg URL serving PNG bytes with no content-type is PNG", () => {
  const decision = decideAssetKind(
    "https://cdn.example/logo.svg",
    null,
    smallPngBytes(),
  );
  assertEquals(
    decision,
    { kind: "raster" },
    "magic bytes win even with no content-type",
  );
});

Deno.test("decideAssetKind: a .png URL serving SVG content-type is SVG", () => {
  const decision = decideAssetKind(
    "https://cdn.example/logo.png",
    "image/svg+xml",
    SVG_BYTES,
  );
  assertEquals(
    decision,
    { kind: "svg" },
    "content-type + svg bytes beat the .png suffix",
  );
});

Deno.test("decideAssetKind: a .png URL serving SVG markup with generic content-type is SVG", () => {
  const decision = decideAssetKind(
    "https://cdn.example/logo.png",
    "application/octet-stream",
    SVG_BYTES,
  );
  assertEquals(decision, { kind: "svg" }, "SVG markup itself is authoritative");
});

Deno.test("decideAssetKind: .svg suffix is only a tiebreaker for absent/generic types", () => {
  assertEquals(
    decideAssetKind("https://cdn.example/logo.svg", null, HTML_BYTES),
    {
      kind: "unsupported",
      reason: "html_response",
      message: expectHtmlMessage(),
    },
    "an HTML error page at a .svg URL is NOT stored as SVG",
  );
  assertEquals(
    decideAssetKind(
      "https://cdn.example/logo.svg",
      "application/octet-stream",
      SVG_BYTES,
    ),
    { kind: "svg" },
    "generic type + svg markup → svg",
  );
});

function expectHtmlMessage(): string {
  return "URL returned HTML — server requires authentication or the URL has expired";
}

Deno.test("decideAssetKind: AVIF bytes and content-types are unsupported", () => {
  assertEquals(
    decideAssetKind("https://cdn.example/logo", "image/avif", AVIF_BYTES),
    {
      kind: "unsupported",
      reason: "unsupported_format",
      message: "Unsupported content-type 'image/avif' — update the source URL",
    },
    "AVIF content-type is checked before the magic-byte branch",
  );
  assertEquals(
    decideAssetKind(
      "https://cdn.example/logo",
      "application/octet-stream",
      AVIF_BYTES,
    ),
    {
      kind: "unsupported",
      reason: "unsupported_format",
      message: expectAvifMessage(),
    },
    "AVIF detected by ISOBMFF magic bytes alone",
  );
  assertEquals(
    decideAssetKind(
      "https://cdn.example/logo",
      "image/avif",
      new TextEncoder().encode("not-an-image"),
    ),
    {
      kind: "unsupported",
      reason: "unsupported_format",
      message: "Unsupported content-type 'image/avif' — update the source URL",
    },
    "AVIF by content-type",
  );
});

function expectAvifMessage(): string {
  return "AVIF/HEIC format is not supported in this WASM build — use a JPEG or PNG source URL";
}

// --- small bytes, huge pixels -------------------------------------------------

Deno.test("220 KB source decoding to 8000x2954 is rejected as terminal source_too_large BEFORE decode", async () => {
  const { deps, world } = stubDeps({
    bytes: hugePngHeader(8000, 2954),
    contentType: "image/png",
  });
  const error = await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 1,
        roasterName: "Test",
        logoUrl: "https://src/logo.png",
      }),
    SourceTooLargeError,
  );
  assertEquals(
    error.message.includes("8000x2954 (23.6 Mpx) exceeds 16 Mpx cap"),
    true,
    `error must state DETECTED dimensions, got: ${error.message}`,
  );
  assertEquals(world.decoderCalled, false, "decoder must never be invoked");
  assertEquals(world.uploads.length, 0, "nothing may be uploaded");
});

Deno.test("686 KB source decoding to 6543x6543 is rejected as terminal source_too_large BEFORE decode", async () => {
  const { deps, world } = stubDeps({
    bytes: hugePngHeader(6543, 6543),
    contentType: "image/png",
  });
  const error = await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 1,
        roasterName: "Test",
        logoUrl: "https://src/logo.png",
      }),
    SourceTooLargeError,
  );
  assertEquals(
    error.message.includes("6543x6543 (42.8 Mpx) exceeds 16 Mpx cap"),
    true,
    `error must state DETECTED dimensions, got: ${error.message}`,
  );
  assertEquals(world.decoderCalled, false, "decoder must never be invoked");
});

Deno.test("normal 320x240 PNG mirrors successfully with variants", async () => {
  const { deps, world } = stubDeps({
    bytes: smallPngBytes(),
    contentType: "image/png",
  });
  const result = await mirrorRoasterLogo(deps, {
    roasterId: 42,
    roasterName: "Blue Bottle Coffee",
    logoUrl: "https://src/logo.png",
  });
  assertEquals(result.assetKind, "raster", "processed as raster");
  assertEquals(
    result.mirrorUrl,
    "https://storage.test/42_blue_bottle_coffee.webp",
    "canonical URL",
  );
  assertEquals(
    world.uploads.map((u) => u.path),
    [
      "42_blue_bottle_coffee.webp",
      "42_blue_bottle_coffee-96w.webp",
      "42_blue_bottle_coffee-400w.webp",
    ],
    "main + 96w + 400w layout preserved",
  );
  assertEquals(world.dbUpdates.length, 1, "mirror URL persisted once");
  assertEquals(world.dbUpdates[0].roasterId, 42, "right roaster");
});

Deno.test("SVG source mirrors verbatim, attempts raster working asset, and reports when rasterisation is unsupported", async () => {
  const { deps, world } = stubDeps({
    bytes: SVG_BYTES,
    contentType: "image/svg+xml",
  });
  // Make the rasteriser behave like the real 0.0.30 build (no SVG delegate).
  deps.encoders.rasterizeSvg = () => {
    world.rasterizerCalled = true;
    throw new SvgRasterizationUnsupportedError(
      "SVG rasterisation is unavailable in ImageMagick WASM 0.0.30 (no SVG delegate in this build)",
    );
  };
  const result: MirrorResult = await mirrorRoasterLogo(deps, {
    roasterId: 7,
    roasterName: "Svg Roaster",
    logoUrl: "https://src/logo.svg",
  });
  assertEquals(result.assetKind, "svg", "stored as SVG");
  assertEquals(
    result.mirrorUrl,
    "https://storage.test/7_svg_roaster.svg",
    "mirror URL is the verbatim SVG",
  );
  assertEquals(result.rasterAssetPath, null, "no raster asset on this build");
  assertEquals(
    result.rasterWarning?.includes("SVG rasterisation"),
    true,
    "warning recorded for the worker log",
  );
  assertEquals(world.rasterizerCalled, true, "rasterisation was attempted");
  assertEquals(
    world.dbUpdates.length,
    1,
    "mirror URL still persisted — mirror invariant holds",
  );
  assertEquals(
    world.uploads.map((u) => u.path),
    ["7_svg_roaster.svg"],
    "only the SVG is uploaded; no fake raster asset",
  );
});

Deno.test("SVG source with a raster-capable build produces {base}-raster.webp and variants", async () => {
  const { deps, world } = stubDeps({
    bytes: SVG_BYTES,
    contentType: "image/svg+xml",
  });
  const result = await mirrorRoasterLogo(deps, {
    roasterId: 7,
    roasterName: "Svg Roaster",
    logoUrl: "https://src/logo.svg",
  });
  assertEquals(
    result.rasterAssetPath,
    `7_svg_roaster${RASTER_ASSET_SUFFIX}`,
    "explicit {base}.svg + {base}-raster.webp naming relationship",
  );
  assertEquals(
    world.uploads.map((u) => u.path),
    [
      "7_svg_roaster.svg",
      `7_svg_roaster${RASTER_ASSET_SUFFIX}`,
      "7_svg_roaster-96w.webp",
      "7_svg_roaster-400w.webp",
    ],
    "verbatim SVG + raster working asset + variants",
  );
  assertEquals(
    result.rasterWarning,
    null,
    "no warning when rasterisation works",
  );
});

Deno.test("HTML from an auth-gated CDN is a terminal ImageFormatError", async () => {
  const { deps, world } = stubDeps({
    bytes: HTML_BYTES,
    contentType: "text/html",
  });
  const error = await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 1,
        roasterName: "T",
        logoUrl: "https://src/logo",
      }),
    ImageFormatError,
    "URL returned HTML",
  );
  assertEquals(
    error instanceof ImageFormatError,
    true,
    "suppression-aware error type",
  );
  assertEquals(world.decoderCalled, false, "no decode attempted");
});

Deno.test("AVIF content-type is terminal unsupported_format", async () => {
  const { deps, world } = stubDeps({
    bytes: AVIF_BYTES,
    contentType: "image/avif",
  });
  await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 1,
        roasterName: "T",
        logoUrl: "https://src/logo",
      }),
    ImageFormatError,
    "image/avif",
  );
  assertEquals(world.decoderCalled, false, "no decode attempted");
});

Deno.test("absent or malformed source URL is terminal malformed_url with no fetch", async () => {
  const { deps, world } = stubDeps({
    bytes: smallPngBytes(),
    contentType: "image/png",
  });
  let fetchCalled = false;
  deps.fetchLogo = async () => {
    fetchCalled = true;
    return { bytes: smallPngBytes(), contentType: "image/png" };
  };
  await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 1,
        roasterName: "T",
        logoUrl: null,
      }),
    MalformedSourceError,
  );
  await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 1,
        roasterName: "T",
        logoUrl: "not a url",
      }),
    MalformedSourceError,
  );
  await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 1,
        roasterName: "T",
        logoUrl: "ftp://src/logo.png",
      }),
    MalformedSourceError,
  );
  assertEquals(fetchCalled, false, "no fetch for malformed URLs");
  assertEquals(world.uploads.length, 0, "nothing uploaded");
});

Deno.test("variant upload failures are non-fatal; main logo still lands", async () => {
  const { deps, world } = stubDeps({
    bytes: smallPngBytes(),
    contentType: "image/png",
  });
  const originalUpload = deps.uploadObject;
  deps.uploadObject = async (path, bytes, contentType) => {
    if (path.endsWith("-96w.webp")) {
      throw new Error("variant storage hiccup");
    }
    await originalUpload(path, bytes, contentType);
  };
  const result = await mirrorRoasterLogo(deps, {
    roasterId: 5,
    roasterName: "Variant Test",
    logoUrl: "https://src/logo.png",
  });
  assertEquals(result.assetKind, "raster", "mirror still succeeds");
  assertEquals(world.dbUpdates.length, 1, "mirror URL persisted");
  assertEquals(
    world.warnings.some((w) => w.includes("96px variant")),
    true,
    "variant failure logged as warning",
  );
});

Deno.test("storage upload failure of the main asset surfaces as retryable StorageUploadError", async () => {
  const { deps } = stubDeps({
    bytes: smallPngBytes(),
    contentType: "image/png",
  });
  deps.uploadObject = async () => {
    throw new Error("boom");
  };
  const error = await assertThrows(
    () =>
      mirrorRoasterLogo(deps, {
        roasterId: 5,
        roasterName: "T",
        logoUrl: "https://src/logo.png",
      }),
    StorageUploadError,
    "Storage upload failed: boom",
  );
  assertEquals(
    error instanceof StorageUploadError,
    true,
    "typed for retry classification",
  );
});

// --- fetchLogoWithGuards (global fetch stubbed — no network) -------------------

Deno.test("fetchLogoWithGuards rejects a declared content-length over the byte cap without consuming the body", async () => {
  const originalFetch = globalThis.fetch;
  let bytesEnqueued = 0;
  globalThis.fetch = (async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          bytesEnqueued += 1024;
          controller.enqueue(new Uint8Array(1024));
        },
      }),
      {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "3500000" },
      },
    );
  }) as typeof fetch;
  try {
    const error = await assertThrows(
      () => fetchLogoWithGuards("https://src/logo.png"),
      SourceTooLargeError,
      "declared 3500000 bytes",
    );
    assertEquals(error instanceof SourceTooLargeError, true, "terminal class");
    // Stream buffering may eagerly fill a chunk or two, but the declared
    // cap must abort before any meaningful portion of the body is read.
    assertEquals(
      bytesEnqueued < 3_000_000,
      true,
      `body must not be consumed (enqueued ${bytesEnqueued} bytes)`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLogoWithGuards enforces the byte cap while streaming when content-length is absent", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB chunks
  globalThis.fetch = (async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 200,
        headers: { "content-type": "image/png" }, // no content-length: unknown, measure while reading
      },
    );
  }) as typeof fetch;
  try {
    const error = await assertThrows(
      () => fetchLogoWithGuards("https://src/logo.png"),
      SourceTooLargeError,
      "while streaming",
    );
    assertEquals(
      error.message.includes("declared content-length: absent"),
      true,
      "message must state that content-length was absent",
    );
    assertEquals(
      cancelled,
      true,
      "stream is cancelled as soon as the cap is breached",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLogoWithGuards passes a small body through with its content-type", async () => {
  const originalFetch = globalThis.fetch;
  const png = new Uint8Array([...PNG_SIGNATURE, 0, 1, 2, 3]);
  globalThis.fetch = (async () => {
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;
  try {
    const fetched = await fetchLogoWithGuards("https://src/logo.png");
    assertEquals(fetched.contentType, "image/png", "content-type preserved");
    assertEquals(fetched.bytes.length, png.length, "bytes intact");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- path helpers --------------------------------------------------------------

Deno.test("buildBasePath keeps the {id}_{name} storage layout", () => {
  assertEquals(
    buildBasePath(42, "Blue Bottle Coffee"),
    "42_blue_bottle_coffee",
    "id prefix + sanitised name",
  );
  assertEquals(
    buildBasePath("9", "Кофейня №1!"),
    "9_kofeynya_1",
    "Cyrillic transliterated, punctuation stripped",
  );
});
