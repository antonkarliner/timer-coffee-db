import {
  boundEvidencePayload,
  parseBatchedLogoResults,
  stripHtmlForLlm,
} from "./enrichment-prompt-utils.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

// ---------------------------------------------------------------------------
// stripHtmlForLlm
// ---------------------------------------------------------------------------

Deno.test("stripHtmlForLlm strips script/style/svg/comments and keeps meta + visible text", () => {
  const html = `
    <html>
      <head>
        <meta property="og:title" content="Acme Roasters">
        <meta name="description" content="Fresh coffee">
        <style>.a { color: red; }</style>
        <script>console.log("hi");</script>
      </head>
      <body>
        <!-- a comment that should vanish -->
        <svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>
        <noscript>Enable JS please</noscript>
        <h1>Acme Roasters</h1>
        <p>123 Main St, Springfield</p>
      </body>
    </html>
  `;

  const result = stripHtmlForLlm(html);

  assert(
    result.includes('content="Acme Roasters"'),
    "should preserve og:title meta tag verbatim",
  );
  assert(
    result.includes('content="Fresh coffee"'),
    "should preserve description meta tag verbatim",
  );
  assert(!result.includes("color: red"), "should strip <style> contents");
  assert(!result.includes("console.log"), "should strip <script> contents");
  assert(!result.includes("<circle"), "should strip <svg> contents");
  assert(
    !result.includes("Enable JS please"),
    "should strip <noscript> contents",
  );
  assert(
    !result.includes("a comment that should vanish"),
    "should strip HTML comments",
  );
  assert(result.includes("Acme Roasters"), "should keep visible heading text");
  assert(
    result.includes("123 Main St, Springfield"),
    "should keep visible paragraph text",
  );
  assert(!/<[a-z][\s\S]*>/i.test(result.replace(/<meta\b[^>]*>/gi, "")), "no leftover tags outside meta");
});

Deno.test("stripHtmlForLlm collapses whitespace runs and never exceeds input length", () => {
  const html = `<p>Hello      world</p>\n\n\n\n<p>Second   paragraph</p>`;
  const result = stripHtmlForLlm(html);

  assert(!result.includes("      "), "long space runs should be collapsed");
  assert(!/\n\s*\n\s*\n/.test(result), "excess blank lines should be collapsed");
  assert(
    result.length <= html.length,
    "stripped output should never be longer than the input",
  );
});

Deno.test("stripHtmlForLlm handles empty input", () => {
  assertEquals(stripHtmlForLlm(""), "", "empty input yields empty output");
});

Deno.test("stripHtmlForLlm caps huge input without throwing", () => {
  const huge = "<p>" + "x".repeat(200000) + "</p>";
  const result = stripHtmlForLlm(huge);
  assert(result.length <= 60000, "output should be bounded by the input cap");
});

// ---------------------------------------------------------------------------
// parseBatchedLogoResults
// ---------------------------------------------------------------------------

Deno.test("parseBatchedLogoResults happy path with N=3", () => {
  const parsed = {
    results: [
      { index: 0, isLogo: true, confidence: 0.9, reason: "brand mark" },
      { index: 1, isLogo: false, confidence: 0.1, reason: "product photo" },
      { index: 2, isLogo: true, confidence: 0.75, reason: "wordmark" },
    ],
  };

  const results = parseBatchedLogoResults(parsed, 3);

  assert(results !== null, "should return a non-null array");
  assertEquals(results!.length, 3, "should have exactly 3 entries");
  assertEquals(
    results!.map((r) => r.index),
    [0, 1, 2],
    "entries should be ordered by index",
  );
  assertEquals(results![0].isLogo, true, "index 0 isLogo");
  assertEquals(results![1].confidence, 0.1, "index 1 confidence");
  assertEquals(results![2].reason, "wordmark", "index 2 reason");
});

Deno.test("parseBatchedLogoResults fills missing indexes with safe defaults", () => {
  const parsed = {
    results: [
      { index: 0, isLogo: true, confidence: 0.9, reason: "brand mark" },
      // index 1 missing entirely
      { index: 2, isLogo: true, confidence: 0.6, reason: "logo" },
    ],
  };

  const results = parseBatchedLogoResults(parsed, 3);

  assert(results !== null, "should return a non-null array");
  assertEquals(results!.length, 3, "should still have 3 entries");
  assertEquals(
    results![1],
    {
      index: 1,
      isLogo: false,
      confidence: 0,
      reason: "missing from batch response",
    },
    "missing index should be filled with a safe default",
  );
});

Deno.test("parseBatchedLogoResults returns null for garbage input", () => {
  assertEquals(
    parseBatchedLogoResults(null, 3),
    null,
    "null input should return null",
  );
  assertEquals(
    parseBatchedLogoResults("not an object", 3),
    null,
    "non-object input should return null",
  );
  assertEquals(
    parseBatchedLogoResults({ foo: "bar" }, 3),
    null,
    "object without a results array should return null",
  );
  assertEquals(
    parseBatchedLogoResults({ results: "nope" }, 3),
    null,
    "non-array results should return null",
  );
});

Deno.test("parseBatchedLogoResults ignores duplicate and out-of-range indexes", () => {
  const parsed = {
    results: [
      { index: 0, isLogo: true, confidence: 0.9, reason: "first" },
      { index: 0, isLogo: false, confidence: 0.1, reason: "duplicate, ignored" },
      { index: 5, isLogo: true, confidence: 0.8, reason: "out of range, ignored" },
      { index: -1, isLogo: true, confidence: 0.8, reason: "negative, ignored" },
      { index: 1, isLogo: false, confidence: 0.2, reason: "second" },
    ],
  };

  const results = parseBatchedLogoResults(parsed, 2);

  assert(results !== null, "should return a non-null array");
  assertEquals(results!.length, 2, "should be clamped to expectedCount");
  assertEquals(results![0].reason, "first", "first occurrence of index 0 wins");
  assertEquals(results![1].reason, "second", "index 1 parsed normally");
});

Deno.test("parseBatchedLogoResults coerces bad field types to safe defaults", () => {
  const parsed = {
    results: [
      { index: 0, isLogo: "yes", confidence: "high", reason: 42 },
      { index: "1", isLogo: true, confidence: 0.5, reason: "ok" },
    ],
  };

  const results = parseBatchedLogoResults(parsed, 2);

  assert(results !== null, "should return a non-null array");
  assertEquals(results![0].isLogo, false, "non-boolean isLogo coerces to false");
  assertEquals(results![0].confidence, 0, "non-number confidence coerces to 0");
  assertEquals(
    results![0].reason,
    "No reason provided",
    "non-string reason coerces to default",
  );
  assertEquals(
    results![1],
    {
      index: 1,
      isLogo: false,
      confidence: 0,
      reason: "missing from batch response",
    },
    "string index is not a valid index and is treated as missing",
  );
});

// ---------------------------------------------------------------------------
// boundEvidencePayload
// ---------------------------------------------------------------------------

Deno.test("boundEvidencePayload passes small payloads through untruncated", () => {
  const payload = {
    urls: ["https://example.com/", "https://example.com/about"],
    pages: [
      { url: "https://example.com/", title: "Example", logos: [], addresses: [], names: [] },
    ],
    candidate_context: { roaster: "Example Roasters" },
  };

  const result = boundEvidencePayload(payload);

  assertEquals(result.truncated, false, "small payload should not be truncated");
  assertEquals(result.payload, payload, "payload should be unchanged");
  assertEquals(
    result.originalChars,
    result.finalChars,
    "original and final char counts should match when untruncated",
  );
});

Deno.test("boundEvidencePayload drops jsonLd first when a page exceeds the per-page budget", () => {
  const bigJsonLd = { "@type": "Organization", description: "x".repeat(5000) };
  const payload = {
    urls: ["https://example.com/"],
    pages: [
      {
        url: "https://example.com/",
        title: "Example",
        jsonLd: bigJsonLd,
        logos: ["https://example.com/logo.png"],
        addresses: [],
        names: [],
      },
    ],
    candidate_context: null,
  };

  const result = boundEvidencePayload(payload, { perPageChars: 200 });

  assertEquals(result.truncated, true, "oversized page should trigger truncation");
  const shrunkPage = result.payload.pages[0] as Record<string, unknown>;
  assert(!("jsonLd" in shrunkPage), "jsonLd should be dropped from the shrunk page");
  assertEquals(shrunkPage.title, "Example", "other fields should survive");
});

Deno.test("boundEvidencePayload enforces the total budget by dropping tail pages", () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.com/page-${i}`,
    title: `Page ${i}`,
    logos: [],
    addresses: [],
    names: [`Roaster ${i}`.repeat(20)],
  }));
  const payload = {
    urls: pages.map((p) => p.url),
    pages,
    candidate_context: null,
  };

  const result = boundEvidencePayload(payload, {
    perPageChars: 100000, // don't shrink individual pages
    totalChars: 1500,
  });

  assertEquals(result.truncated, true, "should be marked truncated");
  assert(
    result.payload.pages.length < pages.length,
    "some pages should be dropped from the tail",
  );
  assert(
    result.finalChars <= 1500 || result.payload.pages.length === 0,
    "final size should respect the total budget once pages are exhausted",
  );
  // Never drop urls or candidate_context.
  assertEquals(
    result.payload.urls.length,
    pages.length,
    "urls should never be dropped",
  );
});

Deno.test("boundEvidencePayload dedupes urls preserving order", () => {
  const payload = {
    urls: [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/",
      "https://example.com/contact",
      "https://example.com/about",
    ],
    pages: [],
    candidate_context: null,
  };

  const result = boundEvidencePayload(payload);

  assertEquals(
    result.payload.urls,
    [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/contact",
    ],
    "urls should be deduped preserving first-seen order",
  );
});

Deno.test("boundEvidencePayload never throws on null or weird pages", () => {
  const payload = {
    urls: ["https://example.com/"],
    pages: [null, undefined, "not an object", 42, ["array", "page"], { fine: true }],
    candidate_context: undefined,
  };

  let result;
  try {
    // deno-lint-ignore no-explicit-any
    result = boundEvidencePayload(payload as any);
  } catch (error) {
    throw new Error(`boundEvidencePayload should never throw, got: ${error}`);
  }

  assertEquals(result.payload.pages.length, payload.pages.length, "weird pages pass through untouched (until budget forces drops)");
});
