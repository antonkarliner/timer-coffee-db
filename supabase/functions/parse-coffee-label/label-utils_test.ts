import {
  buildSystemPrompt,
  isPlausibleLabelResult,
  needsRoastDateConfirmation,
  normalizeResult,
  shouldFallbackProviderError,
  titleCaseIfAllCaps,
} from "./label-utils.ts";

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
// titleCaseIfAllCaps
// ---------------------------------------------------------------------------

Deno.test("titleCaseIfAllCaps title-cases a fully upper-case string", () => {
  assertEquals(
    titleCaseIfAllCaps("ETHIOPIA HEIRLOOM"),
    "Ethiopia Heirloom",
    "all-caps string should be title-cased",
  );
});

Deno.test("titleCaseIfAllCaps leaves mixed-case strings untouched", () => {
  assertEquals(
    titleCaseIfAllCaps("Ethiopia Heirloom"),
    "Ethiopia Heirloom",
    "already-mixed-case string should pass through unchanged",
  );
  assertEquals(
    titleCaseIfAllCaps("ethiopia Heirloom"),
    "ethiopia Heirloom",
    "partially-lowercase string should pass through unchanged",
  );
});

Deno.test("titleCaseIfAllCaps leaves all-lowercase strings untouched", () => {
  assertEquals(
    titleCaseIfAllCaps("ethiopia heirloom"),
    "ethiopia heirloom",
    "all-lowercase string is not 'entirely uppercase' and should pass through",
  );
});

Deno.test("titleCaseIfAllCaps handles non-ASCII letters locale-independently", () => {
  assertEquals(
    titleCaseIfAllCaps("CAFÉ CON LECHE"),
    "Café Con Leche",
    "accented uppercase letters should title-case correctly",
  );
});

Deno.test("titleCaseIfAllCaps handles hyphens and apostrophes as word breaks", () => {
  assertEquals(
    titleCaseIfAllCaps("SANTA-CRUZ"),
    "Santa-Cruz",
    "hyphenated all-caps word should title-case each segment",
  );
  assertEquals(
    titleCaseIfAllCaps("O'BRIEN FARMS"),
    "O'Brien Farms",
    "apostrophe should split into separate title-cased segments",
  );
});

Deno.test("titleCaseIfAllCaps leaves strings with no letters untouched", () => {
  assertEquals(
    titleCaseIfAllCaps("123-456"),
    "123-456",
    "digits/punctuation-only string has no case and should pass through",
  );
  assertEquals(titleCaseIfAllCaps(""), "", "empty string should pass through");
});

// ---------------------------------------------------------------------------
// normalizeResult — null-token normalization
// ---------------------------------------------------------------------------

Deno.test("normalizeResult nulls out all recognized null tokens", () => {
  const result = normalizeResult({
    roaster: "Unknown",
    name: "unknown",
    farm: "N/A",
    farmer: "n/a",
    variety: "",
    region: "   ",
    processingMethod: "-",
    origin: "Ethiopia",
  }) as Record<string, unknown>;

  assertEquals(result.roaster, null, '"Unknown" should normalize to null');
  assertEquals(result.name, null, '"unknown" should normalize to null');
  assertEquals(result.farm, null, '"N/A" should normalize to null');
  assertEquals(result.farmer, null, '"n/a" should normalize to null');
  assertEquals(result.variety, null, 'empty string should normalize to null');
  assertEquals(
    result.region,
    null,
    "whitespace-only string should normalize to null",
  );
  assertEquals(result.processingMethod, null, '"-" should normalize to null');
  assertEquals(
    result.origin,
    "Ethiopia",
    "a real value should be left as-is (aside from title-casing rules)",
  );
});

Deno.test("normalizeResult does not null-normalize the error sentinel's value", () => {
  const result = normalizeResult({
    error: "No coffee labels detected",
  }) as Record<string, unknown>;

  assertEquals(
    result.error,
    "No coffee labels detected",
    "the error sentinel value must survive unchanged",
  );
});

Deno.test("normalizeResult treats a literal 'Unknown' error value as untouched too", () => {
  // Defensive: even if some provider ever emitted this, the `error` key must
  // never be rewritten by the null-token pass.
  const result = normalizeResult({
    error: "Unknown",
  }) as Record<string, unknown>;

  assertEquals(
    result.error,
    "Unknown",
    "error field content is never null-token normalized",
  );
});

// ---------------------------------------------------------------------------
// normalizeResult — title-casing
// ---------------------------------------------------------------------------

Deno.test("normalizeResult title-cases all-caps roaster/name/variety/region", () => {
  const result = normalizeResult({
    roaster: "BLUE BOTTLE COFFEE",
    name: "ETHIOPIA YIRGACHEFFE",
    variety: "HEIRLOOM",
    region: "SIDAMA",
    farm: "already Mixed Case Farm",
  }) as Record<string, unknown>;

  assertEquals(result.roaster, "Blue Bottle Coffee", "roaster should title-case");
  assertEquals(result.name, "Ethiopia Yirgacheffe", "name should title-case");
  assertEquals(result.variety, "Heirloom", "variety should title-case");
  assertEquals(result.region, "Sidama", "region should title-case");
  assertEquals(
    result.farm,
    "already Mixed Case Farm",
    "farm is not a title-case field and should pass through unchanged",
  );
});

Deno.test("normalizeResult title-cases each comma-separated tastingNotes item independently", () => {
  const result = normalizeResult({
    tastingNotes: "FLORAL, Chocolate, NUTTY",
  }) as Record<string, unknown>;

  assertEquals(
    result.tastingNotes,
    "Floral, Chocolate, Nutty",
    "each item should be title-cased only when that item is entirely upper case",
  );
});

Deno.test("normalizeResult leaves mixed-case tastingNotes untouched", () => {
  const result = normalizeResult({
    tastingNotes: "Floral, Chocolate, Nutty",
  }) as Record<string, unknown>;

  assertEquals(
    result.tastingNotes,
    "Floral, Chocolate, Nutty",
    "already-correct casing should be preserved",
  );
});

// ---------------------------------------------------------------------------
// normalizeResult — harvestDate forcing
// ---------------------------------------------------------------------------

Deno.test("normalizeResult forces harvestDate to null on a normal extraction result", () => {
  const result = normalizeResult({
    roaster: "Acme",
    roastDate: "2026-01-01",
  }) as Record<string, unknown>;

  assertEquals(
    result.harvestDate,
    null,
    "harvestDate should be force-set to null on a real result",
  );
});

Deno.test("normalizeResult does not add harvestDate to the error envelope", () => {
  const result = normalizeResult({
    error: "No coffee labels detected",
  }) as Record<string, unknown>;

  assert(
    !Object.prototype.hasOwnProperty.call(result, "harvestDate"),
    "error envelope must not gain a harvestDate key",
  );
});

Deno.test("normalizeResult does not add harvestDate to a roastDate-only recheck response", () => {
  const result = normalizeResult({
    roastDate: "2026-01-01",
  }) as Record<string, unknown>;

  assert(
    !Object.prototype.hasOwnProperty.call(result, "harvestDate"),
    "single-key roastDate-only response must not gain a harvestDate key",
  );
});

// ---------------------------------------------------------------------------
// normalizeResult — schema-driven error:null cleanup
// ---------------------------------------------------------------------------

Deno.test("normalizeResult deletes a null error property from a real result", () => {
  const result = normalizeResult({
    roaster: "Acme",
    error: null,
  }) as Record<string, unknown>;

  assert(
    !Object.prototype.hasOwnProperty.call(result, "error"),
    "a null error property should be deleted entirely",
  );
  assertEquals(result.roaster, "Acme", "other fields should be unaffected");
});

Deno.test("normalizeResult deletes an undefined error property from a real result", () => {
  const result = normalizeResult({
    roaster: "Acme",
    error: undefined,
  }) as Record<string, unknown>;

  assert(
    !Object.prototype.hasOwnProperty.call(result, "error"),
    "an undefined error property should be deleted entirely",
  );
});

// ---------------------------------------------------------------------------
// normalizeResult — arrays
// ---------------------------------------------------------------------------

Deno.test("normalizeResult unwraps a single-element array response", () => {
  const result = normalizeResult([
    { roaster: "Unknown", name: "Acme" },
  ]) as Record<string, unknown>;

  assertEquals(result.roaster, null, "unwrapped element should still be null-normalized");
  assertEquals(result.name, "Acme", "unwrapped element should retain real values");
});

Deno.test("normalizeResult passes through non-object, non-array primitives", () => {
  assertEquals(normalizeResult(null), null, "null passes through");
  assertEquals(normalizeResult(undefined), undefined, "undefined passes through");
  assertEquals(normalizeResult("plain string"), "plain string", "string passes through");
});

// ---------------------------------------------------------------------------
// buildSystemPrompt — cache-friendly static/dynamic split (Item 5)
// ---------------------------------------------------------------------------

function staticPrefix(prompt: string): string {
  const idx = prompt.indexOf("\n\nTarget locale:");
  assert(idx !== -1, "prompt must contain the dynamic Locale/Today tail marker");
  return prompt.slice(0, idx);
}

Deno.test("buildSystemPrompt has a byte-identical static prefix across different locales/dates", () => {
  const promptA = buildSystemPrompt({ locale: "en-US", today: "2026-01-01" });
  const promptB = buildSystemPrompt({ locale: "es-ES", today: "2026-07-09" });

  assertEquals(
    staticPrefix(promptA),
    staticPrefix(promptB),
    "static prefix must be byte-identical regardless of locale/today",
  );
});

Deno.test("buildSystemPrompt static prefix contains no interpolated locale/date text", () => {
  const prompt = buildSystemPrompt({ locale: "en-US", today: "2026-01-01" });
  const prefix = staticPrefix(prompt);

  assert(!prefix.includes("en-US"), "static prefix must not contain the locale");
  assert(!prefix.includes("2026-01-01"), "static prefix must not contain the date");
  assert(
    !prefix.includes("harvestDate"),
    "harvestDate must be removed from the prompt schema entirely (Item 1)",
  );
  assert(
    prefix.includes("JSON"),
    "prompt must still mention JSON so json_object mode is satisfied",
  );
});

Deno.test("buildSystemPrompt dynamic tail carries the given locale and today", () => {
  const prompt = buildSystemPrompt({ locale: "fr-FR", today: "2026-03-15" });

  assert(
    prompt.includes("Target locale: fr-FR") && prompt.endsWith("Today's date: 2026-03-15."),
    "dynamic tail should end with the Locale/Today line when there is no OCR text",
  );
});

Deno.test("buildSystemPrompt appends OCR context after the Locale/Today tail when provided", () => {
  const prompt = buildSystemPrompt({
    locale: "en-US",
    today: "2026-01-01",
    ocrText: "Roasted on 01/02",
  });

  assert(
    prompt.endsWith(
      "Today's date: 2026-01-01.\n\nAdditional OCR context from mobile device: Roasted on 01/02",
    ),
    "OCR context should be appended after the Locale/Today tail",
  );
  assert(
    prompt.includes("Target locale: en-US"),
    "tail should carry the target locale",
  );
});

Deno.test("buildSystemPrompt omits the OCR block when ocrText is blank or missing", () => {
  const withoutField = buildSystemPrompt({ locale: "en-US", today: "2026-01-01" });
  const withBlank = buildSystemPrompt({
    locale: "en-US",
    today: "2026-01-01",
    ocrText: "   ",
  });

  assert(
    !withoutField.includes("Additional OCR context"),
    "no ocrText should mean no OCR block",
  );
  assert(
    !withBlank.includes("Additional OCR context"),
    "whitespace-only ocrText should mean no OCR block",
  );
});

// ---------------------------------------------------------------------------
// isPlausibleLabelResult
// ---------------------------------------------------------------------------

Deno.test("isPlausibleLabelResult rejects a raw JSON-Schema echo", () => {
  assertEquals(
    isPlausibleLabelResult({
      "$schema": "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {},
    }),
    false,
    "a schema echo has no recognized label fields and no error string",
  );
});

Deno.test("isPlausibleLabelResult rejects a schema echo even after normalizeResult force-adds harvestDate", () => {
  const schemaEcho = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {},
  };
  const normalized = normalizeResult(schemaEcho) as Record<string, unknown>;

  assertEquals(
    normalized.harvestDate,
    null,
    "sanity check: normalizeResult does force-add harvestDate to junk objects",
  );
  assertEquals(
    isPlausibleLabelResult(normalized),
    false,
    "harvestDate is excluded from LABEL_FIELDS, so the schema echo must still read as implausible",
  );
});

Deno.test("isPlausibleLabelResult accepts the error envelope", () => {
  assertEquals(
    isPlausibleLabelResult({ error: "No coffee labels detected" }),
    true,
    "the { error: string } sentinel is a valid, plausible result",
  );
});

Deno.test("isPlausibleLabelResult accepts a normal extraction result", () => {
  assertEquals(
    isPlausibleLabelResult({
      roaster: "Blue Bottle",
      name: "Giant Steps",
      harvestDate: null,
    }),
    true,
    "a result with recognized label fields is plausible",
  );
});

Deno.test("isPlausibleLabelResult accepts the roastDate-only strict-recheck shape", () => {
  assertEquals(
    isPlausibleLabelResult({ roastDate: "2026-07-01" }),
    true,
    "roastDate is a recognized label field",
  );
});

Deno.test("isPlausibleLabelResult rejects an empty object", () => {
  assertEquals(
    isPlausibleLabelResult({}),
    false,
    "an empty object has no error string and no recognized label fields",
  );
});

Deno.test("isPlausibleLabelResult rejects non-object and array inputs", () => {
  assertEquals(isPlausibleLabelResult(null), false, "null is not plausible");
  assertEquals(isPlausibleLabelResult(undefined), false, "undefined is not plausible");
  assertEquals(isPlausibleLabelResult("string"), false, "a bare string is not plausible");
  assertEquals(isPlausibleLabelResult(42), false, "a number is not plausible");
  assertEquals(isPlausibleLabelResult([]), false, "an array is not plausible, even when empty");
});

// ---------------------------------------------------------------------------
// shouldFallbackProviderError
// ---------------------------------------------------------------------------

Deno.test("shouldFallbackProviderError advances on provider 4xx responses", () => {
  for (const status of [400, 401, 403, 404, 408, 413, 422, 429]) {
    assertEquals(
      shouldFallbackProviderError(status),
      true,
      `provider HTTP ${status} should advance to the next configured provider`,
    );
  }
});

Deno.test("shouldFallbackProviderError advances on provider 5xx responses", () => {
  for (const status of [500, 502, 503, 599]) {
    assertEquals(
      shouldFallbackProviderError(status),
      true,
      `provider HTTP ${status} should advance to the next configured provider`,
    );
  }
});

Deno.test("shouldFallbackProviderError advances on network and parse failures", () => {
  assertEquals(
    shouldFallbackProviderError(undefined),
    true,
    "errors without an HTTP status should advance to the next provider",
  );
});

Deno.test("shouldFallbackProviderError rejects non-error HTTP statuses", () => {
  for (const status of [200, 302, 399, 600]) {
    assertEquals(
      shouldFallbackProviderError(status),
      false,
      `HTTP ${status} is outside the provider-error range`,
    );
  }
});

// ---------------------------------------------------------------------------
// needsRoastDateConfirmation
// ---------------------------------------------------------------------------

Deno.test("needsRoastDateConfirmation flags a null roastDate", () => {
  assertEquals(
    needsRoastDateConfirmation({ roastDate: null, roastDateRawText: null }),
    true,
    "no roastDate means nothing to confirm",
  );
});

Deno.test("needsRoastDateConfirmation accepts raw text containing a 4-digit year", () => {
  assertEquals(
    needsRoastDateConfirmation({
      roastDate: "2026-06-26",
      roastDateRawText: "26.06.2026",
    }),
    false,
    "raw text with an explicit 4-digit year is unambiguous",
  );
});

Deno.test("needsRoastDateConfirmation flags raw text with no year, e.g. \"02/08\"", () => {
  assertEquals(
    needsRoastDateConfirmation({
      roastDate: "2026-08-02",
      roastDateRawText: "02/08",
    }),
    true,
    "no 4-digit run means the label printed no year — DD/MM vs MM/DD is genuinely ambiguous",
  );
});

Deno.test("needsRoastDateConfirmation flags raw text like \"26.06.26\" (2-digit year)", () => {
  assertEquals(
    needsRoastDateConfirmation({
      roastDate: "2026-06-26",
      roastDateRawText: "26.06.26",
    }),
    true,
    "a 2-digit year has no 4-digit run and is genuinely ambiguous",
  );
});

Deno.test("needsRoastDateConfirmation flags a missing roastDateRawText", () => {
  assertEquals(
    needsRoastDateConfirmation({ roastDate: "2026-06-26" }),
    true,
    "a roastDate we cannot trace back to printed text is not verifiable",
  );
});

Deno.test("needsRoastDateConfirmation flags an empty roastDateRawText", () => {
  assertEquals(
    needsRoastDateConfirmation({
      roastDate: "2026-06-26",
      roastDateRawText: "   ",
    }),
    true,
    "a blank raw text is treated the same as a missing one",
  );
});

Deno.test("needsRoastDateConfirmation does NOT flag a week/month-only date with a year (known, accepted gap)", () => {
  // "4a semana de Marzo 2026" carries a 4-digit year, so this passes the
  // syntactic check even though "which week" is itself imprecise. This is 1
  // of 150 labels in the measured sample and is deliberately left to the
  // existing future/too_old backstop and the user rather than adding another
  // locale-specific heuristic here.
  assertEquals(
    needsRoastDateConfirmation({
      roastDate: "2026-03-01",
      roastDateRawText: "4a semana de Marzo 2026",
    }),
    false,
    "known gap: week/month-only text with a year is not flagged",
  );
});
