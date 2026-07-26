/**
 * Pure helpers extracted from parse-coffee-label for LLM prompt/cost
 * optimization (see plans/002-parse-coffee-label-prompt-optimization.md).
 *
 * Everything here is a pure function — no env reads, no network calls, no
 * Deno-global side effects at module load — so it can be unit tested without
 * bootstrapping the function's Supabase/provider clients.
 */

// ---------------------------------------------------------------------------
// Shared structured-output schema (Item 4)
// ---------------------------------------------------------------------------

type LabelFieldType = "string" | "number";

// Field -> type map for the coffee-label extraction result. `harvestDate` is
// intentionally NOT included here: the model is never asked to produce it —
// normalizeResult() force-sets it to null (Item 1) because the label image
// never carries harvest-date data.
const LABEL_FIELDS: Record<string, LabelFieldType> = {
  roaster: "string",
  name: "string",
  origin: "string",
  farm: "string",
  farmer: "string",
  variety: "string",
  processingMethod: "string",
  elevation: "number",
  roastDate: "string",
  region: "string",
  roastLevel: "string",
  cuppingScore: "number",
  tastingNotes: "string",
  packageWeightGrams: "number",
};

const ROAST_DATE_ONLY_FIELDS: Record<string, LabelFieldType> = {
  roastDate: "string",
};

// deno-lint-ignore no-explicit-any
type JsonSchema = Record<string, any>;

function buildOpenAiProperties(
  fields: Record<string, LabelFieldType>,
  includeError: boolean,
): JsonSchema {
  const properties: JsonSchema = {};
  for (const [key, type] of Object.entries(fields)) {
    properties[key] = { type: [type, "null"] };
  }
  if (includeError) {
    properties.error = { type: ["string", "null"] };
  }
  return properties;
}

function buildGeminiProperties(
  fields: Record<string, LabelFieldType>,
  includeError: boolean,
): JsonSchema {
  const properties: JsonSchema = {};
  for (const [key, type] of Object.entries(fields)) {
    properties[key] = { type, nullable: true };
  }
  if (includeError) {
    properties.error = { type: "string", nullable: true };
  }
  return properties;
}

export interface ProviderResponseSchema {
  /** Schema name — used for OpenAI's `response_format.json_schema.name`. */
  name: string;
  /** OpenAI-compatible JSON Schema, used by OpenAI's `json_schema` response_format. */
  openai: JsonSchema;
  /** Vertex AI / Gemini OpenAPI-style schema, used by `generationConfig.responseSchema`. */
  gemini: JsonSchema;
}

/**
 * Decide whether a failed provider attempt may advance to the next configured
 * provider. HTTP failures are provider-local: even a 4xx can represent an
 * unsupported model parameter, expired provider credential, provider-specific
 * image limit, or moderation decision that another provider can handle.
 *
 * The chain itself is bounded, so allowing one attempt per configured provider
 * cannot loop indefinitely. Request validation and invocation limits happen
 * before the provider chain and therefore remain terminal.
 */
export function shouldFallbackProviderError(
  status?: number,
): boolean {
  if (status === undefined) {
    return true; // network, timeout, response-shape, or JSON-parse failure
  }
  return status >= 400 && status <= 599;
}

/** Full coffee-label extraction schema, shared across all four providers. */
export const LABEL_RESPONSE_SCHEMA: ProviderResponseSchema = {
  name: "coffee_label",
  openai: {
    type: "object",
    properties: buildOpenAiProperties(LABEL_FIELDS, true),
  },
  gemini: {
    type: "object",
    properties: buildGeminiProperties(LABEL_FIELDS, true),
  },
};

/** roastDate-only schema used for the strict roast-date re-check round trip. */
export const ROAST_DATE_RESPONSE_SCHEMA: ProviderResponseSchema = {
  name: "roast_date_recheck",
  openai: {
    type: "object",
    properties: buildOpenAiProperties(ROAST_DATE_ONLY_FIELDS, false),
  },
  gemini: {
    type: "object",
    properties: buildGeminiProperties(ROAST_DATE_ONLY_FIELDS, false),
  },
};

// ---------------------------------------------------------------------------
// Prompt layout (Items 2 & 5)
// ---------------------------------------------------------------------------

export interface BuildSystemPromptArgs {
  locale: string;
  today: string;
  ocrText?: string | null;
}

// Static instruction + rules + JSON-structure block. Zero interpolations by
// design (Item 5) so provider-side prompt-prefix caching can key off an
// identical prefix on every request; only the trailing "Locale / Today" line
// (and optional OCR block) vary per call. Requesting JSON explicitly here
// (twice) also satisfies Groq/Cerebras json_object mode, which requires the
// word "JSON" to appear in the prompt.
const STATIC_PROMPT =
  `Extract the following fields from the image and respond in JSON format as a single JSON object (do not return an array). If there are multiple images, combine the info into one response. Translate suitable fields to the target locale.

Roast date rules:
- The roast date can never be after today's date.
- Coffee bags often print a best-by/expiration date (typically 12-24 months after roasting) — never return that as roastDate; if only a best-by/expiration date is printed, return null.
- If no explicit roast date is visible on the label, return null rather than guessing.

Use null for any field that is not visible on the label — never "Unknown", "N/A", or "".

Use the following JSON structure:
  {
    "roaster": "roaster",
    "name": "name (translated to the target locale)",
    "origin": "origin (country of origin, translated to the target locale)",
    "farm": "farm",
    "farmer": "farmer",
    "variety": "variety",
    "processingMethod": "Processing Method (translated to the target locale)",
    "elevation": "elevation (number only)",
    "roastDate": "roast date (YYYY-MM-DD; if the label omits the year, infer it from today's date)",
    "region": "region (region of country of origin, translated to the target locale)",
    "roastLevel": "roast level (translated to the target locale)",
    "cuppingScore": "cupping score",
    "tastingNotes": "tasting notes (translated to the target locale, separated by comma, Capitalized. No untranslated notes.)",
    "packageWeightGrams": "number, up to 2 decimal places, min. value 0.1"
  }
  If no coffee labels are detected in any images, return:
  { "error": "No coffee labels detected" }`;

/**
 * Build the parse-coffee-label system prompt. The returned string is always
 * `STATIC_PROMPT` (byte-identical regardless of `locale`/`today`) followed by
 * a dynamic tail carrying the per-request locale/date, and an optional OCR
 * context block.
 */
export function buildSystemPrompt(
  { locale, today, ocrText }: BuildSystemPromptArgs,
): string {
  let prompt =
    `${STATIC_PROMPT}\n\nTarget locale: ${locale} — write every field marked "translated to the target locale" in that language, translating from the label's language when needed. Today's date: ${today}.`;
  if (ocrText && ocrText.trim().length > 0) {
    prompt = `${prompt}\n\nAdditional OCR context from mobile device: ${ocrText}`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Deterministic post-processing (Items 1 & 3)
// ---------------------------------------------------------------------------

const TITLE_CASE_FIELDS = new Set([
  "roaster",
  "name",
  "variety",
  "region",
  "tastingNotes",
]);

function hasLetters(value: string): boolean {
  return /\p{L}/u.test(value);
}

/**
 * Title-cases `value` (e.g. "ETHIOPIA HEIRLOOM" -> "Ethiopia Heirloom") only
 * when it is entirely uppercase; mixed-case values pass through untouched.
 * Uses plain (non-locale) case conversion so behavior doesn't depend on the
 * server's ICU locale, but still handles non-ASCII letters (e.g. "CAFÉ")
 * correctly via unicode-aware word matching.
 */
export function titleCaseIfAllCaps(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  if (!hasLetters(value)) return value;
  if (value !== value.toUpperCase() || value === value.toLowerCase()) {
    return value; // not entirely uppercase (or has no letters with case at all)
  }
  return value.toLowerCase().replace(
    /\p{L}+/gu,
    (word) => word.charAt(0).toUpperCase() + word.slice(1),
  );
}

// tastingNotes is a comma-separated string; title-case each item
// independently so mixed-case lists ("FLORAL, Chocolate") only get the
// all-caps items rewritten.
function normalizeTastingNotes(value: string): string {
  return value
    .split(",")
    .map((item) => titleCaseIfAllCaps(item.trim()))
    .join(", ");
}

const NULL_TOKENS = new Set(["unknown", "n/a", "-"]);

function isNullToken(trimmed: string): boolean {
  return trimmed.length === 0 || NULL_TOKENS.has(trimmed.toLowerCase());
}

/**
 * Guards against a model returning something that isn't actually a label
 * extraction — e.g. a provider echoing back the JSON Schema it was given
 * (`{"$schema": ..., "type": "object", "properties": {}}`) instead of
 * populated fields. `normalizeResult` alone can't catch this: it only checks
 * for "is this an object" and will happily force-add `harvestDate: null` to
 * any such junk object, making it look like a valid (if empty) result.
 *
 * Returns true iff `result` is a non-null, non-array object that is either
 * the `{ error: string }` sentinel envelope, or has at least one own key
 * present in `LABEL_FIELDS`. `harvestDate` is deliberately excluded from
 * `LABEL_FIELDS` (see note above it) so a schema echo with a
 * normalizeResult-appended `harvestDate: null` still fails this check.
 */
export function isPlausibleLabelResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const record = result as Record<string, unknown>;
  if (typeof record.error === "string") {
    return true;
  }
  return Object.keys(record).some((key) =>
    Object.prototype.hasOwnProperty.call(LABEL_FIELDS, key)
  );
}

/**
 * Normalize a parsed model response into the shape the Flutter client
 * expects:
 * - null-token cleanup ("Unknown"/"unknown"/"N/A"/"n/a"/""/whitespace/"-" -> null)
 * - title-casing of all-caps text fields
 * - forcing `harvestDate` to null on real extraction results
 * - dropping a schema-driven `error: null`/`undefined` property so it never
 *   leaks into the client-facing JSON
 *
 * Never rewrites the `error` field's own value — the
 * `{ "error": "No coffee labels detected" }` sentinel is passed through
 * unchanged.
 */
export function normalizeResult(parsedContent: unknown): unknown {
  const result = Array.isArray(parsedContent)
    ? parsedContent[0]
    : parsedContent;
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;

  // Structured-output providers may emit `"error": null` on every successful
  // response since `error` is a defined (if not required) schema property —
  // drop it so it never appears in the client-facing JSON.
  if (
    Object.prototype.hasOwnProperty.call(record, "error") &&
    (record.error === null || record.error === undefined)
  ) {
    delete record.error;
  }

  const isErrorEnvelope = typeof record.error === "string";

  for (const key of Object.keys(record)) {
    if (key === "error") continue; // never null-normalize/rewrite the sentinel value
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (isNullToken(trimmed)) {
      record[key] = null;
      continue;
    }
    if (TITLE_CASE_FIELDS.has(key)) {
      record[key] = key === "tastingNotes"
        ? normalizeTastingNotes(value)
        : titleCaseIfAllCaps(value);
    }
  }

  // harvestDate is never supplied by the model (Item 1) — force it to null,
  // but skip the error envelope and the roastDate-only strict-recheck
  // response (which has no keys other than roastDate).
  if (!isErrorEnvelope && Object.keys(record).length > 1) {
    record.harvestDate = null;
  }

  return record;
}
