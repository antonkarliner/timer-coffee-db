import {
  buildBatchResponseFormat,
  buildSingleResponseFormat,
  buildTranslationRows,
  chunkLocales,
  MAX_TRANSLATION_LOCALES,
  parseBatchTranslationContent,
  parseSingleTranslationContent,
  remainingTranslationTimeMs,
  shouldWriteTranslationState,
  summarizeTranslationError,
  validateTranslationRequest,
} from "./translation-runtime.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("validation preserves legacy request and defaults dry_run", () => {
  const result = validateTranslationRequest({
    text: "A new popup",
    locales: ["fr", "de"],
    platform: "internal_canary",
  });

  assert(result.ok, "Legacy request should be valid.");
  if (!result.ok) return;
  assertEquals(result.value, {
    text: "A new popup",
    locales: ["fr", "de"],
    platform: "internal_canary",
    dry_run: false,
  }, "Legacy fields should be preserved.");
});

Deno.test("validation accepts source_popup_id and dry_run", () => {
  const result = validateTranslationRequest({
    text: "A new popup",
    locales: ["fr"],
    source_popup_id: 42,
    dry_run: true,
  });

  assert(result.ok, "New request shape should be valid.");
  if (!result.ok) return;
  assertEquals(
    result.value.source_popup_id,
    42,
    "Source ID should be retained.",
  );
  assertEquals(result.value.dry_run, true, "Dry-run flag should be retained.");
});

Deno.test("validation rejects canonical duplicate and excessive locales", () => {
  const duplicate = validateTranslationRequest({
    text: "Popup",
    locales: ["pt_BR", "pt-br"],
  });
  assert(!duplicate.ok, "Canonical duplicate locales should be rejected.");

  const excessive = validateTranslationRequest({
    text: "Popup",
    locales: Array.from(
      { length: MAX_TRANSLATION_LOCALES + 1 },
      (_, index) =>
        String.fromCharCode(97 + Math.floor(index / 26)) +
        String.fromCharCode(97 + (index % 26)),
    ),
  });
  assert(!excessive.ok, "Locale count should be bounded.");
  assert(
    !excessive.ok &&
      excessive.errors.some((error) => error.includes("between 1 and 25")),
    "The approved 25-locale limit should be reported.",
  );
});

Deno.test("locales are chunked in stable groups of three", () => {
  assertEquals(
    chunkLocales(["fr", "de", "es", "it", "ja", "ko", "ru"]),
    [["fr", "de", "es"], ["it", "ja", "ko"], ["ru"]],
    "Chunk order and size should be deterministic.",
  );
});

Deno.test("batch schema is strict and dynamic", () => {
  const responseFormat = buildBatchResponseFormat(["fr", "de"]);
  const translations = responseFormat.json_schema.schema.properties
    .translations;

  assertEquals(
    responseFormat.type,
    "json_schema",
    "JSON schema should be used.",
  );
  assertEquals(
    responseFormat.json_schema.strict,
    true,
    "Schema must be strict.",
  );
  assertEquals(
    translations.required,
    ["fr", "de"],
    "Every chunk locale should be required.",
  );
  assertEquals(
    Object.keys(translations.properties),
    ["fr", "de"],
    "Schema properties should match the current chunk.",
  );
  assertEquals(
    translations.additionalProperties,
    false,
    "Unexpected locales should be forbidden.",
  );
});

Deno.test("batch parser accepts only requested non-empty translations", () => {
  const parsed = parseBatchTranslationContent(
    JSON.stringify({
      translations: {
        fr: "Bonjour",
        de: " ",
        injected: "Do not accept",
      },
    }),
    ["fr", "de"],
  );

  assertEquals(
    Object.fromEntries(parsed),
    { fr: { content: "Bonjour" } },
    "Only requested non-empty translations should be returned.",
  );
  assertEquals(
    parseBatchTranslationContent("not json", ["fr"]).size,
    0,
    "Invalid JSON should produce no translations.",
  );
  assertEquals(
    parseSingleTranslationContent('{"translation":"Bonjour"}'),
    { content: "Bonjour" },
    "Single fallback JSON should parse.",
  );
});

Deno.test("row planning distinguishes legacy, source-linked, and dry-run requests", () => {
  const translations = new Map([["fr", { content: "Bonjour" }]]);
  const legacy = validateTranslationRequest({
    text: "Hello",
    locales: ["fr"],
    platform: "internal_canary",
  });
  const linkedDryRun = validateTranslationRequest({
    text: "Hello",
    locales: ["fr"],
    platform: "internal_canary",
    source_popup_id: 77,
    dry_run: true,
  });

  assert(legacy.ok && linkedDryRun.ok, "Fixtures should validate.");
  if (!legacy.ok || !linkedDryRun.ok) return;

  assertEquals(buildTranslationRows(legacy.value, translations), [{
    content: "Bonjour",
    locale: "fr",
    is_translated: true,
    platform: "internal_canary",
  }], "Legacy rows should remain inserts without source_popup_id.");
  assertEquals(buildTranslationRows(linkedDryRun.value, translations), [{
    content: "Bonjour",
    locale: "fr",
    is_translated: true,
    platform: "internal_canary",
    source_popup_id: 77,
  }], "Source-linked rows should carry the conflict key.");
  assertEquals(
    shouldWriteTranslationState(legacy.value),
    true,
    "Legacy production requests should write translation state.",
  );
  assertEquals(
    shouldWriteTranslationState(linkedDryRun.value),
    false,
    "Dry-run requests should skip all translation-state writes.",
  );
});

Deno.test("error summary is concise and locale-only", () => {
  assertEquals(summarizeTranslationError([]), null, "Success clears errors.");
  assertEquals(
    summarizeTranslationError([
      { locale: "fr", phase: "translation", error: "translation failed" },
      { locale: "de", phase: "database", error: "database write failed" },
      { locale: "fr", phase: "database", error: "database write failed" },
    ]),
    "Failed locales: fr, de",
    "Error summaries should deduplicate locale codes.",
  );
});

Deno.test("request deadline budget is pure and bounded", () => {
  assertEquals(
    remainingTranslationTimeMs(1_120_000, 1_000_000),
    120_000,
    "Remaining time should be derived from the fixed deadline.",
  );
  assertEquals(
    remainingTranslationTimeMs(1_120_000, 1_120_001),
    0,
    "Expired requests should never expose a negative operation budget.",
  );
});

// ── Plan 054 Item C — optional per-popup title ──────────────────────────────
//
// The guard below exists because the whole safety argument for this feature is
// that a titleless popup takes a byte-identical path. If someone later
// "simplifies" the two modes into one, this test is what fails.

Deno.test("untitled batch schema is unchanged from the pre-title shape", () => {
  const format = buildBatchResponseFormat(["fr", "de"]);
  assertEquals(
    JSON.stringify(format),
    JSON.stringify({
      type: "json_schema",
      json_schema: {
        name: "launch_popup_translations",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["translations"],
          properties: {
            translations: {
              type: "object",
              additionalProperties: false,
              required: ["fr", "de"],
              properties: {
                fr: { type: "string", minLength: 1 },
                de: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    }),
    "The untitled batch schema must stay byte-identical to the pre-title one.",
  );

  assertEquals(
    JSON.stringify(buildSingleResponseFormat()),
    JSON.stringify({
      type: "json_schema",
      json_schema: {
        name: "launch_popup_translation",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["translation"],
          properties: { translation: { type: "string", minLength: 1 } },
        },
      },
    }),
    "The untitled single schema must stay byte-identical too.",
  );
});

Deno.test("titled batch schema requires a content/title object per locale", () => {
  const format = buildBatchResponseFormat(["fr"], true);
  const localeSchema =
    format.json_schema.schema.properties.translations.properties.fr;
  assertEquals(
    JSON.stringify(localeSchema),
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["content", "title"],
      properties: {
        content: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
      },
    }),
    "A titled request must declare a per-locale object.",
  );
});

Deno.test("titled batch parser keeps a locale whose title is missing", () => {
  const parsed = parseBatchTranslationContent(
    JSON.stringify({
      translations: {
        fr: { content: "Bonjour", title: "Salut" },
        de: { content: "Hallo", title: "  " },
        es: { title: "Hola" },
      },
    }),
    ["fr", "de", "es"],
    true,
  );

  assertEquals(
    Object.fromEntries(parsed),
    { fr: { content: "Bonjour", title: "Salut" }, de: { content: "Hallo" } },
    "A blank title drops only the title; a missing body drops the locale.",
  );
});

Deno.test("title validation bounds the length and treats null as absent", () => {
  const withTitle = validateTranslationRequest({
    text: "Hello",
    locales: ["fr"],
    title: "  Happy Coffee Day  ",
  });
  assert(withTitle.ok, "A valid title should pass validation.");
  if (withTitle.ok) {
    assertEquals(
      withTitle.value.title,
      "Happy Coffee Day",
      "A valid title should be trimmed.",
    );
  }

  const nullTitle = validateTranslationRequest({
    text: "Hello",
    locales: ["fr"],
    title: null,
  });
  assert(nullTitle.ok, "A null title is how the database says 'no title'.");
  if (nullTitle.ok) {
    assert(
      !("title" in nullTitle.value),
      "A null title must be absent, not undefined-valued.",
    );
  }

  assert(
    !validateTranslationRequest({ text: "Hi", locales: ["fr"], title: "" }).ok,
    "An empty title must be rejected.",
  );
  assert(
    !validateTranslationRequest({
      text: "Hi",
      locales: ["fr"],
      title: "x".repeat(201),
    }).ok,
    "A title over 200 characters must be rejected.",
  );
});

Deno.test("rows carry a title only when the entry has one", () => {
  const request = validateTranslationRequest({
    text: "Hello",
    locales: ["fr", "de"],
    platform: "internal_canary",
    source_popup_id: 77,
    title: "Happy Coffee Day",
  });
  assert(request.ok, "Fixture should validate.");
  if (!request.ok) return;

  const rows = buildTranslationRows(
    request.value,
    new Map([
      ["fr", { content: "Bonjour", title: "Bonne journée du café" }],
      ["de", { content: "Hallo" }],
    ]),
  );

  assertEquals(rows.length, 2, "Both locales should produce a row.");
  assertEquals(
    rows[0].title,
    "Bonne journée du café",
    "A translated title should reach the row.",
  );
  assert(
    !("title" in rows[1]),
    "A locale without a translated title must omit the column entirely.",
  );
});
