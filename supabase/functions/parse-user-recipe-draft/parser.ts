import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { GEMINI_DEFAULT_MODEL, OPENAI_MODELS } from "../_shared/ai-models.ts";
import {
  type ProvenanceFinding,
  type RenderedAmount,
  type RenderedTimingStep,
  type TimingLandmark,
  type TimingProvenanceFinding,
  verifyAmountProvenance,
  verifyTimingProvenance,
} from "./provenance.ts";

export type LlmProviderName = "groq" | "cerebras" | "openai" | "gemini";

export type Logger = Pick<Console, "info" | "warn" | "error">;

export type BrewingMethodOption = {
  brewing_method_id: string;
  brewing_method: string;
};

export const parseUserRecipeDraftRequestSchema = z.object({
  text: z.string().trim().min(1, "text is required"),
  brewing_method_id: z.string().trim().min(1).optional(),
  source_language_hint: z.string().trim().min(1).optional(),
  // Lets callers opt into the conservative "verify" parser mode (used by
  // the sibling verify-user-recipe-draft function). Omitted/undefined must
  // keep today's behaviour, which defaults to "extract" inside
  // parseDraft — see RecipeDraftParserInput.mode.
  mode: z.enum(["extract", "verify"]).optional(),
  // Opt-in per-stage diagnostic capture (see plans/011-recipe-draft-lab-
  // live-test-runbook.md in the timer-coffee-landing-2 repo). OFF unless the
  // caller explicitly asks: capturing raw provider output persists it to
  // service.parse_user_recipe_draft_captures, which is only worth the
  // storage/size-guard overhead when a tester is deliberately building a
  // replayable fixture. Gated by nothing beyond the recipe-draft-lab access
  // check the handler already requires to reach this function at all — no
  // separate per-account feature flag.
  capture_stages: z.boolean().default(false),
});

// G22: mirrors provenance.ts's AmountProvenance type exactly (see that
// file's own comments for what each field means and how it's checked).
// value/unit/step_index/provenance are the identity of the record and stay
// required — a malformed record is better rejected outright (triggering the
// existing provider-retry machinery) than silently accepted as garbage.
// The four class-specific fields are nullable+defaulted because provenance.ts
// itself types them as `| null` unconditionally: a literal record has no
// rule_*, a derived record has no source_quote, and neither the type nor
// the runtime check requires the "other" class's fields to be present.
const amountProvenanceSchema = z.object({
  value: z.number(),
  unit: z.string().trim().min(1),
  step_index: z.number().int(),
  provenance: z.enum(["literal", "derived", "inferred"]),
  source_quote: z.string().trim().min(1).nullable().default(null),
  rule: z.string().trim().min(1).nullable().default(null),
  rule_source_quote: z.string().trim().min(1).nullable().default(null),
  // Widened from z.record(z.number()) for sum_of_parts, whose `parts`
  // operand is an ARRAY of the stated components rather than a scalar —
  // every other rule's operands are scalars and still validate unchanged.
  // Deliberately not z.any(): only numbers and numeric arrays are accepted,
  // and provenance.ts's recompute reads `parts` with its own
  // length/finiteness checks and fails closed on anything else.
  rule_inputs: z.record(z.union([z.number(), z.array(z.number())]))
    .nullable().default(null),
  // C1 (plan 016 §3 D1-vocabulary, §4 Phase 1b — an agreed cross-agent
  // contract with provenance.ts's owner; this shape must match exactly).
  // The model's own semantic classification of `unit`'s DIMENSION,
  // independent of what word or script it wrote the unit in. Exists
  // because provenance.ts's unit-comparison lexicon is English+Russian
  // only, so an Arabic/Persian unit (جرام, گرم, میلی‌لیتر) fails to
  // normalize against a rendered ASCII "g"/"ml" and reports as
  // untraceable even when the amount is correct. Per CLAUDE.md, the model
  // already read the (multilingual) source text and is the right place to
  // resolve this — the lexicon in provenance.ts remains only as a labelled
  // fallback for when this field is absent. mass and volume are mutually
  // compatible (density≈1 precedent for water); time and percent are
  // compatible with neither — see provenance.ts for the consuming logic
  // (owned by a different agent; not touched here).
  //
  // Nullable + `.optional()` rather than `.default()`, deliberately: old
  // captures, the six golden fixtures, and every existing ExtractionResult/
  // NormalizedDraft object literal in this test suite predate this field
  // and have neither key at all. `.optional()` lets the key be entirely
  // absent (not just null) without failing parse, so an absent field can
  // never make a previously-passing draft fail — the same backward-
  // compatibility contract CLAUDE.md requires for this kind of addition.
  unit_kind: z.enum(["mass", "volume", "time", "percent"]).nullable()
    .optional(),
  // C2 (plan 016 §3 D4′, §4 Task C). When the source states this amount as
  // a range, both endpoints — prompted for regardless of which `rule` (if
  // any) the model ultimately records the value under. Exists because a
  // collapsed range does not reliably use the range_endpoint rule: a
  // Chemex capture's "60-90g" bloom collapsed to a single LITERAL 60
  // record with no rule at all, so rule_inputs (D4's original detection
  // surface) had nothing to find — the 90 was simply absent from
  // extracted_amounts. stated_range is prompted independently of
  // provenance/rule so the high endpoint survives somewhere even when the
  // rest of the pipeline collapses the rendered amount to one endpoint.
  // See findRangeEndpointCollapseIssues below for the consuming check.
  //
  // Same backward-compatibility reasoning as unit_kind: `.nullable()
  // .optional()`, never `.default()` — absent on every pre-existing
  // capture and fixture, and must never fail a previously-passing draft.
  //
  // Honesty note (carried into this file's final report, not just here): a
  // prompted field does not bind any more reliably than the range_endpoint
  // rule did. This reduces how often the Chemex-shaped failure occurs; it
  // does not guarantee catching it. A guarantee would require deterministic
  // range detection over multilingual source prose, which is exactly the
  // semantic-judgement-via-regex CLAUDE.md forbids.
  stated_range: z.object({
    low: z.number(),
    high: z.number(),
  }).nullable().optional(),
});

const extractedStepSchema = z.object({
  title: z.string().trim().min(1).nullable().default(null),
  raw_text: z.string().trim().min(1),
  duration_seconds: z.number().int().nonnegative().nullable().default(null),
  // Elapsed brew time, measured from timer start, at which this step's
  // action begins. This is an elapsed timestamp, NOT a duration. Null when
  // not stated by the source.
  elapsed_seconds: z.number().int().nonnegative().nullable().default(null),
  // True for the single step where the recipe says to start the timer /
  // begin the first pour. A model that omits this must not fail the stage.
  starts_timer: z.boolean().default(false),
  // True only when the source text explicitly gives a duration for THIS
  // step (e.g. "steep for 18 hours", "bloom for 45 seconds"). False when
  // the duration was inferred, estimated, or carried over from a stated
  // total. An elapsed timestamp ("at 1:30") is not a stated duration — see
  // elapsed_seconds. A model that omits this must not fail the stage.
  duration_is_stated: z.boolean().default(false),
  // F5: amounts in THIS step's raw_text that are genuine recipe
  // quantities — coffee or water that this recipe's own brew actually
  // uses — and therefore should scale with the recipe. Never equipment
  // capacities, product specifications, filter/paper weights, ratios
  // quoted as an aside, comparisons to other recipes, or commentary. A
  // model that omits this must not fail the stage; when empty,
  // convertNumericValuesToExpressions falls back to its prior
  // regex-only heuristic so scaling doesn't silently stop working.
  scalable_amounts: z.array(
    z.object({
      value: z.number(),
      unit: z.string().trim().min(1),
    }),
  ).default([]),
  // E4 (plan 023): numeric rates mentioned by this step, represented by
  // their numerator value/unit (for example 5 g in "5 grams per second").
  // These are not recipe quantities and must neither scale nor enter amount
  // provenance. The multilingual extraction model makes the semantic call;
  // an English rate regex remains only as a compatibility fallback. Optional
  // so stored captures and pre-existing typed fixtures continue to parse.
  rate_amounts: z.array(
    z.object({
      value: z.number(),
      unit: z.string().trim().min(1),
    }),
  ).nullable().optional(),
  // Phase C3 (F29): labels what this step DOES — independent of the
  // language it's written in — so role-detection (isDrawdownLikeStep, and
  // bloom/drawdown selection in splitDerivedBrewStepDurationsFromTarget)
  // can read this instead of matching English-only keyword regexes
  // against the step's own text. Nullable + defaulted so a model that
  // omits it cannot fail the stage; null means every role-detection
  // function falls back to its pre-C3 English-only regex/heuristic
  // exactly as before this field existed.
  step_role: z.enum([
    "preparation",
    "bloom",
    "pour",
    "stir",
    "drawdown",
    "serve",
  ]).nullable().default(null),
});

export const extractionSchema = z.object({
  detected_input_language: z.string().trim().min(1).nullable().default(null),
  likely_brewing_method: z.string().trim().min(1).nullable().default(null),
  name: z.string().trim().min(1).nullable().default(null),
  short_description: z.string().trim().min(1).nullable().default(null),
  grind_size: z.string().trim().min(1).nullable().default(null),
  // F19: mirrors extractedStepSchema.duration_is_stated's convention — a
  // semantic judgement about what the source text actually contained,
  // reported by the stage that read it, rather than reverse-engineered
  // from the string's shape afterward. True only when the source text
  // itself described a grind size; false (the default) when grind_size
  // was inferred from the brewing method (see the extraction prompt's
  // inference fallback) or the field predates this flag. Deliberately
  // `.optional()` rather than `.default()`: unlike duration_is_stated
  // (added when every call site was still under active development),
  // this field is landing after ExtractionResult object literals already
  // exist throughout this codebase's test suites — some of them (e.g.
  // verify-user-recipe-draft/handler_test.ts) out of scope for this
  // change — so the TS type must stay optional to avoid forcing every
  // existing literal to add it. Always read via `?? false`, never assume
  // presence; see buildGrindSizeWarnings below, the only consumer.
  grind_size_is_stated: z.boolean().optional(),
  water_temp_celsius: z.number().nullable().default(null),
  // Phase E (plan 020 D5). The extraction AND normalization stages were
  // each independently doing Fahrenheit->Celsius arithmetic for a STATED
  // RANGE and writing their own free-text warning describing what they
  // did — and both were unreliable: `019`'s live run found the arithmetic
  // wrong (195-205°F emitted as 96.1°C in 4/4, which is 205°F, the HIGH
  // endpoint, not a midpoint as claimed) and the warning text confidently
  // describing a computation that did not match the number produced. A
  // wrong explanation is worse than an open question
  // (HANDOFF-2026-08-12.md §7) because it stops a reviewer looking further.
  //
  // This field asks for literal transcription only — no arithmetic, no
  // endpoint choice, mirroring amountProvenanceSchema.stated_range above —
  // so the one thing the model was getting wrong (a subtraction, a
  // multiplication, and a rounding) is instead done deterministically in
  // code (see resolveWaterTempStatedRange/normalizeDraftTemperatures
  // below), and the warning describing it is generated from that same
  // computation so the two can never disagree.
  //
  // Nullable + `.optional()`, not `.default()`: every existing
  // ExtractionResult object literal in this test suite AND in
  // verify-user-recipe-draft/handler_test.ts (out of scope for this
  // change — see plan 020 Phase E's file-ownership rule) predates this
  // field, the same backward-compatibility reasoning as unit_kind/
  // stated_range on amountProvenanceSchema above. Always read via
  // `?? null`, never assume presence.
  //
  // Honesty note, same as amountProvenanceSchema.stated_range above: a
  // prompted field does not bind any more reliably than any other prompt
  // instruction. This does not guarantee the model transcribes the range
  // instead of still trying to compute a single value itself — it only
  // gives code a value to prefer WHEN the model does supply it, and
  // whether it reliably does is unverifiable offline; see this phase's
  // final report.
  water_temp_stated_range: z.object({
    low: z.number(),
    high: z.number(),
    unit: z.enum(["celsius", "fahrenheit"]),
  }).nullable().optional(),
  coffee_amount_grams: z.number().positive().nullable().default(null),
  water_amount: z.number().positive().nullable().default(null),
  preparation: z.string().trim().min(1).nullable().default(null),
  steps: z.array(extractedStepSchema).min(1),
  notes: z.array(z.string()).default([]),
  // The recipe's stated total brew time target, in seconds. Must come only
  // from a statement about this recipe's own brew. Null when not stated.
  total_brew_time_seconds: z.number().int().positive().nullable().default(
    null,
  ),
  // Phase A/E1 (plan 023): whether the source presents the stated total as
  // approximate rather than exact. This is a semantic judgement made by the
  // multilingual extraction model; do not replace it with an English keyword
  // regex. Optional for backward compatibility with stored captures and the
  // many pre-existing ExtractionResult literals in the test suite. Consumers
  // must read it through `?? null`.
  total_brew_time_is_approximate: z.boolean().nullable().optional(),
  // Phase A/E1 (plan 023): the source's stated total may be a range even
  // when total_brew_time_seconds contains one landmark or a model-selected
  // point. The range is authoritative for the final timing gate whenever it
  // is present; see resolveTotalBrewTimeStatedRange below.
  //
  // Nullable + `.optional()`, never `.default()`, for the exact same
  // backward-compatibility reason as water_temp_stated_range: existing
  // fixtures/captures and ExtractionResult literals predate this field and
  // must continue to parse with the key entirely absent.
  //
  // Like every prompt-populated field, reliable live adoption cannot be
  // established offline. The deterministic gate is reliable when the field
  // is supplied; whether providers consistently supply it needs a live run.
  total_brew_time_stated_range: z.object({
    low: z.number(),
    high: z.number(),
  }).nullable().optional(),
  // G22: provenance records for every numeric amount this stage emitted
  // (recipe-level coffee_amount_grams/water_amount and every step's own
  // amounts). Top-level rather than nested per-step, because each record
  // already self-identifies its step via step_index (-1 for a recipe-level
  // amount) — unlike scalable_amounts, a record here is not naturally
  // "inside" any one step object. Defaulted so a model/provider that
  // predates this field does not fail extraction; verifyAmountProvenance
  // degrades an empty array to a single non-blocking warning rather than
  // treating it as zero amounts to verify (see provenance.ts).
  extracted_amounts: z.array(amountProvenanceSchema).default([]),
});

const normalizedStepSchema = z.object({
  kind: z.enum(["preparation", "brew"]),
  description_source: z.string().trim().min(1),
  description_template: z.string().trim().min(1),
  duration_seconds: z.number().int().nonnegative(),
  elapsed_seconds: z.number().int().nonnegative().nullable().default(null),
  starts_timer: z.boolean().default(false),
  // See extractedStepSchema.duration_is_stated — carried through unchanged.
  duration_is_stated: z.boolean().default(false),
  // See extractedStepSchema.scalable_amounts — carried through unchanged
  // (split or merge this list along with the step it describes).
  scalable_amounts: z.array(
    z.object({
      value: z.number(),
      unit: z.string().trim().min(1),
    }),
  ).default([]),
  // See extractedStepSchema.rate_amounts — carried through with the step.
  rate_amounts: z.array(
    z.object({
      value: z.number(),
      unit: z.string().trim().min(1),
    }),
  ).nullable().optional(),
  // See extractedStepSchema.step_role — carried through unchanged (or
  // reassigned if a step is split/merged and its role no longer applies
  // cleanly to the resulting step).
  step_role: z.enum([
    "preparation",
    "bloom",
    "pour",
    "stir",
    "drawdown",
    "serve",
  ]).nullable().default(null),
});

export const normalizedDraftSchema = z.object({
  detected_input_language: z.string().trim().min(1).nullable().default(null),
  warnings: z.array(z.string()).default([]),
  recipe: z.object({
    brewing_method_id: z.string().trim().min(1).nullable().default(null),
    brewing_method_confidence: z
      .enum(["high", "medium", "low", "none"])
      .default("none"),
    coffee_amount: z.number().positive().nullable().default(null),
    water_amount: z.number().positive().nullable().default(null),
    water_temp: z.number().positive().nullable().default(null),
  }),
  localization: z.object({
    name: z.string().trim().min(1).nullable().default(null),
    grind_size: z.string().trim().min(1).nullable().default(null),
    short_description: z.string().trim().min(1).nullable().default(null),
  }),
  steps: z.array(normalizedStepSchema).min(1),
  // See extractedStepSchema.extracted_amounts above — carried through
  // unchanged from extraction (or updated by normalization/repair if step
  // splits/merges require re-pointing a record's step_index). Top-level,
  // like warnings, not nested per step.
  extracted_amounts: z.array(amountProvenanceSchema).default([]),
});

const cumulativeRewriteSchema = z.object({
  warnings: z.array(z.string()).default([]),
  steps: z.array(normalizedStepSchema).min(1),
});

export type ParseUserRecipeDraftRequest = z.infer<
  typeof parseUserRecipeDraftRequestSchema
>;
export type ExtractionResult = z.infer<typeof extractionSchema>;
export type NormalizedDraft = z.infer<typeof normalizedDraftSchema>;
export type CumulativeRewriteResult = z.infer<typeof cumulativeRewriteSchema>;

export type DraftExpression = {
  placeholder: "<final_coffee_amount>" | "<final_water_amount>";
  multiplier: number;
  unit: string;
  preview_value: number | null;
};

export type ValidationIssue = {
  code: string;
  field: string;
  message: string;
};

export type DraftStep = {
  step_order: number;
  kind: "preparation" | "brew";
  description_source: string;
  description_template: string;
  preview_text: string;
  duration_seconds: number;
  elapsed_seconds: number | null;
  starts_timer: boolean;
  duration_is_stated: boolean;
  // See extractedStepSchema.scalable_amounts.
  scalable_amounts: Array<{ value: number; unit: string }>;
  // See extractedStepSchema.rate_amounts. Internal provenance metadata; it
  // is additive alongside the already-exposed scalable_amounts field.
  rate_amounts?: Array<{ value: number; unit: string }>;
  // See extractedStepSchema.step_role.
  step_role:
    | "preparation"
    | "bloom"
    | "pour"
    | "stir"
    | "drawdown"
    | "serve"
    | null;
  expressions: DraftExpression[];
};

export type PublishProjection = {
  user_recipe: {
    id: string;
    brewing_method_id: string;
    coffee_amount: number;
    water_amount: number;
    water_temp: number;
    brew_time: number;
    vendor_id: string;
    last_modified: string;
    import_id: null;
    is_imported: false;
    ispublic: false;
    is_deleted: false;
    needs_moderation_review: false;
  };
  user_recipe_localization: {
    id: string;
    recipe_id: string;
    locale: "en";
    name: string;
    grind_size: string;
    short_description: string;
  };
  user_steps: Array<{
    id: string;
    recipe_id: string;
    step_order: number;
    description: string;
    time: string;
    locale: "en";
  }>;
};

// Phase E (Task 3): records what actually ran per stage, so a response can
// no longer misattribute a stage to a provider that didn't serve it (the
// F12 telemetry lie — e.g. extraction served by one Groq model while
// normalization fell through to another, with only the latter reported).
// One entry per provider ATTEMPTED for a stage, in the order attempted,
// whether that attempt ultimately succeeded or exhausted its retries and
// fell through to the next provider.
export type ProviderTrailEntry = {
  stage: string;
  provider: string;
  model: string;
  attempts: number;
};

// Stage-capture (opt-in via capture_stages): one entry per provider
// invocation ATTEMPTED for a stage — same granularity as ProviderTrailEntry,
// but recording what that specific attempt actually produced rather than
// just the tally. attempt is a 1-based counter that increments across every
// invocation for the stage, spanning both same-provider retries and
// provider-to-provider fallback (mirrors how provider_trail itself
// accumulates across both).
export type StageCaptureEntry = {
  attempt: number;
  provider: string;
  model: string;
  finish_reason: string | null;
  // The provider's raw response text, before JSON parsing — or, for an HTTP
  // error response, the error body. This is deliberately captured even on
  // failure: it is the most valuable thing available when a stage fails.
  raw_text: string;
  // The fully parsed-and-schema-validated result on success; null on any
  // failure (HTTP error, truncation, malformed JSON, or schema validation
  // failure) — see `error` for what went wrong.
  parsed: unknown | null;
  error: string | null;
  // Present (true) only when raw_text was longer than the size guard and
  // had its tail replaced with a truncation marker. Omitted (not false)
  // when no truncation occurred, keeping untruncated entries lean.
  truncated?: true;
};

export type StageOutputs = {
  extraction: StageCaptureEntry[];
  normalization: StageCaptureEntry[];
  repair: StageCaptureEntry[];
  cumulative_rewrite: StageCaptureEntry[];
};

export type ParseUserRecipeDraftResponse = {
  detected_input_language: string | null;
  // Phase E (Task 3): identifies the provider/model that served the
  // EXTRACTION stage — the stage that sets the draft's substance — not
  // whichever provider happened to run last across normalization/repair/
  // cumulative_rewrite. Kept for backward compatibility with existing
  // consumers (the website, invocation logging).
  provider_used: LlmProviderName;
  provider_model_used: string;
  tokens_used: number;
  openai_tokens_used: number;
  warnings: string[];
  validation: {
    is_publishable: boolean;
    issues: ValidationIssue[];
  };
  extraction: ExtractionResult;
  draft: {
    recipe: {
      brewing_method_id: string | null;
      coffee_amount: number | null;
      water_amount: number | null;
      water_temp: number | null;
      brew_time_seconds: number | null;
      vendor_id: string;
    };
    localization: {
      locale: "en";
      name: string | null;
      grind_size: string | null;
      short_description: string | null;
    };
    steps: DraftStep[];
  };
  publish_projection?: PublishProjection;
  // Phase E (Task 3): optional and additive so existing consumers (notably
  // the website's ParseUserRecipeDraftResponse type) keep compiling
  // untouched. Omitted rather than set to an empty array only in the
  // theoretical case parseDraft returns without running any stage, which
  // cannot happen on a successful response.
  provider_trail?: ProviderTrailEntry[];
  // Identifies the row in service.parse_user_recipe_draft_captures holding
  // this run's stage_outputs, when the request set capture_stages: true and
  // the capture insert succeeded. This is the fixture's identity for replay
  // (see plans/011's runbook §5) — null when capture wasn't requested, or
  // when the insert failed (a capture failure must never turn a successful
  // parse into an error response; see handler.ts).
  capture_id: string | null;
  // INTERNAL ONLY — never sent over HTTP. Populated by parseDraft only when
  // input.captureStages is true; handler.ts reads this to build the
  // service.parse_user_recipe_draft_captures row and then strips it before
  // responding to the client. null when capture_stages is off, matching the
  // "zero overhead when off" requirement: nothing is collected or retained
  // beyond the existing provider_trail.
  stage_outputs: StageOutputs | null;
};

type ProviderInvocationStage =
  | "extraction"
  | "normalization"
  | "repair"
  | "cumulative_rewrite";

type ProviderInvocation<T> = {
  requestId: string;
  stage: ProviderInvocationStage;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  // F10: each stage states its own output-token ceiling rather than every
  // provider call sharing one hardcoded limit — extraction and
  // normalization/repair/cumulative_rewrite produce very differently sized
  // JSON payloads, and Phases B/B2/C added four new per-step fields that
  // made the old single 2500-token ceiling too easy to blow through.
  maxCompletionTokens: number;
  // Stage-capture hook (opt-in via capture_stages): called exactly once per
  // invokeJson call, with the outcome of THAT call — before invokeJson
  // returns or throws. Undefined/no-op when capture is off, so a provider
  // implementation need only ever do `input.onAttempt?.(...)` and pay no
  // cost when nobody is listening.
  onAttempt?: (info: {
    rawText: string;
    finishReason: string | null;
    parsed: T | null;
    error: string | null;
  }) => void;
};

// F10: clearly-typed so callers can recognize "the model ran out of output
// tokens" and react (retry, surface a real reason) instead of it silently
// surfacing as an opaque JSON.parse failure once the truncated payload
// fails to parse.
export class ProviderTruncationError extends Error {
  readonly providerName: LlmProviderName;
  readonly model: string;
  readonly stage: ProviderInvocationStage;

  constructor(args: {
    providerName: LlmProviderName;
    model: string;
    stage: ProviderInvocationStage;
  }) {
    super(
      `${args.providerName}:${args.model} response was truncated by the output-token limit during the "${args.stage}" stage.`,
    );
    this.name = "ProviderTruncationError";
    this.providerName = args.providerName;
    this.model = args.model;
    this.stage = args.stage;
  }
}

export type RecipeDraftAiProvider = {
  name: LlmProviderName;
  model: string;
  invokeJson<T>(
    input: ProviderInvocation<T>,
  ): Promise<{ result: T; tokensUsed: number }>;
};

export type RecipeDraftParserConfig = {
  // Phase E: buildProviders' DEFAULT provider list (used when
  // config.providers is not injected) no longer reads these — Groq and
  // Cerebras were removed from the default cascade (see buildProviders).
  // Kept here only so existing callers that still pass them (e.g.
  // verify-user-recipe-draft/index.ts) keep type-checking unchanged; they
  // are otherwise dead unless a caller injects its own config.providers
  // that uses them directly.
  groqApiKey?: string;
  cerebrasApiKey?: string;
  openAiApiKey?: string;
  geminiServiceAccountKeyJson?: string;
  geminiProjectId?: string;
  geminiRegion?: string;
  geminiModel?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  providers?: RecipeDraftAiProvider[];
};

export type RecipeDraftParserMode = "extract" | "verify";

export type RecipeDraftParserInput = {
  text: string;
  userId: string;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
  sourceLanguageHint?: string;
  requestId: string;
  disabledProviders?: LlmProviderName[];
  mode?: RecipeDraftParserMode;
  // Opt-in per-stage diagnostic capture — see
  // parseUserRecipeDraftRequestSchema's capture_stages field. Undefined/
  // false (the default for every existing caller, including
  // verify-user-recipe-draft, which never sets this) means parseDraft
  // collects nothing and returns stage_outputs: null.
  captureStages?: boolean;
};

export type RecipeDraftParser = {
  parseDraft(
    input: RecipeDraftParserInput,
  ): Promise<ParseUserRecipeDraftResponse>;
};

const DEFAULT_GEMINI_MODEL = GEMINI_DEFAULT_MODEL;
const OPENAI_CHAT_COMPLETIONS_URL =
  "https://api.openai.com/v1/chat/completions";
// Phase E: Groq and Cerebras were removed from the default provider cascade
// (see buildProviders below) — their chat-completions endpoint constants
// were only ever referenced from that removed code, so they are deleted
// here as genuinely unreferenced rather than left as dead exports.
// F10: extraction reads the whole transcript and emits one JSON object per
// raw step, so it needs materially more headroom than the other stages,
// which only ever re-emit a bounded number of already-extracted steps.
// Phases B/B2/C's four new per-step fields (elapsed_seconds, starts_timer,
// duration_is_stated, scalable_amounts) made the old single 2500-token
// ceiling too easy to blow through on every stage.
const STAGE_MAX_COMPLETION_TOKENS: Record<ProviderInvocationStage, number> = {
  extraction: 8000,
  normalization: 4000,
  repair: 4000,
  cumulative_rewrite: 4000,
};
const FORBIDDEN_TIME_PLACEHOLDER_REGEX = /<t\d+>/i;
const MIN_BREW_STEP_DURATION_SECONDS = 10;
const FINAL_TIMESTAMPED_STEP_DURATION_SECONDS = 10;
const DRAWDOWN_STEP_DURATION_SECONDS = 30;
// No single brew step duration that this parser infers (as opposed to one
// the source stated explicitly) may exceed this many seconds.
const INFERRED_BREW_STEP_DURATION_CAP_SECONDS = 300;
const UNSUPPORTED_PLACEHOLDER_REGEX = /<([^>]+)>/g;
const SUPPORTED_PLACEHOLDER_REGEX =
  /<(final_coffee_amount|final_water_amount)>/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SCALABLE_UNITS = [
  "g",
  "g.",
  "gs",
  "gr",
  "gr.",
  "grs",
  "ml",
  "ml.",
  "mll",
  "oz",
  "oz.",
  "ozs",
  "l",
  "l.",
  "ls",
  "gram",
  "grams",
  "milliliter",
  "milliliters",
  "ounce",
  "ounces",
  "liter",
  "liters",
  "gramme",
  "grammes",
  "millilitre",
  "millilitres",
  "once",
  "onces",
  "litre",
  "litres",
  "غ",
  "غ.",
  "جرام",
  "جرامات",
  "مل",
  "مل.",
  "ملليلتر",
  "أونصة",
  "لتر",
  "gramo",
  "gramos",
  "mililitro",
  "mililitros",
  "onza",
  "onzas",
  "litro",
  "litros",
  "گرم",
  "گرم.",
  "میلی‌لیتر",
  "اونس",
  "لیتر",
  "gramm",
  "grammen",
  "gramms",
  "unze",
  "unzen",
  "mililiter",
  "ons",
  "grammo",
  "grammi",
  "millilitro",
  "millilitri",
  "oncia",
  "グラム",
  "ミリリットル",
  "オンス",
  "リットル",
  "그램",
  "밀리리터",
  "온스",
  "리터",
  "gramy",
  "mililitr",
  "mililitry",
  "uncja",
  "uncje",
  "litr",
  "litry",
  "grama",
  "gramas",
  "mililitru",
  "mililitri",
  "uncie",
  "uncii",
  "litru",
  "litri",
  "грамм",
  "граммы",
  "миллилитр",
  "миллилитры",
  "унция",
  "унции",
  "литр",
  "литры",
  // Defect 3 (Aug 2026 live pass): short Russian abbreviations, as
  // actually written in real recipes ("20 г", "60 мл") rather than the
  // spelled-out forms above. Without these, a short-form Cyrillic amount
  // was invisible to this regex entirely and never scaled — sorted
  // longest-first below still tries "грамм"/"миллилитр" etc. before these,
  // so a spelled-out word is never mis-split into its short prefix plus
  // leftover letters.
  "г",
  "г.",
  "гр",
  "гр.",
  "мл",
  "мл.",
  "mililitre",
  "грам",
  "грами",
  "мілілітр",
  "мілілітри",
  "унція",
  "унції",
  "літр",
  "літри",
  "克",
  "毫升",
  "盎司",
  "升",
] as const;

// Fix 2 (Aug 2026 live pass): built once, longest-first, so a compound unit
// like "gram"/"gr" is never truncated to a bare prefix that also happens to
// be a valid unit on its own (see NUMERIC_SCALABLE_AMOUNT_REGEX below, which
// shares this exact ordering requirement and independently builds the same
// kind of alternation from the same list).
//
// Deliberately EXCLUDES any SCALABLE_UNITS entry containing a literal "."
// (e.g. "g.", "gr.", "ml.", "l.", and their Arabic/Cyrillic/Persian
// equivalents) — unlike NUMERIC_SCALABLE_AMOUNT_REGEX, which matches a unit
// sitting directly against a bare number in the middle of prose,
// EXPRESSION_REGEX's unit sits right after a ")" that very often *also* ends
// the sentence ("...until you reach the full (1 x <final_water_amount>)g."
// — that final "." terminates the SENTENCE, not the unit). A
// period-inclusive alternative like "g." would greedily consume that
// unrelated sentence period as if it were part of the unit. The
// non-period forms ("g", "gr", "ml", "l", ...) still match fully; only the
// redundant period-suffixed duplicates are dropped, so a genuine "20 g."
// still renders as unit "g" with the period correctly left as trailing
// punctuation — exactly what the old ASCII-denylist version did (it
// excluded "." unconditionally) and what the golden fixtures already
// encode.
const EXPRESSION_UNIT_ALTERNATION = [...SCALABLE_UNITS]
  .filter((unit) => !unit.includes("."))
  .sort((left, right) => right.length - left.length)
  .map((unit) => escapeRegExp(unit))
  .join("|");

// Fix 2 (Aug 2026 live pass): the trailing unit group used to be an
// ASCII-only denylist ([^\s<>().,;:!?\-–—]*), which happily swallowed any
// trailing text that wasn't specifically excluded — including non-ASCII
// punctuation like the Japanese ideographic full stop "。". For a template
// like "(0.316667 x <final_water_amount>)mlまで注ぐ。" (no space between the
// unit and the following clause, as is normal in Japanese), the old pattern
// captured "mlまで注ぐ。" as the "unit", corrupting extractExpressions'
// output at the source — G22 then reported "60mlまで注ぐ。" as an
// unverifiable amount, and the same corrupted unit string was rendered a
// second time anywhere the admin draft-lab shows an expression's unit
// standalone (recipe-draft-lab.tsx's "Proportional amounts" panel: `${
// multiplier} x total, rendered as ${preview_value}${unit}`), which is what
// made it look like the trailing clause was duplicated.
//
// Anchoring the unit capture to the SCALABLE_UNITS allowlist instead of a
// denylist means only a real unit — in any script — is ever captured, and
// nothing past it is swallowed. The group stays optional (a trailing "?")
// because a range's first expression, e.g. the "(0.25 x
// <final_water_amount>)" half of "(0.25 x <final_water_amount>)-(0.32 x
// <final_water_amount>)g", legitimately has no unit of its own immediately
// after it.
const EXPRESSION_REGEX = new RegExp(
  `\\(([\\d.]+)\\s*(?:x|×)\\s*<(final_coffee_amount|final_water_amount)>\\)\\s*(${EXPRESSION_UNIT_ALTERNATION})?`,
  "gi",
);

// Defect 1 (Aug 2026 live pass): this keyword list is an English-only
// fallback signal for resolveAmountPlaceholder — it cannot recognize a
// coffee noun in German ("Kaffee"), French ("café"), Spanish ("café"), or
// any other language. Do not treat this list as sufficient on its own;
// resolveAmountPlaceholder checks the recipe's actual coffee_amount/
// water_amount values (language-agnostic) FIRST, and only falls back to
// this list when that structural check is inconclusive. Widen this list
// only as a labelled, best-effort supplement — never as the primary
// disambiguation mechanism.
const COFFEE_CONTEXT_KEYWORDS = [
  "coffee",
  "bean",
  "beans",
  "ground",
  "grounds",
  "grind",
  "dose",
] as const;
const DIAGNOSTIC_NOTE_KEYWORDS = [
  "infer",
  "inference",
  "ambig",
  "uncertain",
  "confidence",
  "convert",
  "converted",
  "normalize",
  "normalized",
  "repair",
  "repaired",
  "missing",
  "unresolved",
  "resolved",
  "estimate",
  "estimated",
  "approx",
  "fallback",
  "placeholder",
  "expression",
  "fahrenheit",
  "celsius",
  "invalid",
  "schema",
  "malformed",
] as const;
const PREPARATION_DETAIL_KEYWORDS = [
  "rinse",
  "rinsed",
  "filter",
  "paper",
  "silicone",
  "chute",
  "stir stick",
  "stirrer",
  "chopstick",
  "cover",
  "cut",
  "cutting",
  "fold",
  "flap",
  "preheat",
  "pre-heated",
  "discard",
  "tool",
  "modify",
  "modified",
  "bleached",
  "setup",
  "prepare",
  "placed",
  "piece",
] as const;
const ENGLISH_STEP_HINTS = [
  "pour",
  "add",
  "water",
  "bloom",
  "seconds",
  "minute",
  "minutes",
  "rinse",
  "filter",
  "coffee",
  "swirl",
  "drain",
  "drawdown",
] as const;
const SHORT_DESCRIPTION_CONTEXT_PATTERNS = [
  {
    regex: /\bmodified filter(?: setup)?\b/i,
    label: "modified filter",
  },
  {
    regex: /\bsilicone (?:chute )?cover\b/i,
    label: "silicone chute cover",
  },
  {
    regex: /\bbleached filter\b/i,
    label: "bleached filter",
  },
  {
    regex: /\bcloth filter\b/i,
    label: "cloth filter",
  },
  {
    regex: /\bmetal filter\b/i,
    label: "metal filter",
  },
  {
    regex: /\bstaged pours?\b/i,
    label: "staged pours",
  },
  {
    regex: /\bpulsed pours?\b/i,
    label: "pulsed pours",
  },
] as const;
const WATER_CONTEXT_KEYWORDS = [
  "water",
  "pour",
  "pours",
  "bloom",
  "pulse",
  "rinse",
  "rinsed",
  "wet",
  "kettle",
  "drawdown",
  "drain",
  "draining",
  "total",
  "reach",
  "reaching",
] as const;
// F4: recognizes the wording that follows a rate amount (e.g. "9 to 10
// milliliters A SECOND") so convertNumericValuesToExpressions leaves the
// rate literal instead of scaling it like a dose. Covers "/s", "/sec",
// "/min", "per second"/"per sec"/"per min", and — the form that was
// missing and let a real pour-rate instruction scale wrongly — "a|each
// |every second/minute".
const RATE_CONTEXT_REGEX =
  /^\s*(?:\/\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes|l|liter|litre|liters|litres)|per\s+(?:second|seconds|sec|secs|minute|minutes|min|mins|liter|litre|liters|litres)|(?:a|each|every)\s+(?:second|seconds|sec|secs|minute|minutes|min|mins))/i;

const NUMERIC_SCALABLE_AMOUNT_REGEX = new RegExp(
  `\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(${
    [...SCALABLE_UNITS]
      .sort((left, right) => right.length - left.length)
      .map((unit) => escapeRegExp(unit))
      .join("|")
  })(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);
const NUMERIC_SCALABLE_RANGE_REGEX = new RegExp(
  `\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(?:-|–|—|to)\\s*\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(${
    [...SCALABLE_UNITS]
      .sort((left, right) => right.length - left.length)
      .map((unit) => escapeRegExp(unit))
      .join("|")
  })(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);
const MULTIPLIER_LITERAL_AMOUNT_REGEX = new RegExp(
  `\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(?:x|×)\\s*([\\d]+(?:\\.\\d+)?)\\)?\\s*(${
    [...SCALABLE_UNITS]
      .sort((left, right) => right.length - left.length)
      .map((unit) => escapeRegExp(unit))
      .join("|")
  })(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);
// Defect 3 (Aug 2026 live pass): captures a trailing unit in BOTH possible
// positions around the optional outer closing paren — right after the
// INNER placeholder's own ")" (group 4) and, separately, right after the
// (optional) OUTER ")" (group 5). A malformed nested expression can carry
// a unit in both spots at once (e.g. a model-produced
// "(1 x (0.2 x <final_water_amount>)мл)мл"), and the match must consume
// BOTH so the replace callback below can collapse them into one instead
// of leaving the second occurrence sitting unconsumed right after the
// replacement — which is what previously let a doubled unit like "млмл"
// reach rendered preview text (see normalizeExpressionLikeMath).
const NESTED_PLACEHOLDER_EXPRESSION_REGEX =
  /\(?([\d.]+)\)?\s*(?:x|×)\s*\(([\d.]+)\s*(?:x|×)\s*<(final_coffee_amount|final_water_amount)>\)\s*([^\s<>()]*)(?:\)\s*([^\s<>()]*))?/gi;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeKeywordText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeBrewingMethodToken(value: string): string {
  return normalizeKeywordText(value).replace(/[^a-z0-9]+/g, "");
}

function capitalizeFirst(value: string): string {
  if (!value.length) {
    return value;
  }

  return value[0].toUpperCase() + value.slice(1);
}

function joinNaturalList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0];
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// F1(a): must never render a nonzero multiplier as "0" (or "-0") — that
// was the silent-data-loss bug where e.g. 4.5g of a 500g base
// (multiplier 0.009) vanished into "(0 x <final_water_amount>)g", which
// renders as 0g and passes validation because it's syntactically valid.
// Exported so tests can exercise its precision-capping behavior directly,
// independent of the scalable-amount gating logic that decides whether a
// literal amount reaches this formatter at all.
export function formatMultiplier(multiplier: number): string {
  const rounded = Math.round(multiplier);
  // Snap to the nearest integer only when that integer is itself nonzero.
  // This cleans up floating-point noise around whole multipliers (e.g.
  // 0.99998 -> "1") without ever collapsing a small-but-real multiplier
  // toward zero just because zero happens to be the nearest integer.
  if (rounded !== 0 && Math.abs(multiplier - rounded) < 0.01) {
    return String(rounded);
  }

  if (multiplier === 0) {
    return "0";
  }

  // Cap at 6 significant digits — enough precision for a scaling
  // multiplier stored in a recipe template, and far less noisy than raw
  // floating-point division (e.g. 25/300 -> 0.08333333333333333 would
  // otherwise round-trip through here uncapped). Widen beyond 6
  // significant digits only if that would round a genuinely nonzero
  // multiplier to "0" (or "-0") — the zero-collapse guard always wins
  // over the precision cap.
  for (
    let significantDigits = 6;
    significantDigits <= 17;
    significantDigits++
  ) {
    const formatted = multiplier.toPrecision(significantDigits).replace(
      /(\.\d*?)0+$/,
      "$1",
    ).replace(/\.$/, "");
    if (formatted !== "0" && formatted !== "-0") {
      return formatted;
    }
  }

  // Unreachable for any finite nonzero multiplier — toPrecision(17) is
  // full double precision, so the loop above always returns first.
  return String(multiplier);
}

function formatTemperatureNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

function convertFahrenheitToCelsius(value: number): number {
  return Number((((value - 32) * 5) / 9).toFixed(1));
}

function normalizeTemperatureToCelsius(
  value: number | null,
): { value: number | null; wasConverted: boolean } {
  if (value === null || !Number.isFinite(value)) {
    return {
      value: null,
      wasConverted: false,
    };
  }

  if (value > 120 && value <= 260) {
    return {
      value: Number((((value - 32) * 5) / 9).toFixed(1)),
      wasConverted: true,
    };
  }

  return {
    value: Number(value.toFixed(1)),
    wasConverted: false,
  };
}

const TEMPERATURE_MENTION_REGEX =
  /\b(\d+(?:\.\d+)?)\s*(?:[°º]\s*)?(?:degrees?\s*)?(c|f|celsius|fahrenheit|centigrade)\b/gi;

function normalizeTemperatureMentionsInText(
  value: string,
  resolvedTemperatureCelsius?: number,
): { text: string; wasNormalized: boolean } {
  let wasNormalized = false;

  const normalizedText = value.replace(
    TEMPERATURE_MENTION_REGEX,
    (fullMatch, numericValue, unitValue) => {
      const numeric = Number(numericValue);
      if (!Number.isFinite(numeric)) {
        return fullMatch;
      }

      const unit = String(unitValue).toLowerCase();
      const normalizedNumeric = resolvedTemperatureCelsius ??
        (unit.startsWith("f")
          ? convertFahrenheitToCelsius(numeric)
          : Number(numeric.toFixed(1)));
      const replacement = `${formatTemperatureNumber(normalizedNumeric)}${
        resolvedTemperatureCelsius !== undefined ? "°C" : "C"
      }`;

      if (replacement !== fullMatch) {
        wasNormalized = true;
      }

      return replacement;
    },
  );

  return {
    text: normalizedText,
    wasNormalized,
  };
}

// Phase E (plan 020 D5): resolves ExtractionResult.water_temp_stated_range
// into a Celsius value using a policy declared explicitly here, in code,
// because investigation found none declared anywhere before this phase —
// not in the extraction/normalization prompts, not in any check.
//
// Policy: MIDPOINT. Chosen by the user (this phase surfaced the gap and
// flagged the choice as one for a human to make, not a rediscovery of an
// existing rule; the reasoning below is theirs, recorded here so the code
// carries it). total_brew_time_seconds is the closest analogue already in
// this codebase, and it already uses midpoint (see its rule in
// buildExtractionSystemPrompt). Both total_brew_time_seconds and water
// temperature are a stated TARGET BAND where one representative value is
// required. That is different from coffee_amount_grams/water_amount, whose
// low-endpoint-when-unresolved rule exists because an amount SCALES and
// understating it is the conservative error — temperature has no such
// asymmetry between its two endpoints. Concretely: 93.3°C (the midpoint of
// 195-205°F) sits inside the conventional 92-96°C pour-over window, while
// 90.6°C (that range's low endpoint) falls below it.
function resolveWaterTempStatedRange(
  range:
    | { low: number; high: number; unit: "celsius" | "fahrenheit" }
    | null
    | undefined,
): { celsius: number; sourceLabel: string } | null {
  if (
    !range || !Number.isFinite(range.low) || !Number.isFinite(range.high)
  ) {
    return null;
  }

  const statedLow = Math.min(range.low, range.high);
  const statedHigh = Math.max(range.low, range.high);
  const unitLabel = range.unit === "fahrenheit" ? "F" : "C";
  const toCelsius = (value: number) =>
    range.unit === "fahrenheit"
      ? convertFahrenheitToCelsius(value)
      : Number(value.toFixed(1));

  // Average the two STATED endpoints first, then convert the single
  // resulting midpoint — do not convert each endpoint and average the
  // results. Fahrenheit->Celsius is an affine map (v => (v-32) * 5/9), so
  // it commutes with averaging: both orders are mathematically identical.
  // But averaging first means only ONE rounding step (inside
  // convertFahrenheitToCelsius's own .toFixed(1)) instead of two. This
  // matters because a Fahrenheit range with an odd-degree sum lands its
  // midpoint on a half-degree — e.g. 205-210°F's midpoint is 207.5°F, not
  // a whole number — and converting that single half-degree value once
  // still rounds cleanly to one decimal (207.5°F -> 97.5°C exactly);
  // converting 205°F and 210°F separately, rounding each to 1 decimal, and
  // THEN averaging risks a rounding artifact shifting the last digit away
  // from the true midpoint.
  const statedMidpoint = (statedLow + statedHigh) / 2;

  return {
    celsius: toCelsius(statedMidpoint),
    sourceLabel: `${formatTemperatureNumber(statedLow)}-${
      formatTemperatureNumber(statedHigh)
    }°${unitLabel}`,
  };
}

// Any warning describing HOW a stated temperature range was converted is
// the model's own free-text claim about a computation — the exact class of
// claim `019` found self-contradictory (plan 020 D5: e.g. a warning naming
// 96.1°C "the midpoint of 207.5°F", when 96.1°C cannot be that midpoint
// under any policy). It is safe to filter on English keywords here, unlike
// over source recipe text which may be any language: `warnings` is
// diagnostic parser commentary the prompt explicitly tells the model it
// may always write in English regardless of source language (see
// buildNormalizationSystemPrompt's "warnings is diagnostic parser
// commentary" rule), so this is bookkeeping over our own tool's
// English-only commentary channel, not a semantic judgement about
// multilingual recipe prose — the thing CLAUDE.md forbids regexing over.
// And the failure mode of a missed/over-eager match here is bounded and
// mild either way: at worst a stale-but-plausible warning stays (or a
// harmless one is dropped) — never a wrong VALUE, since this regex never
// touches water_temp itself, only which warnings accompany it.
const WATER_TEMP_RANGE_CONVERSION_WARNING_PATTERN =
  /\btemperature\b[^.]*\b(?:fahrenheit|°f|range)\b/i;

function stripWaterTempRangeConversionWarnings(
  warnings: string[],
): string[] {
  return warnings.filter((warning) =>
    !WATER_TEMP_RANGE_CONVERSION_WARNING_PATTERN.test(warning)
  );
}

function buildWaterTempRangeWarning(
  resolved: { celsius: number; sourceLabel: string },
): string {
  return `Water temperature was normalized from the stated ${resolved.sourceLabel} range to its midpoint, ${
    formatTemperatureNumber(resolved.celsius)
  }°C.`;
}

function normalizeExtractionTemperatures(
  extraction: ExtractionResult,
): ExtractionResult {
  const resolvedRange = resolveWaterTempStatedRange(
    extraction.water_temp_stated_range ?? null,
  );

  if (resolvedRange) {
    return {
      ...extraction,
      water_temp_celsius: resolvedRange.celsius,
    };
  }

  const normalizedTemperature = normalizeTemperatureToCelsius(
    extraction.water_temp_celsius,
  );

  return {
    ...extraction,
    water_temp_celsius: normalizedTemperature.value,
  };
}

function normalizeDraftTemperatures(
  normalized: NormalizedDraft,
  extraction: ExtractionResult,
): NormalizedDraft {
  const resolvedRange = resolveWaterTempStatedRange(
    extraction.water_temp_stated_range ?? null,
  );
  const strippedWarnings = stripWaterTempRangeConversionWarnings(
    normalized.warnings,
  );

  if (resolvedRange) {
    // Deterministic path: the value and its warning both come from the
    // SAME computation right here, so they cannot disagree (plan 020 D5).
    return {
      ...normalized,
      warnings: uniqueStrings([
        ...strippedWarnings,
        buildWaterTempRangeWarning(resolvedRange),
      ]),
      recipe: {
        ...normalized.recipe,
        water_temp: resolvedRange.celsius,
      },
      // E5 (plan 023): the deterministic range result is authoritative in
      // every user-visible representation. Phase E already made the scalar
      // and warning agree; also replace any inline temperature mention so a
      // model's incorrect arithmetic cannot survive in step prose.
      steps: normalized.steps.map((step) => ({
        ...step,
        description_template: normalizeTemperatureMentionsInText(
          step.description_template,
          resolvedRange.celsius,
        ).text,
      })),
    };
  }

  // Fallback path: no structured range to verify against — every capture
  // recorded before this phase, and any provider/response that predates
  // the field, land here. Per plan 020 D5, an unverifiable claim about how
  // a range was converted is stripped rather than trusted: an open
  // question beats a confidently wrong explanation
  // (HANDOFF-2026-08-12.md §7). The >120 heuristic below still catches a
  // single (non-range) Fahrenheit value the model forgot to convert at all.
  const normalizedTemperature = normalizeTemperatureToCelsius(
    normalized.recipe.water_temp,
  );

  return {
    ...normalized,
    warnings: normalizedTemperature.wasConverted
      ? uniqueStrings([
        ...strippedWarnings,
        "Water temperature was normalized to Celsius.",
      ])
      : strippedWarnings,
    recipe: {
      ...normalized.recipe,
      water_temp: normalizedTemperature.value,
    },
  };
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }

  return "Unknown error";
}

function cloneRegex(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags);
}

function formatCompactNumber(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

function isEnglishLikeLanguage(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "en" ||
    trimmed.startsWith("en-") ||
    trimmed.startsWith("en_")
  ) {
    return true;
  }

  const normalized = normalizeKeywordText(value).replace(/[^a-z]/g, "");
  return normalized === "english";
}

function getPrimaryLanguageSignal(
  values: Array<string | null | undefined>,
): string | null {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

// F28/F10-follow-up: the deterministic timing passes can only resolve a
// total-brew-time target from extraction.total_brew_time_seconds itself,
// or (English only — see parseTotalBrewTimeTargetSeconds) by mining it
// out of the narrowed source text. For a non-English recipe where
// extraction left the field null, neither path can help, and derived
// step durations silently fall back to the minimum instead of being
// split from a real target — exactly the bug that shipped an 80s German
// V60. Surface that condition explicitly instead of letting it pass
// silently.
function buildMissingNonEnglishTotalBrewTimeWarnings(input: {
  detectedInputLanguage: string | null;
  extractionTotalBrewTimeSeconds: number | null;
}): string[] {
  if (
    input.extractionTotalBrewTimeSeconds !== null ||
    isEnglishLikeLanguage(input.detectedInputLanguage)
  ) {
    return [];
  }

  return [
    "No total brew time was extracted for a non-English recipe; step durations fall back to minimums and should be reviewed.",
  ];
}

// F19 (originally investigated, reopened by the 2026-08-12 live pass):
// grind_size had no deterministic handling anywhere in the parser — only
// prompt instructions — so a model that grabbed the wrong clause of the
// source (an instruction, not a grind description) or mis-transcribed
// audio garbage sailed straight through unchecked. Two live shapes:
//   - "Grind ... for a total brew time of 2 to 2.5 minutes." — an
//     instruction sentence, not a grind size.
//   - "pure wood grind size" — ASR garbage (a mis-hearing of "pour-over")
//     that happens to read as a grammatically normal noun phrase.
// This SHAPE heuristic below only catches the first class: an
// instruction/aside reads as unusually long, contains a full sentence
// break, or names brew-time/instructional phrasing that a real grind
// descriptor never would. It cannot catch the second class — ASR garbage
// that is short and grammatically well-formed is indistinguishable from a
// real (if odd-sounding) grind descriptor by shape alone; only the source
// itself (via a provenance/quote check, which this pass does not add)
// could catch that, and is left as a known gap — see the defect-2 section
// of this change's report.
//
// ENGLISH-ONLY FALLBACK — do not internationalize this regex (same
// rationale as parseCompletionTargetSeconds/isDrawdownLikeStep above):
// that path never ends, and a false match against real non-English grind
// vocabulary would be worse than silence. For a non-English recipe this
// heuristic simply cannot run, which is exactly why grind_size_is_stated
// exists: it lets a stated-but-unverifiable non-English grind_size still
// surface an honest warning instead of being silently trusted.
const SUSPICIOUS_GRIND_SIZE_MAX_LENGTH = 60;
const SUSPICIOUS_GRIND_SIZE_REGEX =
  /\bgrind\s+(?:to|for)\b|\bto achieve\b|\bbrew\s*time\b|\btotal\s+brew\b/i;

function isSuspiciousGrindSizeText(grindSize: string): boolean {
  if (grindSize.length > SUSPICIOUS_GRIND_SIZE_MAX_LENGTH) {
    return true;
  }
  // A genuine grind descriptor is a short noun phrase ("Medium-fine",
  // "Coarse, like sea salt"), not a full sentence — a sentence-ending
  // punctuation mark is a strong signal that an instruction or aside was
  // captured instead of a grind description.
  if (/[.!?]/.test(grindSize)) {
    return true;
  }
  return SUSPICIOUS_GRIND_SIZE_REGEX.test(grindSize);
}

// Decision: WARN, never block. Unlike a coffee/water amount — which must
// be numerically exact for the recipe to function and is always
// verifiable against extracted_amounts — grind_size is legitimately
// INFERABLE from the brewing method when the source stays silent (the
// extraction prompt explicitly allows this), and the shape heuristic
// above is a blunt instrument that can false-positive on a genuinely
// long, comma-separated grind description ("Medium-coarse, like kosher
// salt, a touch finer for lighter roasts"). Blocking publication on a
// heuristic with known false positives would make otherwise-good recipes
// unpublishable; warning surfaces the same signal for operator review
// without doing that, matching this file's established asymmetric
// enforcement (amounts block, this — like G22's extract-mode timing warns
// — does not).
function buildGrindSizeWarnings(input: {
  grindSize: string | null;
  grindSizeIsStated: boolean;
  detectedInputLanguage: string | null;
}): string[] {
  if (input.grindSize === null) {
    return [];
  }

  if (!isEnglishLikeLanguage(input.detectedInputLanguage)) {
    // The shape heuristic is English-only and cannot run here (see above).
    // Only warn when the extraction stage itself claims this came from the
    // source — an inferred value is expected to already be one of the
    // prompt's short canonical phrases, so there is nothing new to verify
    // by warning about it too.
    return input.grindSizeIsStated
      ? [
        `Grind size "${input.grindSize}" was reported as stated by a non-English source, but this cannot be automatically verified (the shape check is English-only) — please review it before publishing.`,
      ]
      : [];
  }

  if (!isSuspiciousGrindSizeText(input.grindSize)) {
    return [];
  }

  return input.grindSizeIsStated
    ? [
      `Grind size "${input.grindSize}" was reported as stated by the source, but its shape (length, sentence punctuation, or brew-time/instructional wording) suggests an unrelated instruction was captured instead of a grind description — please review before publishing.`,
    ]
    : [
      `Grind size "${input.grindSize}" was inferred rather than stated by the source, but its shape looks wrong for a grind description — please review before publishing.`,
    ];
}

function filterDiagnosticNotes(notes: string[]): string[] {
  return uniqueStrings(notes.filter((note) => {
    const normalized = normalizeKeywordText(note);
    return DIAGNOSTIC_NOTE_KEYWORDS.some((keyword) =>
      normalized.includes(keyword)
    );
  }));
}

function containsPreparationDetail(text: string | null): boolean {
  if (!text) {
    return false;
  }

  const normalized = normalizeKeywordText(text);
  return PREPARATION_DETAIL_KEYWORDS.some((keyword) =>
    normalized.includes(keyword)
  );
}

function getBrewingMethodLabel(args: {
  brewingMethods: BrewingMethodOption[];
  brewingMethodId: string | null;
}): string | null {
  if (!args.brewingMethodId) {
    return null;
  }

  return args.brewingMethods.find((method) =>
    method.brewing_method_id === args.brewingMethodId
  )?.brewing_method ?? null;
}

function extractShortDescriptionContextItems(
  texts: Array<string | null>,
): string[] {
  const combinedText = texts.filter(Boolean).join(" ");

  return uniqueStrings(
    SHORT_DESCRIPTION_CONTEXT_PATTERNS
      .filter((pattern) => pattern.regex.test(combinedText))
      .map((pattern) => pattern.label),
  ).slice(0, 3);
}

function synthesizeShortDescription(args: {
  normalized: NormalizedDraft;
  brewingMethods: BrewingMethodOption[];
}): string | null {
  const methodLabel = getBrewingMethodLabel({
    brewingMethods: args.brewingMethods,
    brewingMethodId: args.normalized.recipe.brewing_method_id,
  });
  const coffeeAmount = formatCompactNumber(
    args.normalized.recipe.coffee_amount,
  );
  const waterAmount = formatCompactNumber(args.normalized.recipe.water_amount);
  const grindSize = args.normalized.localization.grind_size?.trim() ?? null;
  const contextItems = extractShortDescriptionContextItems([
    args.normalized.localization.short_description,
    args.normalized.steps[0]?.description_source ?? null,
  ]);

  const grindPrefix = grindSize && grindSize.split(/\s+/).length <= 2
    ? `${capitalizeFirst(grindSize.toLowerCase())} `
    : "";
  const subject = methodLabel ? `${methodLabel} recipe` : "coffee recipe";
  const quantityPart = coffeeAmount && waterAmount
    ? ` using ${coffeeAmount}g coffee and ${waterAmount}g water`
    : waterAmount
    ? ` for ${waterAmount}g water`
    : coffeeAmount
    ? ` using ${coffeeAmount}g coffee`
    : "";
  const contextSuffix = contextItems.length > 0
    ? ` with ${joinNaturalList(contextItems)}`
    : "";

  const summary = `${grindPrefix}${subject}${quantityPart}${contextSuffix}.`
    .replace(/\s+/g, " ")
    .trim();

  return summary.length > 0 ? summary : null;
}

function rebalanceShortDescription(args: {
  normalized: NormalizedDraft;
  brewingMethods: BrewingMethodOption[];
}): string | null {
  const current = args.normalized.localization.short_description?.trim() ??
    null;
  const currentContextItems = extractShortDescriptionContextItems([current]);
  const preparationContextItems = extractShortDescriptionContextItems([
    args.normalized.steps[0]?.description_source ?? null,
  ]);
  if (!current) {
    return synthesizeShortDescription(args);
  }

  const preparationText = args.normalized.steps[0]?.description_source ?? null;
  const shouldRebalance = current.length > 160 ||
    (containsPreparationDetail(current) &&
      containsPreparationDetail(preparationText)) ||
    preparationContextItems.some((item) => !currentContextItems.includes(item));

  if (!shouldRebalance) {
    return current;
  }

  return synthesizeShortDescription(args) ?? current;
}

function parseJsonPayload(content: string): unknown {
  const trimmed = content.trim();
  const withoutFences = trimmed.startsWith("```")
    ? trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()
    : trimmed;

  return JSON.parse(withoutFences);
}

function calculateCleanScore(number: number): number {
  // F1(c): a ratio this small means the candidate amount is a negligible
  // fraction of this base — almost certainly the WRONG base, not a
  // "clean" one. Score it worse than every other branch below so
  // getCleanestPlaceholder never prefers the base that makes an amount
  // vanish (the "degenerate branch" that used to feed formatMultiplier's
  // zero-collapse bug).
  if (Math.abs(number) < 0.02) {
    return -1000;
  }

  if (Math.abs(number - Math.round(number)) < 0.01) {
    return 100 - Math.abs(number - Math.round(number)) * 100;
  }

  const simpleRatios = [
    0.25,
    0.33,
    0.5,
    0.67,
    0.75,
    1.25,
    1.33,
    1.5,
    1.67,
    1.75,
    2.5,
    3.5,
  ];

  for (const ratio of simpleRatios) {
    if (Math.abs(ratio - number) < 0.01) {
      return 90 - Math.abs(ratio - number) * 100;
    }
  }

  const [, decimalPart = ""] = number.toString().split(".");
  return 80 - decimalPart.length * 10;
}

function getCleanestPlaceholder(args: {
  value: number;
  coffeeAmount: number | null;
  waterAmount: number | null;
}): DraftExpression["placeholder"] | null {
  const coffeeAmount = args.coffeeAmount;
  const waterAmount = args.waterAmount;

  if (coffeeAmount === null && waterAmount === null) {
    return null;
  }

  if (coffeeAmount === null) {
    return "<final_water_amount>";
  }

  if (waterAmount === null) {
    return "<final_coffee_amount>";
  }

  const coffeeScore = calculateCleanScore(args.value / coffeeAmount);
  const waterScore = calculateCleanScore(args.value / waterAmount);

  return coffeeScore > waterScore
    ? "<final_coffee_amount>"
    : "<final_water_amount>";
}

function nearestKeywordDistance(args: {
  description: string;
  matchStart: number;
  matchEnd: number;
  keywords: readonly string[];
}): number | null {
  const contextStart = Math.max(0, args.matchStart - 32);
  const contextEnd = Math.min(args.description.length, args.matchEnd + 32);
  // Search before and after the amount separately so keyword distances stay
  // valid even though normalization can shift character offsets.
  const before = normalizeKeywordText(
    args.description.slice(contextStart, args.matchStart),
  );
  const after = normalizeKeywordText(
    args.description.slice(args.matchEnd, contextEnd),
  );

  let best: number | null = null;
  for (const keyword of args.keywords) {
    let index = before.indexOf(keyword);
    while (index >= 0) {
      const distance = before.length - (index + keyword.length);
      if (best === null || distance < best) {
        best = distance;
      }
      index = before.indexOf(keyword, index + 1);
    }
    index = after.indexOf(keyword);
    while (index >= 0) {
      if (best === null || index < best) {
        best = index;
      }
      index = after.indexOf(keyword, index + 1);
    }
  }
  return best;
}

// Defect 1 (Aug 2026 live pass): how close a candidate value must be to
// coffeeAmount/waterAmount to count as "exactly equal to the recipe's own
// amount" rather than a coincidentally-close different quantity. Matches
// the tolerance already used elsewhere in this file for the same kind of
// float-noise comparison (see e.g. the scalable_amounts allowlist match).
const EXACT_AMOUNT_MATCH_TOLERANCE = 0.01;

function resolveAmountPlaceholder(args: {
  description: string;
  stepKind: "preparation" | "brew";
  matchStart: number;
  matchEnd: number;
  value: number;
  coffeeAmount: number | null;
  waterAmount: number | null;
  // See extractedStepSchema.step_role. Used only as a secondary,
  // structural (language-agnostic) tiebreaker below — never required.
  stepRole?:
    | "preparation"
    | "bloom"
    | "pour"
    | "stir"
    | "drawdown"
    | "serve"
    | null;
}): DraftExpression["placeholder"] | null {
  // Defect 1 (Aug 2026 live pass): highest-priority, language-agnostic
  // signal, checked BEFORE any keyword matching. A live German step "15 g
  // Kaffee zugeben und umruehren." (coffee_amount 15, water_amount 250)
  // used to resolve to (0.06 x <final_water_amount>)g because
  // COFFEE_CONTEXT_KEYWORDS/WATER_CONTEXT_KEYWORDS below are English-only
  // and matched neither "Kaffee" nor "zugeben" — the amount fell through
  // to a brew-step default that always prefers water. A value that
  // exactly equals this recipe's own coffee_amount (and not also its
  // water_amount) is overwhelmingly likely to BE the coffee amount,
  // regardless of what language or keywords surround it, so check that
  // structural fact first. Symmetric for water_amount.
  const matchesCoffeeExactly = args.coffeeAmount !== null &&
    Math.abs(args.value - args.coffeeAmount) < EXACT_AMOUNT_MATCH_TOLERANCE;
  const matchesWaterExactly = args.waterAmount !== null &&
    Math.abs(args.value - args.waterAmount) < EXACT_AMOUNT_MATCH_TOLERANCE;

  if (matchesCoffeeExactly && !matchesWaterExactly) {
    return "<final_coffee_amount>";
  }

  if (matchesWaterExactly && !matchesCoffeeExactly) {
    return "<final_water_amount>";
  }

  // English-only fallback keyword matching (see COFFEE_CONTEXT_KEYWORDS'
  // own comment) — used only when the structural check above could not
  // decide (value doesn't exactly match either base amount, or matches
  // both).
  const coffeeDistance = nearestKeywordDistance({
    description: args.description,
    matchStart: args.matchStart,
    matchEnd: args.matchEnd,
    keywords: COFFEE_CONTEXT_KEYWORDS,
  });
  const waterDistance = nearestKeywordDistance({
    description: args.description,
    matchStart: args.matchStart,
    matchEnd: args.matchEnd,
    keywords: WATER_CONTEXT_KEYWORDS,
  });

  if (coffeeDistance !== null && waterDistance === null) {
    return "<final_coffee_amount>";
  }

  if (waterDistance !== null && coffeeDistance === null) {
    return "<final_water_amount>";
  }

  if (coffeeDistance !== null && waterDistance !== null) {
    if (coffeeDistance < waterDistance) {
      return "<final_coffee_amount>";
    }
    if (waterDistance < coffeeDistance) {
      return "<final_water_amount>";
    }
    // Coffee and water wording are exactly equidistant — leave the amount
    // unconverted rather than guessing.
    return null;
  }

  if (args.stepKind === "brew" && args.waterAmount !== null) {
    // Defect 1 follow-up: step_role is a structural, language-agnostic
    // signal (see extractedStepSchema.step_role) — "preparation" and
    // "stir" steps describe dosing/setup actions, not water additions, so
    // an unresolved amount there should not be forced onto the water
    // base. Fall through to the ratio-based getCleanestPlaceholder
    // instead. "bloom"/"pour"/"drawdown"/"serve"/null keep the original
    // water default, since those roles (or the absence of a role, for
    // drafts predating step_role) are genuinely water-shaped brew
    // actions.
    if (
      (args.stepRole === "preparation" || args.stepRole === "stir") &&
      args.coffeeAmount !== null
    ) {
      return getCleanestPlaceholder({
        value: args.value,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
      });
    }

    return "<final_water_amount>";
  }

  return getCleanestPlaceholder({
    value: args.value,
    coffeeAmount: args.coffeeAmount,
    waterAmount: args.waterAmount,
  });
}

// F1(b): amounts under 2% of their base are not meaningfully scalable — a
// 1g addition in a 300g recipe should stay a literal number, not become a
// fraction so small that formatMultiplier used to have to collapse it to
// "0". Shared by both the range and single-amount passes below.
const MIN_SCALABLE_AMOUNT_RATIO = 0.02;

function matchesStructuredRateAmount(
  rateAmounts: Array<{ value: number; unit: string }>,
  value: number,
  unit: string,
): boolean {
  const normalizedUnit = normalizeExpressionUnit(unit).trim().toLowerCase();
  return rateAmounts.some((rate) =>
    normalizeExpressionUnit(rate.unit).trim().toLowerCase() ===
      normalizedUnit && Math.abs(rate.value - value) < 0.01
  );
}

// E4: if a provider has already turned a stated rate into a scalable
// expression, restore its literal numerator. This is driven exclusively by
// the structured multilingual rate signal, never by interpreting prose here.
function restoreRateExpressionsToLiterals(args: {
  description: string;
  coffeeAmount: number | null;
  waterAmount: number | null;
  rateAmounts: Array<{ value: number; unit: string }>;
}): string {
  if (args.rateAmounts.length === 0) {
    return args.description;
  }

  return args.description.replace(
    cloneRegex(EXPRESSION_REGEX),
    (fullMatch, multiplierValue, placeholderValue, unitValue) => {
      const multiplier = Number(multiplierValue);
      const baseAmount = String(placeholderValue).toLowerCase() ===
          "final_coffee_amount"
        ? args.coffeeAmount
        : args.waterAmount;
      if (!Number.isFinite(multiplier) || baseAmount === null) {
        return fullMatch;
      }

      const renderedValue = Number((multiplier * baseAmount).toFixed(2));
      const unit = normalizeExpressionUnit(String(unitValue ?? ""));
      const rate = args.rateAmounts.find((candidate) =>
        matchesStructuredRateAmount([candidate], renderedValue, unit)
      );
      if (!rate) {
        return fullMatch;
      }

      return `${formatCompactNumber(rate.value)}${
        unit || normalizeExpressionUnit(rate.unit)
      }`;
    },
  );
}

function convertNumericValuesToExpressions(args: {
  description: string;
  stepKind: "preparation" | "brew";
  coffeeAmount: number | null;
  waterAmount: number | null;
  // F5: amounts this step's extraction/normalization stage identified as
  // genuine recipe quantities. When non-empty, ONLY amounts appearing in
  // this list (matched on value and normalized unit) are eligible for
  // conversion — equipment capacities, product specs, and asides never
  // make the list and stay literal even if they'd otherwise parse as a
  // scalable amount near a coffee/water keyword.
  scalableAmounts: Array<{ value: number; unit: string }>;
  // E4: numerator values that are rates, not recipe quantities. A matching
  // number must remain literal even when scalable_amounts is empty and the
  // legacy regex-only conversion fallback is active.
  rateAmounts: Array<{ value: number; unit: string }>;
  // See extractedStepSchema.step_role. Passed through to
  // resolveAmountPlaceholder as a secondary, language-agnostic tiebreaker
  // (defect 1 follow-up) — optional so callers that predate step_role
  // keep compiling and behaving exactly as before.
  stepRole?:
    | "preparation"
    | "bloom"
    | "pour"
    | "stir"
    | "drawdown"
    | "serve"
    | null;
}): string {
  if (!args.description.trim().length) {
    return args.description;
  }

  // Backward compatibility (F5): an empty list means either this step
  // truly has no scalable amounts, or — just as likely in the field — the
  // model run that produced this draft predates/ignores the
  // scalable_amounts field. There is no way to tell those apart from here,
  // and refusing to convert in the second case would silently regress
  // every recipe back to non-scaling instructions. So an empty list falls
  // back to the pre-F5 regex-only heuristic (every match is eligible)
  // rather than allowing nothing through.
  const hasScalableAmountAllowlist = args.scalableAmounts.length > 0;
  const isListedScalableAmount = (value: number, unit: string): boolean => {
    if (!hasScalableAmountAllowlist) {
      return true;
    }

    const normalizedUnit = normalizeExpressionUnit(unit).trim().toLowerCase();
    return args.scalableAmounts.some((amount) =>
      normalizeExpressionUnit(amount.unit).trim().toLowerCase() ===
        normalizedUnit &&
      Math.abs(amount.value - value) < 0.01
    );
  };

  const withRanges = args.description.replace(
    NUMERIC_SCALABLE_RANGE_REGEX,
    (
      fullMatch,
      lowerNumericValue,
      upperNumericValue,
      unit,
      offset,
      fullDescription,
    ) => {
      const lowerValue = Number(lowerNumericValue);
      const upperValue = Number(upperNumericValue);
      if (
        !Number.isFinite(lowerValue) ||
        !Number.isFinite(upperValue) ||
        lowerValue < 0.1 ||
        upperValue < 0.1
      ) {
        return fullMatch;
      }

      if (
        !isListedScalableAmount(lowerValue, String(unit)) ||
        !isListedScalableAmount(upperValue, String(unit))
      ) {
        return fullMatch;
      }

      if (
        isInsideExpressionLikeMultiplier({
          description: String(fullDescription),
          matchStart: Number(offset),
        })
      ) {
        return fullMatch;
      }

      const tail = String(fullDescription).slice(
        Number(offset) + fullMatch.length,
        Number(offset) + fullMatch.length + 24,
      );
      if (RATE_CONTEXT_REGEX.test(tail)) {
        return fullMatch;
      }

      const lowerPlaceholder = resolveAmountPlaceholder({
        description: String(fullDescription),
        stepKind: args.stepKind,
        matchStart: Number(offset),
        matchEnd: Number(offset) + String(lowerNumericValue).length,
        value: lowerValue,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
        stepRole: args.stepRole,
      });
      const upperPlaceholder = resolveAmountPlaceholder({
        description: String(fullDescription),
        stepKind: args.stepKind,
        matchStart: Number(offset),
        matchEnd: Number(offset) + fullMatch.length,
        value: upperValue,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
        stepRole: args.stepRole,
      });

      if (!lowerPlaceholder || lowerPlaceholder !== upperPlaceholder) {
        return fullMatch;
      }

      const baseAmount = lowerPlaceholder === "<final_coffee_amount>"
        ? args.coffeeAmount
        : args.waterAmount;

      if (baseAmount === null || baseAmount <= 0) {
        return fullMatch;
      }

      if (
        lowerValue / baseAmount < MIN_SCALABLE_AMOUNT_RATIO ||
        upperValue / baseAmount < MIN_SCALABLE_AMOUNT_RATIO
      ) {
        return fullMatch;
      }

      const normalizedUnit = normalizeExpressionUnit(String(unit));
      return `(${
        formatMultiplier(lowerValue / baseAmount)
      } x ${lowerPlaceholder})-(${
        formatMultiplier(upperValue / baseAmount)
      } x ${upperPlaceholder})${normalizedUnit}`;
    },
  );

  return withRanges.replace(
    NUMERIC_SCALABLE_AMOUNT_REGEX,
    (fullMatch, numericValue, unit, offset, fullDescription) => {
      const value = Number(numericValue);
      if (!Number.isFinite(value) || value < 0.1) {
        return fullMatch;
      }

      if (matchesStructuredRateAmount(args.rateAmounts, value, String(unit))) {
        return fullMatch;
      }

      if (!isListedScalableAmount(value, String(unit))) {
        return fullMatch;
      }

      if (
        isInsideExpressionLikeMultiplier({
          description: String(fullDescription),
          matchStart: Number(offset),
        })
      ) {
        return fullMatch;
      }

      const tail = String(fullDescription).slice(
        Number(offset) + fullMatch.length,
        Number(offset) + fullMatch.length + 24,
      );
      if (RATE_CONTEXT_REGEX.test(tail)) {
        return fullMatch;
      }

      const placeholder = resolveAmountPlaceholder({
        description: String(fullDescription),
        stepKind: args.stepKind,
        matchStart: Number(offset),
        matchEnd: Number(offset) + fullMatch.length,
        value,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
        stepRole: args.stepRole,
      });

      if (!placeholder) {
        return fullMatch;
      }

      const baseAmount = placeholder === "<final_coffee_amount>"
        ? args.coffeeAmount
        : args.waterAmount;

      if (baseAmount === null || baseAmount <= 0) {
        return fullMatch;
      }

      if (value / baseAmount < MIN_SCALABLE_AMOUNT_RATIO) {
        return fullMatch;
      }

      return `(${formatMultiplier(value / baseAmount)} x ${placeholder})${
        normalizeExpressionUnit(String(unit))
      }`;
    },
  );
}

function isInsideExpressionLikeMultiplier(args: {
  description: string;
  matchStart: number;
}): boolean {
  const prefix = args.description.slice(0, args.matchStart);
  const lastOpenParen = prefix.lastIndexOf("(");
  const lastCloseParen = prefix.lastIndexOf(")");
  if (lastOpenParen <= lastCloseParen) {
    return false;
  }

  const currentParenthetical = prefix.slice(lastOpenParen + 1);
  return /(?:^|\s)[\d.]+\s*(?:x|×)\s*$/i.test(currentParenthetical);
}

function normalizeExpressionLikeMath(args: {
  description: string;
  coffeeAmount: number | null;
  waterAmount: number | null;
}): string {
  if (!args.description.trim().length) {
    return args.description;
  }

  const collapsedNestedExpressions = args.description.replace(
    NESTED_PLACEHOLDER_EXPRESSION_REGEX,
    (
      _fullMatch,
      outerMultiplierValue,
      innerMultiplierValue,
      placeholderValue,
      innerUnitValue,
      outerUnitValue,
    ) => {
      const outerMultiplier = Number(outerMultiplierValue);
      const innerMultiplier = Number(innerMultiplierValue);
      if (
        !Number.isFinite(outerMultiplier) || !Number.isFinite(innerMultiplier)
      ) {
        return _fullMatch;
      }

      // Defect 3: prefer the unit captured after the OUTER closing paren
      // (the syntactically-intended position) and fall back to the one
      // after the inner paren only when the outer position was empty.
      // When a malformed input carries the SAME unit in both positions
      // (see NESTED_PLACEHOLDER_EXPRESSION_REGEX's comment), both were
      // consumed by the match above, so using only one here — instead of
      // concatenating both — is what stops the duplicate from reaching
      // the rendered output.
      const unitValue = String(outerUnitValue ?? "") ||
        String(innerUnitValue ?? "");

      return `(${formatMultiplier(outerMultiplier * innerMultiplier)} x <${
        String(placeholderValue).toLowerCase()
      }>)${normalizeExpressionUnit(unitValue)}`;
    },
  );

  return collapsedNestedExpressions.replace(
    MULTIPLIER_LITERAL_AMOUNT_REGEX,
    (
      fullMatch,
      multiplierValue,
      literalAmountValue,
      unitValue,
    ) => {
      const multiplier = Number(multiplierValue);
      const literalAmount = Number(literalAmountValue);
      if (!Number.isFinite(multiplier) || !Number.isFinite(literalAmount)) {
        return fullMatch;
      }

      if (
        args.waterAmount !== null &&
        Math.abs(literalAmount - args.waterAmount) < 0.01
      ) {
        return `(${formatMultiplier(multiplier)} x <final_water_amount>)${
          normalizeExpressionUnit(String(unitValue))
        }`;
      }

      if (
        args.coffeeAmount !== null &&
        Math.abs(literalAmount - args.coffeeAmount) < 0.01
      ) {
        return `(${formatMultiplier(multiplier)} x <final_coffee_amount>)${
          normalizeExpressionUnit(String(unitValue))
        }`;
      }

      return `${formatCompactNumber(multiplier * literalAmount) ?? fullMatch}${
        normalizeExpressionUnit(String(unitValue))
      }`;
    },
  );
}

function createOpenAiCompatibleProvider(args: {
  name: "groq" | "cerebras" | "openai";
  apiKey: string;
  model: string;
  endpoint: string;
  fetchImpl: typeof fetch;
}): RecipeDraftAiProvider {
  return {
    name: args.name,
    model: args.model,
    async invokeJson<T>(
      input: ProviderInvocation<T>,
    ): Promise<{ result: T; tokensUsed: number }> {
      // Stage-capture (opt-in via capture_stages): rawText/finishReason are
      // filled in as soon as they're known, then onAttempt fires exactly
      // once — in the catch block on any failure, or right before
      // returning on success — so it always sees whatever text was
      // available for THIS attempt, whether or not parsing succeeded.
      let rawText = "";
      let finishReason: string | null = null;

      try {
        const response = await args.fetchImpl(args.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: args.model,
            messages: [
              {
                role: "system",
                content: input.systemPrompt,
              },
              {
                role: "user",
                content: input.userPrompt,
              },
            ],
            response_format: {
              type: "json_object",
            },
            temperature: 0.1,
            max_completion_tokens: input.maxCompletionTokens,
            stream: false,
            ...(args.name === "openai"
              ? { reasoning_effort: "none" as const }
              : {}),
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          rawText = errorBody;
          throw new Error(
            `${args.name}:${args.model} HTTP ${response.status} ${
              errorBody.slice(0, 300)
            }`,
          );
        }

        const data = await response.json();
        finishReason = data.choices?.[0]?.finish_reason ?? null;
        const content = data.choices?.[0]?.message?.content;
        rawText = typeof content === "string" ? content : "";

        // F10: detect an output-token-truncated response explicitly, before
        // it has any chance to fail JSON.parse with an opaque error. A
        // truncated response is a distinct, typed failure — not a generic
        // "malformed JSON" one — so retry/fallback logic upstream can
        // reason about it.
        if (finishReason === "length") {
          throw new ProviderTruncationError({
            providerName: args.name,
            model: args.model,
            stage: input.stage,
          });
        }

        if (typeof content !== "string" || content.trim().length === 0) {
          throw new Error(`${args.name}:${args.model} returned empty content`);
        }

        const parsedJson = parseJsonPayload(content);
        const result = input.schema.parse(parsedJson);
        input.onAttempt?.({
          rawText,
          finishReason,
          parsed: result,
          error: null,
        });
        return {
          result,
          tokensUsed: data.usage?.total_tokens ?? 0,
        };
      } catch (error) {
        input.onAttempt?.({
          rawText,
          finishReason,
          parsed: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

function createVertexAccessTokenProvider(args: {
  serviceAccountKeyJson: string;
  fetchImpl: typeof fetch;
}) {
  let cachedAccessToken: string | null = null;
  let cachedTokenExpiresAtMs = 0;

  return async function getAccessToken(): Promise<string> {
    const nowMs = Date.now();
    if (
      cachedAccessToken &&
      cachedTokenExpiresAtMs > nowMs + 60_000
    ) {
      return cachedAccessToken;
    }

    const serviceAccount = JSON.parse(args.serviceAccountKeyJson);
    const issuedAt = Math.floor(nowMs / 1000);
    const expiresAt = issuedAt + 3600;
    const encodeBase64Url = (value: string) =>
      btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const header = encodeBase64Url(JSON.stringify({
      alg: "RS256",
      typ: "JWT",
    }));
    const payload = encodeBase64Url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: expiresAt,
    }));
    const unsignedToken = `${header}.${payload}`;

    const privateKeyBinary = Uint8Array.from(
      atob(
        String(serviceAccount.private_key)
          .replace(/-----\w+ PRIVATE KEY-----/g, "")
          .replace(/\s+/g, ""),
      ),
      (char) => char.charCodeAt(0),
    );

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBinary,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(unsignedToken),
    );
    const signedToken = `${unsignedToken}.${
      encodeBase64Url(String.fromCharCode(...new Uint8Array(signature)))
    }`;

    const response = await args.fetchImpl(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signedToken,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `gemini:oauth HTTP ${response.status} ${errorBody.slice(0, 300)}`,
      );
    }

    const tokenResponse = await response.json();
    if (
      typeof tokenResponse.access_token !== "string" ||
      tokenResponse.access_token.length === 0
    ) {
      throw new Error("gemini:oauth returned an empty access token");
    }

    const accessToken = tokenResponse.access_token;
    cachedAccessToken = accessToken;
    cachedTokenExpiresAtMs = nowMs +
      Number(tokenResponse.expires_in ?? 3600) * 1000;
    return accessToken;
  };
}

function createGeminiProvider(args: {
  serviceAccountKeyJson: string;
  projectId: string;
  region: string;
  model: string;
  fetchImpl: typeof fetch;
}): RecipeDraftAiProvider {
  const getAccessToken = createVertexAccessTokenProvider({
    serviceAccountKeyJson: args.serviceAccountKeyJson,
    fetchImpl: args.fetchImpl,
  });
  const isPreviewModel = args.model.includes("preview");
  const location = isPreviewModel ? "global" : args.region;
  const host = isPreviewModel
    ? "aiplatform.googleapis.com"
    : `${args.region}-aiplatform.googleapis.com`;
  const endpoint =
    `https://${host}/v1/projects/${args.projectId}/locations/${location}/publishers/google/models/${args.model}:generateContent`;

  return {
    name: "gemini",
    model: args.model,
    async invokeJson<T>(
      input: ProviderInvocation<T>,
    ): Promise<{ result: T; tokensUsed: number }> {
      // Stage-capture (opt-in via capture_stages): see the mirrored comment
      // in createOpenAiCompatibleProvider's invokeJson above.
      let rawText = "";
      let finishReason: string | null = null;

      try {
        const accessToken = await getAccessToken();
        const response = await args.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: input.systemPrompt,
                },
              ],
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: input.userPrompt,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
              maxOutputTokens: input.maxCompletionTokens,
            },
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          rawText = errorBody;
          throw new Error(
            `gemini:${args.model} HTTP ${response.status} ${
              errorBody.slice(0, 300)
            }`,
          );
        }

        const data = await response.json();

        // F10: Gemini's truncation signal, mirroring the OpenAI-compatible
        // finish_reason === "length" check above.
        finishReason = data.candidates?.[0]?.finishReason ?? null;
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
        rawText = typeof content === "string" ? content : "";

        if (finishReason === "MAX_TOKENS") {
          throw new ProviderTruncationError({
            providerName: "gemini",
            model: args.model,
            stage: input.stage,
          });
        }

        if (typeof content !== "string" || content.trim().length === 0) {
          throw new Error(`gemini:${args.model} returned empty content`);
        }

        const parsedJson = parseJsonPayload(content);
        const result = input.schema.parse(parsedJson);
        input.onAttempt?.({
          rawText,
          finishReason,
          parsed: result,
          error: null,
        });
        return {
          result,
          tokensUsed: data.usageMetadata?.totalTokenCount ?? 0,
        };
      } catch (error) {
        input.onAttempt?.({
          rawText,
          finishReason,
          parsed: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

function buildProviders(
  config: RecipeDraftParserConfig,
): RecipeDraftAiProvider[] {
  if (config.providers && config.providers.length > 0) {
    return config.providers;
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const providers: RecipeDraftAiProvider[] = [];

  // Phase E: measured against twelve live production parses, openai's
  // MEDIUM tier served 11/12 end-to-end at 7,400-9,147 tokens; the one that
  // fell through to Groq cost ~2.5x the tokens (21,834) and produced the
  // worst output of the batch. Groq's org-wide 8,000 TPM ceiling cannot
  // structurally absorb a single parse (3-5 sequential calls), and
  // Cerebras's free tier (5 RPM) hits its request ceiling on one button
  // press. So the default cascade is now: MEDIUM, then BIG as the single
  // escalation for inputs MEDIUM fails, then Gemini kept only as a
  // provider-outage fallback. Combined with the same-provider retry (F10 /
  // Phase C2), this yields two attempts on MEDIUM, then two on BIG, then
  // Gemini — strictly better coverage than the old cascade while never
  // silently swapping in a weaker model. Groq/Cerebras remain available via
  // explicit config.providers injection; see plans/README.md for why this
  // is not a "normalize back onto Groq" candidate.
  if (config.openAiApiKey) {
    providers.push(
      createOpenAiCompatibleProvider({
        name: "openai",
        apiKey: config.openAiApiKey,
        model: OPENAI_MODELS.MEDIUM,
        endpoint: OPENAI_CHAT_COMPLETIONS_URL,
        fetchImpl,
      }),
    );
    providers.push(
      createOpenAiCompatibleProvider({
        name: "openai",
        apiKey: config.openAiApiKey,
        model: OPENAI_MODELS.BIG,
        endpoint: OPENAI_CHAT_COMPLETIONS_URL,
        fetchImpl,
      }),
    );
  }

  if (
    config.geminiServiceAccountKeyJson &&
    config.geminiProjectId &&
    config.geminiRegion
  ) {
    providers.push(
      createGeminiProvider({
        serviceAccountKeyJson: config.geminiServiceAccountKeyJson,
        projectId: config.geminiProjectId,
        region: config.geminiRegion,
        model: config.geminiModel ?? DEFAULT_GEMINI_MODEL,
        fetchImpl,
      }),
    );
  }

  return providers;
}

function buildBrewingMethodsPrompt(methods: BrewingMethodOption[]): string {
  return methods
    .map((method) => `- ${method.brewing_method_id}: ${method.brewing_method}`)
    .join("\n");
}

// G22: shared between the extraction, normalization and repair system
// prompts (each stage can add or correct extracted_amounts records). Kept
// as one block so the three stages never drift into inconsistent
// definitions of what each provenance class means.
const AMOUNT_PROVENANCE_PROMPT_RULES: string[] = [
  "Every numeric coffee or water amount — recipe-level coffee_amount_grams/water_amount and every step's own amounts alike, including range endpoints and cumulative pour targets — must also get a matching record in extracted_amounts: { value, unit, step_index, provenance, source_quote, rule, rule_source_quote, rule_inputs, unit_kind, stated_range }.",
  "unit_kind classifies what DIMENSION unit is, independent of what word or script you wrote it in: 'mass' (e.g. g, grams, جرام, گرم), 'volume' (e.g. ml, milliliters, میلی‌لیتر), 'time', or 'percent'. Set it for every record — this is what lets a non-English unit be verified even when the rendered recipe later shows the amount in plain ASCII 'g' or 'ml'. Use null only if the unit genuinely does not fit any of the four.",
  "stated_range records the two endpoints whenever the source text states this amount as a range (e.g. '60-90 g', '20-24g'), as { low, high }, regardless of which single value you ultimately choose for the record's own value/rule. Set it even when provenance/rule is 'literal' or when rule is something other than range_endpoint — the point is to preserve BOTH endpoints somewhere even if the rest of the pipeline later collapses the amount to one of them. Use null when the source states a single value, not a range.",
  "step_index is the 0-based index into steps that the amount belongs to, or -1 for a recipe-level amount not tied to one specific step.",
  "provenance is exactly one of three values: 'literal', 'derived', or 'inferred'.",
  '\'literal\' means the value appears verbatim in the source text. source_quote must be the exact substring of the source text stating it — copy it character for character, do not paraphrase or reformat it. rule, rule_source_quote, and rule_inputs must be null. Worked example (English): the text \'Pour 50 g of water for the bloom.\' gives { value: 50, unit: "g", provenance: "literal", source_quote: "50 g", rule: null, rule_source_quote: null, rule_inputs: null }. Worked example (German, non-English): the text \'25g Kaffee aufgießen und quellen lassen.\' gives { value: 25, unit: "g", provenance: "literal", source_quote: "25g", rule: null, rule_source_quote: null, rule_inputs: null } — never translate source_quote into English.',
  "'derived' means the value is computed from other source facts by a rule the text states, not quoted directly as a number. rule must be exactly one of: multiple_of_coffee (N x coffee_amount), multiple_of_water (N x water_amount), ratio_of_total (percent of water_amount), concentration (grams_per_litre x millilitres / 1000, giving a COFFEE mass — use this ONLY when the value you are recording is the coffee amount), concentration_water_from_coffee (coffee_grams / grams_per_litre x 1000, giving a WATER volume — use this instead of concentration whenever the value you are recording is the water amount), range_endpoint (low, high, or midpoint of a stated range), cumulative_sum (running total of prior pours), sum_of_parts (a total the source never states outright but which is the sum of two or more amounts it does state — the motivating case is an iced recipe, where the water total is the hot water plus the ice, because ice is water too). rule_source_quote must be the exact source substring stating the RULE itself (not the resulting number), and rule_inputs must hold the exact numeric operands needed to recompute the value. source_quote must be null.",
  'Worked example, multiple_of_coffee: \'Bloom with three times the dose of water\' for a 25 g dose gives { value: 75, unit: "g", provenance: "derived", source_quote: null, rule: "multiple_of_coffee", rule_source_quote: "three times the dose", rule_inputs: { multiplier: 3, coffee_amount: 25 } }.',
  'Worked example, concentration: \'Use a ratio of 60 grams per liter\' at a 500 ml water target gives the COFFEE mass, { value: 30, unit: "g", provenance: "derived", source_quote: null, rule: "concentration", rule_source_quote: "60 grams per liter", rule_inputs: { grams_per_litre: 60, millilitres: 500 } }. This rule only derives a coffee mass from a concentration and a water volume — it cannot derive a water amount, so never use it to justify a water figure.',
  'Worked example, concentration_water_from_coffee: the SAME \'Use a ratio of 60 grams per liter\' text, but now for a 30 g coffee dose, gives the WATER volume, { value: 500, unit: "ml", provenance: "derived", source_quote: null, rule: "concentration_water_from_coffee", rule_source_quote: "60 grams per liter", rule_inputs: { grams_per_litre: 60, coffee_grams: 30 } }. Never call this rule "concentration" and never pass the water figure you are trying to justify back in as one of its own rule_inputs — rule_inputs must hold only the OTHER facts (the concentration and the coffee dose), not the value being derived.',
  'Worked example, range_endpoint: \'60-90 g of coffee\', when the recipe\'s own steps settle on the low end, gives { value: 60, unit: "g", provenance: "derived", source_quote: null, rule: "range_endpoint", rule_source_quote: "60-90 g", rule_inputs: { low: 60, high: 90, endpoint: 0 }, unit_kind: "mass", stated_range: { low: 60, high: 90 } }. endpoint is 0 for the low end, 1 for the high end, 0.5 for the midpoint.',
  'Worked example, stated_range on a LITERAL record: a bloom stated as \'Pour 60-90g of water and bloom.\' where you record only the literal 60 (because that is the number the step\'s own later text settles on) still gives { value: 60, unit: "g", provenance: "literal", source_quote: "60g", rule: null, rule_source_quote: null, rule_inputs: null, unit_kind: "mass", stated_range: { low: 60, high: 90 } } — stated_range is set even though this record is literal, not range_endpoint, so the 90 is not lost from extracted_amounts entirely.',
  'Worked example, cumulative_sum: five pours to running totals 60/120/180/240/300 ml — the step pouring to 180 ml gives { value: 180, unit: "ml", provenance: "derived", source_quote: null, rule: "cumulative_sum", rule_source_quote: "<the source phrase stating the running/cumulative total for that pour>", rule_inputs: { sum: 180 } }.',
  'Worked example, sum_of_parts: an iced recipe stating \'Water: 300 g\' and \'Ice: 150 g\' never states its 450 g total, but the total IS water — ice is frozen water — so water_amount_grams is 450 and gets { value: 450, unit: "g", provenance: "derived", source_quote: null, rule: "sum_of_parts", rule_source_quote: "<the source phrase stating the parts, e.g. \'Water: 300 g\' plus \'Ice: 150 g\'>", rule_inputs: { parts: [300, 150] }, unit_kind: "mass" }. parts must list every stated component and must hold at least two entries. Use this ONLY for a total you did not find stated; if the source states the total itself, record it as literal instead. Never pass the total you are deriving back in as one of its own parts.',
  "'inferred' means there is no source basis for the value at all. inferred is PERMITTED ONLY for water temperature and grind size (never represented in extracted_amounts, since those are not coffee/water amounts) — it must NEVER be used for a coffee or water amount. If you cannot justify an amount as literal or derived per the rules above, do not invent one: leave it out of extracted_amounts rather than mark it inferred.",
  "extracted_amounts may be an empty array only when the source genuinely states no coffee or water amounts at all. Never omit a record for an amount you did extract.",
];

function buildExtractionSystemPrompt(): string {
  return [
    "You extract coffee recipes for Timer.Coffee.",
    "Return only valid JSON.",
    "CRITICAL: name, short_description, grind_size, preparation, and every step's raw_text must be written in the SAME LANGUAGE as the source recipe text. Translating any of these into a different language — including translating them into English when the source is not English — is an error, not a stylistic choice or a cleanup step.",
    "Worked example: if the source text is German, e.g. a step reading 'V60 auf die Waage stellen, Filter einsetzen und spülen.', the corresponding raw_text must stay in German, unchanged in meaning and wording, never translated to English ('Place and tare the brewer, insert and rinse the filter.').",
    "notes is diagnostic parser commentary, not recipe content, so it may be written in English regardless of the source language; mixed-language notes (English notes alongside a non-English recipe) are expected and acceptable.",
    "Do not translate or rewrite source text.",
    "Preserve literal amounts, units, and timings from the source recipe.",
    "Normalize all temperatures to Celsius before returning them.",
    "If the source text uses Fahrenheit, convert it to Celsius.",
    "Temperature fields must be bare JSON numbers only, never strings, never include units like C, F, °C, or °F.",
    "If the source states water temperature as a RANGE (e.g. '195-205°F', '92-96°C', '92-96 Grad'), also fill water_temp_stated_range with the two endpoints EXACTLY AS STATED — do not convert them, do not average them, do not pick one: { low, high, unit }, where unit is 'fahrenheit' or 'celsius' matching whatever the source used, and low/high are the literal numbers from the source in that same original unit, regardless of which is numerically smaller. This is pure transcription, the same as stated_range on extracted_amounts below — a downstream step, not you, converts and picks an endpoint from these two numbers, so do not also try to compute water_temp_celsius as a clever conversion of the range; a plain best-effort single value there is fine as a fallback. Leave water_temp_stated_range null when the source states only a single water temperature, not a range.",
    "Use null for anything not clearly stated or safely inferable.",
    "Separate untimed preparation/setup content from timed brew steps.",
    "Notes are optional and should only contain parser-relevant caveats such as ambiguity, inference, conversion, or repair concerns.",
    "Do not put generic brewing advice or recipe commentary in notes.",
    "All timed brew steps must use integer seconds when explicit or strongly inferable from local context; otherwise use null.",
    "If the source states the recipe's TOTAL brew time as a RANGE (e.g. '90-100 seconds' or '2 to 2.5 minutes'), also fill total_brew_time_stated_range with both endpoints converted to seconds: { low, high }. Preserve both endpoints even if total_brew_time_seconds selects one value or a different timing landmark. Leave total_brew_time_stated_range null when the source states only a single total, not a range.",
    "If a step starts with a timestamp like 0:45 or 1:30, that timestamp is elapsed brew time from recipe start; preserve it in raw_text and do not treat it as the step duration unless the interval to the next action is explicit.",
    "Final coffee_amount_grams and water_amount should represent the overall recipe target, not a single pour.",
    "If the source gives a range for coffee_amount_grams or water_amount (e.g. 'Dosis: 20-24g'), do not average or take the midpoint of the range. Instead use whichever value the recipe's own steps actually build up to — for example if the steps pour to a final total of 300g, use 300 for water_amount even if the intro text says '300g-350g'. If the steps never resolve the range to a single value, use the low end of the range.",
    "elapsed_seconds is an elapsed timestamp measured from timer start, NOT a duration. Example: 'At 1:30, pour to 180g' has elapsed_seconds 90 for that step.",
    "Times may be spelled as words, such as 'three fifteen to three forty-five' or 'a minute 30'; convert them to seconds.",
    "starts_timer is true only for the single step where the recipe says to start the timer or begin the first pour. At most one step may have starts_timer true.",
    "duration_is_stated is true only when the source text explicitly gives a duration for that specific step, such as 'steep for 18 hours' or 'bloom for 45 seconds'. It is false when the duration was inferred, estimated, or carried over from a recipe-level total. An elapsed timestamp like 'at 1:30' is never a stated duration — that belongs in elapsed_seconds instead.",
    "total_brew_time_seconds must come only from a statement about this recipe's own stated brew time. Ignore timing mentioned in commentary, comparisons to other brewers, equipment asides, anecdotes, or general advice unrelated to this recipe's own brew.",
    "This applies in EVERY language the source may be written in, not just English. A labelled total-time field is the same field regardless of what language it's labelled in — for example German 'Brühzeit: 2:30 - 3:30', Spanish 'tiempo de extracción', French 'temps d'infusion', or Japanese '抽出時間' are all total_brew_time_seconds, exactly like an English 'Brew time: 2:30-3:30'. Example: German 'Brühzeit: 2:30 - 3:30' becomes total_brew_time_seconds 180 (the midpoint, per the rounding rule below).",
    "A sentence stating this recipe should finish within roughly some amount of time — such as 'should be finished within about 3 minutes' or its equivalent in another language — is a STATED total brew time, not commentary, and must populate total_brew_time_seconds. Only commentary about OTHER setups, other people's brews, or general advice unrelated to this recipe's own brew should be excluded, exactly as above.",
    "Set total_brew_time_is_approximate to true when the source presents the recipe's stated total as approximate, hedged, or an estimate; set it to false when the source presents a single total as exact; leave it null when no total brew time is stated. Judge this from the meaning in the source language, not from an English keyword list. A range belongs in total_brew_time_stated_range and does not by itself make this flag true.",
    "The midpoint-of-range rule below applies only to total_brew_time_seconds. Never average or take the midpoint of a range for any other field, including coffee_amount_grams, water_amount, or any individual step's duration_seconds.",
    "If the source gives a range for total_brew_time_seconds, use the midpoint rounded to the nearest 5 seconds. Example: 'three fifteen to three forty-five' becomes 210.",
    "If no total brew time is stated for this recipe, total_brew_time_seconds must be null.",
    "Each step's scalable_amounts must list ONLY the amounts in that step's raw_text that are genuine recipe quantities: coffee or water that this recipe's own brew actually uses. Never include equipment capacities (e.g. a reservoir or tank size), product specifications, paper or filter weights, ratios quoted as an aside, comparisons to other recipes, or any number mentioned only in commentary. Example: a Gabi Dripmaster's '120ml reservoir' is equipment capacity, not a scalable amount, even in a step that also pours water. When in doubt, leave an amount out of scalable_amounts.",
    "scalable_amounts may be an empty array when a step has no genuine scalable coffee/water amount.",
    "Each step's rate_amounts must list numeric RATES stated in that step, using the numerator value and unit exactly as stated: for example '5 grams a second' becomes [{ value: 5, unit: 'grams' }]. A rate is not a recipe quantity and must never also appear in scalable_amounts. Use an empty array when the step states no rate. Judge this from the meaning in the source language, not from an English keyword list.",
    "Each step's step_role labels what that step DOES, independent of the language it is written in. Use 'preparation' for setup before brewing starts, 'bloom' for the initial wetting pour, 'pour' for any subsequent water addition, 'stir' for a stir/swirl/agitate action with no water added, 'drawdown' for waiting for the bed to drain after the last pour, and 'serve' for decanting, straining, or serving. Use null only when no role clearly applies.",
    "step_role describes the step's function, not its wording or language — for example a German step whose raw_text is 'Vollständig durchlaufen lassen.' (let it drain completely) is step_role 'drawdown', exactly like an English 'Let it fully draw down.' would be.",
    "grind_size must be a SHORT grind descriptor only — a noun phrase like 'Medium-fine' or 'Coarse, like sea salt' — never a full sentence, an instruction, or a total-brew-time statement. It is easy to mis-grab a nearby sentence that merely mentions grinding: 'Grind fine for a total brew time of 2 to 2.5 minutes.' is an INSTRUCTION about brew time, not a grind size, even though it contains the word 'grind'. If the source does not clearly state what grind setting to use, leave grind_size null — do not guess, and do not copy in the surrounding sentence just to have something non-null.",
    "grind_size_is_stated is true only when the source text itself explicitly described a grind size for this recipe (e.g. 'medium-fine grind' or 'like table salt'); it must be false whenever grind_size is null, and must also be false if you are not confident the exact words you captured describe grind size specifically (as opposed to brew time, brewing method, or an unrelated instruction).",
    ...AMOUNT_PROVENANCE_PROMPT_RULES,
  ].join(" ");
}

function buildExtractionUserPrompt(input: {
  text: string;
  brewingMethodHint?: string;
  sourceLanguageHint?: string;
}): string {
  return [
    "Extract the recipe into this JSON shape:",
    JSON.stringify(
      {
        detected_input_language: "string|null",
        likely_brewing_method: "string|null",
        name: "string|null",
        short_description: "string|null",
        grind_size: "string|null",
        grind_size_is_stated: "boolean",
        water_temp_celsius: "number|null",
        water_temp_stated_range:
          "{ low: number, high: number, unit: 'fahrenheit'|'celsius' }|null",
        coffee_amount_grams: "number|null",
        water_amount: "number|null",
        preparation: "string|null",
        steps: [
          {
            title: "string|null",
            raw_text: "string",
            duration_seconds: "number|null",
            elapsed_seconds: "number|null",
            starts_timer: "boolean",
            duration_is_stated: "boolean",
            scalable_amounts: [{ value: "number", unit: "string" }],
            rate_amounts: [{ value: "number", unit: "string" }],
            step_role: "preparation|bloom|pour|stir|drawdown|serve|null",
          },
        ],
        notes: ["string"],
        total_brew_time_seconds: "number|null",
        total_brew_time_is_approximate: "boolean|null",
        total_brew_time_stated_range: "{ low: number, high: number }|null",
        extracted_amounts: [
          {
            value: "number",
            unit: "string",
            step_index: "number (0-based, or -1 for a recipe-level amount)",
            provenance: "literal|derived|inferred",
            source_quote: "string|null",
            rule:
              "multiple_of_coffee|multiple_of_water|ratio_of_total|concentration|concentration_water_from_coffee|range_endpoint|cumulative_sum|sum_of_parts|null",
            rule_source_quote: "string|null",
            rule_inputs: "object of numeric operands, or null",
            unit_kind: "mass|volume|time|percent|null",
            stated_range: "{ low: number, high: number }|null",
          },
        ],
      },
      null,
      2,
    ),
    input.brewingMethodHint
      ? `Client brewing_method_id hint: ${input.brewingMethodHint}`
      : "Client brewing_method_id hint: none",
    input.sourceLanguageHint
      ? `Source language hint: ${input.sourceLanguageHint}`
      : "Source language hint: none",
    "Return water_temp_celsius as a bare JSON number in Celsius only. Example: 96 or 96.1, not '96C'.",
    "water_temp_stated_range is for a STATED RANGE only (e.g. '195-205°F'): transcribe low/high literally in the source's own unit, do not convert or compute anything for it. Leave it null for a single stated temperature.",
    "total_brew_time_stated_range is for a STATED TOTAL-TIME RANGE only: return both endpoints in seconds, even when total_brew_time_seconds contains one selected point or a different landmark. Leave it null for a single stated total.",
    "total_brew_time_is_approximate describes a SINGLE stated total: true for an approximate or hedged estimate, false for an exact stated total, and null when no total is stated. Determine this semantically in the source language.",
    "Recipe text:",
    input.text,
  ].join("\n\n");
}

function buildNormalizationSystemPrompt(mode: RecipeDraftParserMode): string {
  const baseRules = [
    "You normalize extracted coffee recipes for Timer.Coffee user recipes.",
    "Return only valid JSON.",
    "CRITICAL: description_source, description_template, localization.name, localization.grind_size, and localization.short_description must be written in the SAME LANGUAGE as the source recipe text. Translating any of these into a different language — including translating them into English when the source is not English — is an error, not a stylistic choice or a cleanup step.",
    "Every recipe you process is stored under the database locale value 'en', regardless of what language its text is written in. That 'en' is metadata about the storage row, set by application code, not by you — it is NOT an instruction to write English and is not a signal about what language the source is in. Do not let it influence what language you write in.",
    "Worked example: for a German source, description_source and description_template must both stay in German — e.g. a German source step 'V60 auf die Waage stellen, Filter einsetzen und spülen.' must produce description_template text still in German, such as 'V60 auf die Waage stellen, Filter einsetzen und spülen.', never translated to English ('Place and tare the brewer, insert and rinse the filter.').",
    "warnings is diagnostic parser commentary, not recipe content, so it may be written in English regardless of the source language; mixed-language warnings (English warnings alongside a non-English recipe) are expected and acceptable.",
    "All temperatures must be normalized to Celsius.",
    "If the source text used Fahrenheit, convert it to Celsius before returning JSON.",
    "Temperature fields must be bare JSON numbers only, never strings, never include units like C, F, °C, or °F.",
    "If any step description mentions temperature, normalize that mention to Celsius too.",
    "short_description must be one concise recipe-level sentence, not a mini step list.",
    "Keep setup details, hardware modifications, filter prep, rinsing, and accessory instructions in the preparation step, not short_description.",
  ];

  const descriptionRules = mode === "verify"
    ? [
      "description_template must equal description_source verbatim unless one of the explicit rewrite reasons below applies.",
      "Allowed rewrite reasons: (a) the description contains an invalid or missing scalable quantity placeholder that must be added or repaired so the recipe scales; (b) a fixed numeric coffee or water amount needs to become a scalable expression. Nothing else.",
      "Forbidden rewrites in verify mode: do not shorten, summarise, paraphrase, translate, change punctuation, expand abbreviations, add brewing-technique names (V60, Hario, Aeropress, Chemex, etc.) not already present in the input, or invent context. Marketing copy, commentary, ranges, adjectives, and teaching asides in the user's text must be kept verbatim.",
      "Preservation rules: never drop the nouns 'water', 'coffee', 'grounds', or 'beans' (or their localised equivalents). Never collapse a numeric range like '50-100g' or '50–100g' into a single value. Never change number formatting (digits, separators, units, hyphens). Never reword 'add X of water' to 'pour X' or vice versa.",
      "Preparation step (order 1) is sacred. If description_source is a generic placeholder such as 'Preparation', 'Prep', 'Setup', a single-word language equivalent, or empty, return it unchanged in description_template. Do not invent equipment, setup actions, or brewer names.",
      "If unsure whether a rewrite is required, do not rewrite.",
    ]
    : [
      "description_template must be concise timer-ready brewing instructions, not transcript prose.",
      "Use imperative wording. Remove commentary, marketing copy, explanations, and teaching asides such as why blooming happens or why filter orientation matters.",
      "Preparation should be at most two compact sentences. Each brew step should normally be one compact sentence under 140 characters unless essential details would be lost.",
    ];

  const structuralRules = [
    "The first step must be kind 'preparation' with duration_seconds 0.",
    `All later steps must be kind 'brew' with integer duration_seconds at least ${MIN_BREW_STEP_DURATION_SECONDS}.`,
    "duration_seconds is the interval until the next action or completion of that step, not an elapsed timestamp label such as 0:45 or 1:30.",
  ];

  const cumulativeHint = mode === "verify" ? [] : [
    "For multi-pour brew steps, prefer cumulative water totals after the first pour, e.g. 'pour up to 200g' rather than 'pour another 100g'.",
  ];

  const placeholderRules = [
    "Scalable quantity placeholders use exactly these two base names, and no others: <final_coffee_amount> and <final_water_amount>. An expression takes the form (M x <final_coffee_amount>)g or (M x <final_water_amount>)g/ml.",
    "M is never a fixed value copied from an example. It is a multiplier YOU compute for this specific amount, always as amount ÷ base: the numeric quantity this step actually states, divided by the recipe's final coffee_amount_grams or water_amount — whichever one the placeholder names.",
    "Worked example: (1 x <final_coffee_amount>)g illustrates the coffee case for a step whose stated amount equals the full dose, so M is 1 there. (0.2 x <final_water_amount>)g illustrates the water case only for a step whose stated amount happens to equal one-fifth of the final water amount — the 0.2 is that one step's own computed result, not a reusable constant. A different step, e.g. a bloom stated as 40 g against a 300 g final water_amount, must compute its OWN M as 40 ÷ 300 = 0.133333, giving (0.133333 x <final_water_amount>)g — copying the illustration's 0.2 onto that step would be wrong, even though 0.2 appears in these instructions.",
    "The multiplier must always be numeric, never a symbol or variable like N.",
    "Never nest scalable expressions; use either a plain numeric amount or one complete expression like (1 x <final_coffee_amount>)g.",
    "If a quantity scales with recipe coffee or water, do not leave it as a fixed literal number in description_template.",
    "Never emit <t1>..<t8> or any other time placeholder.",
    "Do not invent missing values; use null.",
    "brewing_method_id must be exactly one of the allowed ids or null, never a display label.",
    "Preserve concrete amounts and units in meaning even when converting to expressions.",
  ];

  const timingCarryRules = [
    "Each extracted step carries elapsed_seconds, starts_timer, and duration_is_stated. Carry all three through onto whichever normalized step corresponds to that original action, even if you split one extracted step into several normalized steps or merge several extracted steps into one.",
    "elapsed_seconds is an elapsed timestamp from timer start, not a duration; never compute or invent it, only carry forward the value already present on the source step it came from.",
    "starts_timer must stay true on only the single normalized step that starts the timer or begins the first pour, and false on every other step.",
    "duration_is_stated must stay true only when the source text explicitly gave a duration for that step; never set it true because you inferred or estimated a duration_seconds value yourself.",
    "Each extracted step also carries scalable_amounts. Carry it through onto whichever normalized step corresponds to that original action, splitting or merging the list along with the step. scalable_amounts must list ONLY amounts that are genuine coffee or water quantities this recipe's own brew uses — never equipment capacities, product specifications, paper or filter weights, ratios quoted as an aside, comparisons to other recipes, or numbers in commentary. Only convert a fixed numeric amount into a scalable expression in description_template when it is listed in that step's scalable_amounts.",
    "Each extracted step also carries rate_amounts. Carry every stated numeric rate through onto the corresponding normalized step, splitting or merging the list with the step. A rate must stay literal prose in description_template and must never become a scalable expression or appear in scalable_amounts.",
    "Each extracted step also carries step_role, labelling what that step DOES independent of the language it is written in: 'preparation' (setup before brewing starts), 'bloom' (the initial wetting pour), 'pour' (any subsequent water addition), 'stir' (stir/swirl/agitate with no water added), 'drawdown' (waiting for the bed to drain after the last pour), or 'serve' (decanting, straining, or serving). Carry it through onto whichever normalized step corresponds to that original action, splitting or merging steps as needed; if you split or merge a step, assign step_role yourself so it still correctly describes the resulting step's function. Example: a German 'Vollständig durchlaufen lassen.' (let it drain completely) is step_role 'drawdown', exactly like an English 'Let it fully draw down.'",
  ];

  // G22: extracted_amounts is a TOP-LEVEL array (a sibling of steps), not
  // nested inside each step, because every record already carries its own
  // step_index. Carrying it correctly means re-pointing step_index values
  // when a step is split or merged, not just copying the array unchanged.
  const provenanceCarryRules = [
    "The extraction stage also produced extracted_amounts, a top-level array of provenance records (NOT nested inside individual steps): { value, unit, step_index, provenance, source_quote, rule, rule_source_quote, rule_inputs, unit_kind, stated_range }. Carry every record through into your own extracted_amounts array.",
    "If you split one extracted step into several normalized steps, or merge several extracted steps into one, update each carried record's step_index so it still points at the correct normalized step (0-based index into your own steps array, or -1 for a recipe-level amount). Do not leave a record pointing at a step that no longer corresponds to where its amount actually appears.",
    "Do not invent new extracted_amounts records for amounts the extraction stage did not already record, and do not change a carried record's value, unit, provenance, source_quote, rule, rule_source_quote, rule_inputs, unit_kind, or stated_range — only step_index may need to change, and only to correct for a split or merge.",
    ...AMOUNT_PROVENANCE_PROMPT_RULES,
  ];

  return [
    ...baseRules,
    ...descriptionRules,
    ...structuralRules,
    ...cumulativeHint,
    ...placeholderRules,
    ...timingCarryRules,
    ...provenanceCarryRules,
  ].join(" ");
}

function buildNormalizationUserPrompt(input: {
  extraction: ExtractionResult;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): string {
  return [
    "Normalize the extracted recipe into this JSON shape:",
    JSON.stringify(
      {
        detected_input_language: "string|null",
        warnings: ["string"],
        recipe: {
          brewing_method_id: "string|null",
          brewing_method_confidence: "high|medium|low|none",
          coffee_amount: "number|null",
          water_amount: "number|null",
          water_temp: "number|null",
        },
        localization: {
          name: "string|null",
          grind_size: "string|null",
          short_description: "string|null",
        },
        steps: [
          {
            kind: "preparation|brew",
            description_source: "string",
            description_template: "string",
            duration_seconds: "number",
            elapsed_seconds: "number|null",
            starts_timer: "boolean",
            duration_is_stated: "boolean",
            scalable_amounts: [{ value: "number", unit: "string" }],
            rate_amounts: [{ value: "number", unit: "string" }],
            step_role: "preparation|bloom|pour|stir|drawdown|serve|null",
          },
        ],
        extracted_amounts: [
          {
            value: "number",
            unit: "string",
            step_index: "number (0-based, or -1 for a recipe-level amount)",
            provenance: "literal|derived|inferred",
            source_quote: "string|null",
            rule:
              "multiple_of_coffee|multiple_of_water|ratio_of_total|concentration|concentration_water_from_coffee|range_endpoint|cumulative_sum|sum_of_parts|null",
            rule_source_quote: "string|null",
            rule_inputs: "object of numeric operands, or null",
            unit_kind: "mass|volume|time|percent|null",
            stated_range: "{ low: number, high: number }|null",
          },
        ],
      },
      null,
      2,
    ),
    input.brewingMethodHint
      ? `Client brewing_method_id hint (hard constraint): ${input.brewingMethodHint}`
      : "Client brewing_method_id hint (hard constraint): none",
    "Return recipe.water_temp as a bare JSON number in Celsius only. Example: 96 or 96.1, not '96C'.",
    "Allowed brewing methods:",
    buildBrewingMethodsPrompt(input.brewingMethods),
    "Extracted recipe JSON:",
    JSON.stringify(input.extraction, null, 2),
  ].join("\n\n");
}

function buildRepairSystemPrompt(mode: RecipeDraftParserMode): string {
  const baseRules = [
    "You repair incomplete normalized coffee recipes for Timer.Coffee user recipes.",
    "Return only valid JSON.",
    "You must return the same normalized JSON shape as the normalization stage.",
    "Re-read the original source text carefully and fill in only these fields when they were missed: localization.name, localization.grind_size, localization.short_description, recipe.water_temp. These may be reasonably inferred from the brewing method or general context.",
    "Keep already-correct values stable unless they clearly contradict the source text.",
    "CRITICAL: description_source, description_template, localization.name, localization.grind_size, and localization.short_description must be written in the SAME LANGUAGE as the source recipe text. Translating any of these into a different language — including translating them into English when the source is not English — is an error, not a stylistic choice or a cleanup step.",
    "Every recipe you process is stored under the database locale value 'en', regardless of what language its text is written in. That 'en' is metadata about the storage row, set by application code, not by you — it is NOT an instruction to write English and is not a signal about what language the source is in. Do not let it influence what language you write in.",
    "Worked example: for a German source, description_source and description_template must both stay in German — e.g. a German source step 'V60 auf die Waage stellen, Filter einsetzen und spülen.' must produce description_template text still in German, such as 'V60 auf die Waage stellen, Filter einsetzen und spülen.', never translated to English ('Place and tare the brewer, insert and rinse the filter.').",
    "warnings is diagnostic parser commentary, not recipe content, so it may be written in English regardless of the source language; mixed-language warnings (English warnings alongside a non-English recipe) are expected and acceptable.",
    "All temperatures must be normalized to Celsius.",
    "If the source text used Fahrenheit, convert it to Celsius before returning JSON.",
    "Temperature fields must be bare JSON numbers only, never strings, never include units like C, F, °C, or °F.",
    "If any step description mentions temperature, normalize that mention to Celsius too.",
    "If recipe.water_temp is not mentioned in the source text, infer a sensible default from the brewing method: use 93 for most filter methods (pour-over, drip, Aeropress, Chemex, Moka), 96 for espresso, 100 for French press or hot immersion, 93 as a safe fallback for any other method.",
    "Exception to the water_temp default above: if the source text explicitly indicates cold, iced, or room-temperature water, or the brewing method is cold brew, do NOT apply a hot-method default (not 93, not 96, not 100). Cold brew is a form of immersion but is not HOT immersion, so the 'French press or hot immersion' rule above must not fire for it. In this case, return null for recipe.water_temp instead of guessing a temperature — a correct null is far better than a confidently wrong hot number, and null here is a reviewable outcome, not an error.",
    "localization.grind_size must be a SHORT grind descriptor only — a noun phrase like 'Medium-fine' or 'Coarse, like sea salt' — never a full sentence, a brewing instruction, or a total-brew-time statement copied from a nearby part of the source text. If the source text does not clearly and specifically describe a grind SIZE (as opposed to brew time, brewing method, or an unrelated instruction that merely happens to be nearby), do not copy that other text in as a substitute: infer from the brewing method instead — 'fine' for espresso or Moka, 'medium-fine' for pour-over or V60, 'medium' for drip or Aeropress, 'coarse' for French press or cold brew, 'medium' as a safe fallback for any other method.",
    "Never return null for recipe.water_temp or localization.grind_size — always provide a value (a stated grind description, or one of the short inferred phrases above) if the source text is silent — EXCEPT the cold/iced/room-temperature/cold-brew case above, where recipe.water_temp must stay null rather than default to a hot temperature.",
    "recipe.coffee_amount, recipe.water_amount, and recipe.brewing_method_id must come only from what the source text explicitly states. Never invent, estimate, or default these three fields, even when the brewing method makes a typical value obvious.",
    "If the source text does not state a coffee amount, water amount, or brewing method, return null for that specific field. Returning null for these three fields is correct and expected when the source is silent — do not treat it as an error to fix.",
    "short_description must be one concise recipe-level sentence, not a mini step list.",
    "Keep setup details, hardware modifications, filter prep, rinsing, and accessory instructions in the preparation step, not short_description.",
  ];

  const descriptionRules = mode === "verify"
    ? [
      "description_template must equal description_source verbatim unless one of the explicit rewrite reasons below applies.",
      "Allowed rewrite reasons: (a) the description contains an invalid or missing scalable quantity placeholder that must be added or repaired so the recipe scales; (b) a fixed numeric coffee or water amount needs to become a scalable expression. Nothing else.",
      "Forbidden rewrites in verify mode: do not shorten, summarise, paraphrase, translate, change punctuation, expand abbreviations, add brewing-technique names (V60, Hario, Aeropress, Chemex, etc.) not already present in the input, or invent context. Marketing copy, commentary, ranges, adjectives, and teaching asides in the user's text must be kept verbatim.",
      "Preservation rules: never drop the nouns 'water', 'coffee', 'grounds', or 'beans' (or their localised equivalents). Never collapse a numeric range like '50-100g' or '50–100g' into a single value. Never change number formatting (digits, separators, units, hyphens). Never reword 'add X of water' to 'pour X' or vice versa.",
      "Preparation step (order 1) is sacred. If description_source is a generic placeholder such as 'Preparation', 'Prep', 'Setup', a single-word language equivalent, or empty, return it unchanged in description_template. Do not invent equipment, setup actions, or brewer names.",
      "If unsure whether a rewrite is required, do not rewrite.",
    ]
    : [
      "description_template must be concise timer-ready brewing instructions, not transcript prose.",
      "Use imperative wording. Remove commentary, marketing copy, explanations, and teaching asides such as why blooming happens or why filter orientation matters.",
      "Preparation should be at most two compact sentences. Each brew step should normally be one compact sentence under 140 characters unless essential details would be lost.",
    ];

  const structuralRules = [
    "The first step must be kind 'preparation' with duration_seconds 0.",
    `All later steps must be kind 'brew' with integer duration_seconds at least ${MIN_BREW_STEP_DURATION_SECONDS}.`,
    "duration_seconds is the interval until the next action or completion of that step, not an elapsed timestamp label such as 0:45 or 1:30.",
  ];

  const cumulativeHint = mode === "verify" ? [] : [
    "For multi-pour brew steps, prefer cumulative water totals after the first pour, e.g. 'pour up to 200g' rather than 'pour another 100g'.",
  ];

  const placeholderRules = [
    "Scalable quantity placeholders use exactly these two base names, and no others: <final_coffee_amount> and <final_water_amount>. An expression takes the form (M x <final_coffee_amount>)g or (M x <final_water_amount>)g/ml.",
    "M is never a fixed value copied from an example. It is a multiplier YOU compute for this specific amount, always as amount ÷ base: the numeric quantity this step actually states, divided by the recipe's final coffee_amount_grams or water_amount — whichever one the placeholder names.",
    "Worked example: (1 x <final_coffee_amount>)g illustrates the coffee case for a step whose stated amount equals the full dose, so M is 1 there. (0.2 x <final_water_amount>)g illustrates the water case only for a step whose stated amount happens to equal one-fifth of the final water amount — the 0.2 is that one step's own computed result, not a reusable constant. A different step, e.g. a bloom stated as 40 g against a 300 g final water_amount, must compute its OWN M as 40 ÷ 300 = 0.133333, giving (0.133333 x <final_water_amount>)g — copying the illustration's 0.2 onto that step would be wrong, even though 0.2 appears in these instructions.",
    "The multiplier must always be numeric, never a symbol or variable like N.",
    "Never nest scalable expressions; use either a plain numeric amount or one complete expression like (1 x <final_coffee_amount>)g.",
    "Never emit <t1>..<t8> or any other time placeholder.",
    "brewing_method_id must be exactly one of the allowed ids or null, never a display label.",
  ];

  const timingCarryRules = [
    "Each normalized step carries elapsed_seconds, starts_timer, and duration_is_stated from the extraction stage. Keep already-correct values stable and carry them onto whichever step corresponds to the original action, splitting or merging steps as needed.",
    "elapsed_seconds is an elapsed timestamp from timer start, not a duration; never compute or invent it, only carry forward the value already present.",
    "starts_timer must stay true on only the single step that starts the timer or begins the first pour, and false on every other step.",
    "duration_is_stated must stay true only when the source text explicitly gave a duration for that step; never set it true because you inferred or estimated a duration_seconds value yourself.",
    "Each normalized step also carries scalable_amounts from the extraction stage. Keep already-correct values stable and carry them onto whichever step corresponds to the original action. scalable_amounts must list ONLY amounts that are genuine coffee or water quantities this recipe's own brew uses — never equipment capacities, product specifications, paper or filter weights, ratios quoted as an aside, comparisons to other recipes, or numbers in commentary.",
    "Each normalized step also carries rate_amounts from extraction. Keep those rates attached to the corresponding step and literal in description_template; never turn one into a scalable expression or move it into scalable_amounts.",
    "Each normalized step also carries step_role from the extraction stage — one of preparation, bloom, pour, stir, drawdown, or serve, labelling what that step DOES independent of the language it is written in (e.g. a German 'Vollständig durchlaufen lassen.' is step_role 'drawdown', exactly like an English 'Let it fully draw down.'). Keep already-correct values stable and carry them onto whichever step corresponds to the original action.",
  ];

  const provenanceCarryRules = [
    "The current normalized JSON also carries extracted_amounts, a top-level array of provenance records (NOT nested inside individual steps): { value, unit, step_index, provenance, source_quote, rule, rule_source_quote, rule_inputs, unit_kind, stated_range }. Carry every record through into your own extracted_amounts array unchanged, including when you only repaired other fields.",
    "If repairing requires you to split or merge a step, update each affected record's step_index so it still points at the correct step (0-based index into your own steps array, or -1 for a recipe-level amount). Otherwise leave every record exactly as given — repair never invents, drops, or edits an extracted_amounts record's value, unit, provenance, source_quote, rule, rule_source_quote, rule_inputs, unit_kind, or stated_range.",
    ...AMOUNT_PROVENANCE_PROMPT_RULES,
  ];

  return [
    ...baseRules,
    ...descriptionRules,
    ...structuralRules,
    ...cumulativeHint,
    ...placeholderRules,
    ...timingCarryRules,
    ...provenanceCarryRules,
  ].join(" ");
}

function buildRepairUserPrompt(input: {
  text: string;
  extraction: ExtractionResult;
  normalized: NormalizedDraft;
  missingFields: string[];
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): string {
  return [
    "Repair the normalized recipe. Return the full normalized JSON shape, not a patch.",
    `Missing or unresolved required fields: ${input.missingFields.join(", ")}`,
    input.brewingMethodHint
      ? `Client brewing_method_id hint (hard constraint): ${input.brewingMethodHint}`
      : "Client brewing_method_id hint (hard constraint): none",
    "Return recipe.water_temp as a bare JSON number in Celsius only. Example: 96 or 96.1, not '96C'.",
    "Allowed brewing methods:",
    buildBrewingMethodsPrompt(input.brewingMethods),
    "Original source text:",
    input.text,
    "Extraction JSON:",
    JSON.stringify(input.extraction, null, 2),
    "Current incomplete normalized JSON:",
    JSON.stringify(input.normalized, null, 2),
  ].join("\n\n");
}

function buildCumulativeRewriteSystemPrompt(
  mode: RecipeDraftParserMode,
): string {
  const baseRules = [
    "You rewrite coffee recipe brew-step wording for Timer.Coffee.",
    "Return only valid JSON.",
    "Preserve the original language of the step descriptions. Do not translate.",
    "Keep step count, step order, kind, duration_seconds, description_source, elapsed_seconds, starts_timer, duration_is_stated, scalable_amounts, rate_amounts, and step_role unchanged.",
    "Only rewrite brew-step description_template fields when needed.",
  ];

  const cumulativeRules = mode === "verify"
    ? [
      "Only rewrite a later water-addition brew step when its description_source is unambiguously incremental (for example 'add another 100g', 'pour 100g more', 'add an additional 100g').",
      "If wording is ambiguous, neutral, or already cumulative ('pour to 200g', 'reach 200g', '200g total'), set description_template equal to description_source verbatim.",
      "When you do rewrite, change only the quantity-and-preposition phrase. Preserve every other word: keep the noun 'water', keep ranges, keep adjectives, keep punctuation.",
      "Never rewrite a preparation step in this stage. Never rewrite the first water-addition step.",
      "If unsure whether a rewrite is required, do not rewrite.",
    ]
    : [
      "For multi-pour brew recipes, the first water-addition step may stay as the amount added in that step.",
      "For later water-addition brew steps, prefer cumulative total water after the pour, such as 'pour up to 200g' rather than 'pour another 100g'.",
      "Treat wording such as 'pour to 200g', 'pour until 200g', 'reach 200g', or '200g total' as already cumulative; do not add it to earlier pours.",
      "If a step already uses cumulative total wording correctly, leave it unchanged.",
    ];

  const tailRules = [
    "Preserve all valid scalable quantity placeholders and keep numeric multipliers valid.",
    "Never emit <t1>..<t8> or any other time placeholder.",
  ];

  return [...baseRules, ...cumulativeRules, ...tailRules].join(" ");
}

function buildCumulativeRewriteUserPrompt(input: {
  mode: RecipeDraftParserMode;
  detectedInputLanguage: string | null;
  normalized: NormalizedDraft;
  draftSteps: DraftStep[];
}): string {
  const sections = [
    "Rewrite later brew steps to cumulative total water wording only when needed.",
    input.detectedInputLanguage
      ? `Detected recipe language: ${input.detectedInputLanguage}`
      : "Detected recipe language: unknown",
    "Return this JSON shape:",
    JSON.stringify(
      {
        warnings: ["string"],
        steps: [
          {
            kind: "preparation|brew",
            description_source: "string",
            description_template: "string",
            duration_seconds: "number",
            elapsed_seconds: "number|null",
            starts_timer: "boolean",
            duration_is_stated: "boolean",
            scalable_amounts: [{ value: "number", unit: "string" }],
            rate_amounts: [{ value: "number", unit: "string" }],
            step_role: "preparation|bloom|pour|stir|drawdown|serve|null",
          },
        ],
      },
      null,
      2,
    ),
    "Current normalized steps:",
    JSON.stringify(input.normalized.steps, null, 2),
    "Current rendered draft steps for reference:",
    JSON.stringify(input.draftSteps, null, 2),
  ];

  if (input.mode === "verify") {
    sections.push(
      "For every step where no rewrite reason applies, set description_template equal to description_source verbatim.",
    );
  }

  return sections.join("\n\n");
}

function renderPreviewText(
  template: string,
  coffeeAmount: number | null,
  waterAmount: number | null,
): string {
  return template.replaceAll(
    cloneRegex(EXPRESSION_REGEX),
    (
      fullMatch,
      multiplierValue: string,
      placeholderValue: string,
      unitValue: string,
    ) => {
      const multiplier = Number(multiplierValue);
      if (!Number.isFinite(multiplier)) {
        return fullMatch;
      }

      const normalizedPlaceholder = String(placeholderValue).toLowerCase();
      const baseAmount = normalizedPlaceholder === "final_coffee_amount"
        ? coffeeAmount
        : waterAmount;
      if (baseAmount === null || !Number.isFinite(baseAmount)) {
        return fullMatch;
      }

      const computed = multiplier * baseAmount;
      const formatted = Number.isInteger(computed)
        ? String(computed)
        : computed.toFixed(1).replace(/\.0$/, "");
      const unit = unitValue ?? "";
      const separator = unit.length > 1 ? " " : "";
      return `${formatted}${separator}${unit}`;
    },
  );
}

function usesCumulativeWaterLanguage(template: string): boolean {
  const normalized = normalizeKeywordText(template);
  return /\b(?:up to|total|pour to|pour until|pour till|reach|reaching)\b/i
    .test(normalized);
}

function normalizeLeadingTimestampLabel(template: string): string {
  return template
    .replace(/^\s*(?:at\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*,?\s*/i, "")
    .replace(/^([a-z])/, (match) => match.toUpperCase());
}

function normalizeTemplateTextPolish(template: string): string {
  return template
    .replace(
      /\bheat\s+(?:about\s+)?(?:a\s+)?(?:full\s+)?kettle\s+of\s+water\s+to\s+between\s+(\d+(?:\.\d+)?)\s+(?:and|to|-)\s+\1C\b/gi,
      (_match, numericValue) => `heat water to ${numericValue}C`,
    )
    .replace(
      /\b(heat\s+water\s+to\s+)(\d+(?:\.\d+)?)(?!\.\d)(?=\s*[,.;:]|\s|$)(?!\s*[°º]?\s*c\b)/gi,
      (_match, prefix, numericValue) => `${prefix}${numericValue}C`,
    )
    .replace(
      /^(\s*)([a-z])/,
      (_match, prefix, firstLetter) =>
        `${prefix}${String(firstLetter).toUpperCase()}`,
    )
    .replace(/\s+/g, " ")
    .trim();
}

// F2: simplifyVerboseChemexPreparation, simplifyVerboseBrewTemplate, and
// simplifyVerboseStepTemplate used to live here. They were tuned on one
// specific Chemex transcript and fired on ANY step whose text contained a
// trigger phrase (e.g. "final pour") plus a water expression, discarding
// everything else in the step — including real technique detail like
// temperature and pour pattern. Deleted rather than fixed: conciseness is
// the normalization prompt's job, not a hand-tuned regex's. Do not
// reintroduce canned per-phrase rewrites here.
function normalizeCumulativeWaterWording(template: string): string {
  return template
    .replace(/\bpour\s+to\s+/gi, "pour up to ")
    .replace(/\bpour\s+until\s+/gi, "pour up to ")
    .replace(/\bpour\s+till\s+/gi, "pour up to ")
    .replace(/\breach(?:ing)?\s+/gi, "reach ");
}

function normalizeExpressionUnit(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (normalized === "gram" || normalized === "grams") {
    return "g";
  }
  if (
    normalized === "milliliter" ||
    normalized === "milliliters" ||
    normalized === "millilitre" ||
    normalized === "millilitres"
  ) {
    return "ml";
  }
  return unit;
}

function replaceFirstWaterExpression(
  template: string,
  replacement: string,
): string {
  let replaced = false;

  return template.replace(
    cloneRegex(EXPRESSION_REGEX),
    (fullMatch, multiplierValue: string, placeholderValue: string) => {
      if (replaced) {
        return fullMatch;
      }

      const multiplier = Number(multiplierValue);
      if (!Number.isFinite(multiplier)) {
        return fullMatch;
      }

      if (String(placeholderValue).toLowerCase() !== "final_water_amount") {
        return fullMatch;
      }

      replaced = true;
      return replacement;
    },
  );
}

// F3: rewrites the quantifier phrase in front of a water expression to
// cumulative "pour up to" wording, along with swapping in the cumulative
// amount. Returns rewritten:false when no recognized quantifier pattern
// matched, so the caller can refuse to apply the cumulative amount rather
// than leave a stale quantifier (e.g. "the remaining") next to a total it
// no longer describes — the F3 bug was exactly this: "remaining 200g" was
// renumbered to the recipe's 400g total while the word "remaining" (which
// only makes sense for the incremental 200g) survived untouched.
function rewriteWaterPhraseToCumulative(
  template: string,
  expression: string,
): { template: string; rewritten: boolean } {
  const escapedExpression = escapeRegExp(expression);
  const quantifierGroup =
    "(?:another|a\\s+further|the\\s+remaining|the\\s+rest\\s+of|the\\s+final|final)\\s+";
  const phrasePatterns = [
    new RegExp(
      `\\b(?:pour|add)\\s+(?:${quantifierGroup})?${escapedExpression}(\\s+of\\s+water)?`,
      "i",
    ),
    new RegExp(
      `\\b(?:pour|add)\\s+${escapedExpression}(\\s+of\\s+water)?`,
      "i",
    ),
  ];

  for (const pattern of phrasePatterns) {
    if (pattern.test(template)) {
      return {
        template: template.replace(
          pattern,
          (_, waterSuffix = "") => `pour up to ${expression}${waterSuffix}`,
        ),
        rewritten: true,
      };
    }
  }

  return { template, rewritten: false };
}

function extractExpressions(
  template: string,
  coffeeAmount: number | null,
  waterAmount: number | null,
): DraftExpression[] {
  const expressions: DraftExpression[] = [];
  for (const match of template.matchAll(EXPRESSION_REGEX)) {
    const multiplier = Number(match[1]);
    const placeholder = `<${match[2]}>` as
      | "<final_coffee_amount>"
      | "<final_water_amount>";
    const unit = (match[3] ?? "").trim();
    const baseAmount = placeholder === "<final_coffee_amount>"
      ? coffeeAmount
      : waterAmount;
    const previewValue = baseAmount === null ? null : Number(
      (multiplier * baseAmount).toFixed(2),
    );

    expressions.push({
      placeholder,
      multiplier: Number(formatMultiplier(multiplier)),
      unit,
      preview_value: previewValue,
    });
  }

  return expressions;
}

function collectUnsupportedPlaceholders(template: string): string[] {
  const placeholders: string[] = [];
  for (const match of template.matchAll(UNSUPPORTED_PLACEHOLDER_REGEX)) {
    const placeholder = match[1];
    if (
      placeholder !== "final_coffee_amount" &&
      placeholder !== "final_water_amount"
    ) {
      placeholders.push(`<${placeholder}>`);
    }
  }
  return placeholders;
}

function collectMalformedSupportedPlaceholders(template: string): string[] {
  const strippedValidExpressions = template.replaceAll(
    cloneRegex(EXPRESSION_REGEX),
    "",
  );
  const placeholders: string[] = [];

  for (
    const match of strippedValidExpressions.matchAll(
      SUPPORTED_PLACEHOLDER_REGEX,
    )
  ) {
    placeholders.push(`<${String(match[1]).toLowerCase()}>`);
  }

  return uniqueStrings(placeholders);
}

function hasBalancedParentheses(template: string): boolean {
  let depth = 0;
  for (const char of template) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0;
}

function hasDanglingExpressionMultiplier(template: string): boolean {
  const strippedValidExpressions = template.replaceAll(
    cloneRegex(EXPRESSION_REGEX),
    "",
  );
  return /(?:^|[(\s])[\d.]+\s*(?:x|×)\s*(?=$|[),.;:]|\s)/i.test(
    strippedValidExpressions,
  );
}

function hasInvalidExpressionSyntax(template: string): boolean {
  return collectUnsupportedPlaceholders(template).length > 0 ||
    collectMalformedSupportedPlaceholders(template).length > 0 ||
    !hasBalancedParentheses(template) ||
    hasDanglingExpressionMultiplier(template);
}

// D3'/Phase 2 (plan 016 §3 D3', §4 Phase 2): normalizeLeadingTimestampLabel,
// normalizeCumulativeWaterWording and normalizeTemplateTextPolish (the
// three passes chained just below) are the actual, deterministic source of
// the "0:00 pour 50g" -> "Pour 50g" and "pour to" -> "Pour up to"
// wording regressions observed in verify mode -- Phase 0 walked all four
// stage_outputs for the affected captures and found the LLM repair and
// cumulative_rewrite stages returned empty arrays (never invoked); this
// function ran regardless of mode and rewrote the wording anyway. Extract
// mode's use of these three is correct and desirable (stripping a
// transcript timestamp, capitalizing, and tidying "pour to" phrasing is
// exactly the cleanup a raw transcript needs) and MUST stay byte-identical
// to before this change -- the six golden fixtures are the proof of that.
// verify mode's entire contract is the opposite: the input is already a
// well-formed, previously-generated recipe, and nothing about its wording
// should be silently rewritten. The existing verify-mode prompt rules
// (buildNormalizationSystemPrompt/buildRepairSystemPrompt's "description_
// template must equal description_source verbatim") are aimed at the LLM
// stages, which were never the culprit here -- they are left in place
// because they reduce how often a rewrite reaches this function in the
// first place (mirrors F32's "prompt rule stays, code enforces" shape),
// but the actual guarantee now lives here, deterministically, gated on
// mode rather than left to model compliance.
function normalizeStepDescriptionTemplate(args: {
  step: NormalizedDraft["steps"][number];
  coffeeAmount: number | null;
  waterAmount: number | null;
  resolvedTemperatureCelsius?: number;
  mode: RecipeDraftParserMode;
}): string {
  // Verify mode receives an already-formed recipe. Its submitted step text is
  // the authority: even a syntactically valid model-authored expression can
  // invent an amount absent from that step (E3's three live captures). Do not
  // attempt to distinguish acceptable from unacceptable rewrites downstream;
  // preserve description_source byte-for-byte as the mode promises.
  if (args.mode === "verify") {
    return args.step.description_source;
  }

  const normalizeCandidate = (candidate: string) => {
    const rateSafeCandidate = restoreRateExpressionsToLiterals({
      description: candidate,
      coffeeAmount: args.coffeeAmount,
      waterAmount: args.waterAmount,
      rateAmounts: args.step.rate_amounts ?? [],
    });
    const normalizedExpressionMathTemplate = normalizeExpressionLikeMath({
      description: rateSafeCandidate,
      coffeeAmount: args.coffeeAmount,
      waterAmount: args.waterAmount,
    });
    const normalizedTemperatureTemplate = normalizeTemperatureMentionsInText(
      normalizedExpressionMathTemplate,
      args.resolvedTemperatureCelsius,
    ).text;
    const normalizedTemplate = convertNumericValuesToExpressions({
      description: normalizedTemperatureTemplate,
      stepKind: args.step.kind,
      coffeeAmount: args.coffeeAmount,
      waterAmount: args.waterAmount,
      scalableAmounts: args.step.scalable_amounts,
      rateAmounts: args.step.rate_amounts ?? [],
      stepRole: args.step.step_role,
    });

    return normalizeTemplateTextPolish(
      normalizeCumulativeWaterWording(
        normalizeLeadingTimestampLabel(normalizedTemplate),
      ),
    );
  };

  const normalizedTemplate = normalizeCandidate(args.step.description_template);
  if (!hasInvalidExpressionSyntax(normalizedTemplate)) {
    return normalizedTemplate;
  }

  const sourceTemplate = normalizeCandidate(args.step.description_source);
  return hasInvalidExpressionSyntax(sourceTemplate)
    ? normalizedTemplate
    : sourceTemplate;
}

function buildDraftSteps(input: {
  steps: NormalizedDraft["steps"];
  coffeeAmount: number | null;
  waterAmount: number | null;
  resolvedTemperatureCelsius?: number;
  mode: RecipeDraftParserMode;
}): DraftStep[] {
  return input.steps.map((step, index) => {
    const normalizedTemplate = normalizeStepDescriptionTemplate({
      step,
      coffeeAmount: input.coffeeAmount,
      waterAmount: input.waterAmount,
      resolvedTemperatureCelsius: input.resolvedTemperatureCelsius,
      mode: input.mode,
    });

    return {
      step_order: index + 1,
      kind: step.kind,
      description_source: step.description_source,
      description_template: normalizedTemplate,
      preview_text: renderPreviewText(
        normalizedTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
      duration_seconds: step.duration_seconds,
      elapsed_seconds: step.elapsed_seconds,
      starts_timer: step.starts_timer,
      duration_is_stated: step.duration_is_stated,
      scalable_amounts: step.scalable_amounts,
      ...(step.rate_amounts?.length
        ? { rate_amounts: step.rate_amounts }
        : {}),
      step_role: step.step_role,
      expressions: extractExpressions(
        normalizedTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
    };
  });
}

function endsWithSentenceTerminator(text: string): boolean {
  return /[.!?]\s*$/.test(text);
}

function joinFoldedStepText(parts: string[]): string {
  return parts.reduce((accumulated, part) => {
    const trimmedPart = part.trim();
    if (!trimmedPart) {
      return accumulated;
    }
    if (!accumulated) {
      return trimmedPart;
    }
    const separator = endsWithSentenceTerminator(accumulated) ? " " : ". ";
    return `${accumulated}${separator}${trimmedPart}`;
  }, "");
}

// The Flutter app renders exactly one untimed step (steps[0], duration 0,
// shown as "preparation") — there is no timer-start marker. Some recipes
// perform real actions (filling the dripper, adding coffee) BEFORE the
// timer starts; if those land as timed brew steps, the app's on-screen
// timer drifts ahead of the source recipe's own clock. Fold any such
// pre-timer actions into the preparation step instead of timing them.
//
// Plan 016 §4 Phase 4: this fold is exactly the mechanism that produces the
// Hario "20g was recorded for step 3 but appears on step 1" false block —
// extracted_amounts records carry step_index values from BEFORE this pass
// ran (see the comment on `remapStepIndex` below and provenance.ts's own
// note on why a >1 drift is tolerated). The fold is deterministic and fully
// invertible as an index mapping, so `remapStepIndex` is returned alongside
// the folded steps and the caller applies it to extracted_amounts at the
// same call site this fold runs from, keeping the two in lockstep. This is
// NOT true of step splitting (see that mapping's own doc comment) — do not
// generalize this pattern to splits.
function foldPreTimerStepsIntoPreparation(
  input: {
    steps: DraftStep[];
    // verify-user-recipe-draft's handler hard-502s the app the moment the
    // parser's step count diverges from the request's (see
    // verify-user-recipe-draft/handler.ts), and folding removes steps — so
    // verify mode must skip this pass outright, warning included, rather
    // than merely running it "safely".
    preserveStepCount: boolean;
  },
): {
  steps: DraftStep[];
  warnings: string[];
  /**
   * Maps a PRE-fold 0-based step index (the step_index an extracted_amounts
   * record carries) to its POST-fold 0-based index in `steps` above. Identity
   * when nothing was folded (preserveStepCount, or no qualifying timer-start
   * step found) — always safe to call unconditionally. A recipe-level
   * `step_index: -1` sentinel happens to fall into the `stepIndex <= 0`
   * branch below and comes back unchanged, but callers must still skip -1
   * explicitly rather than rely on that — -1 is not a real step index (see
   * the D4/D4′ range-collapse check, which already applies this same guard).
   */
  remapStepIndex: (stepIndex: number) => number;
} {
  const identityRemap = (stepIndex: number) => stepIndex;

  if (input.preserveStepCount) {
    return { steps: input.steps, warnings: [], remapStepIndex: identityRemap };
  }

  const startsTimerIndex = input.steps.findIndex((step) =>
    step.kind === "brew" && startsTimerLikeStep(step)
  );

  // No timer-start marker found, or it's already the first brew step (index
  // <= 1) — nothing to fold. This is the common case, so keep blast radius
  // small.
  if (startsTimerIndex === -1 || startsTimerIndex <= 1) {
    return { steps: input.steps, warnings: [], remapStepIndex: identityRemap };
  }

  const preparationStep = input.steps[0];
  const foldedSteps = input.steps.slice(1, startsTimerIndex);
  const mergedRateAmounts = [
    ...(preparationStep.rate_amounts ?? []),
    ...foldedSteps.flatMap((step) => step.rate_amounts ?? []),
  ];

  const mergedPreparationStep: DraftStep = {
    ...preparationStep,
    description_source: joinFoldedStepText([
      preparationStep.description_source,
      ...foldedSteps.map((step) => step.description_source),
    ]),
    description_template: joinFoldedStepText([
      preparationStep.description_template,
      ...foldedSteps.map((step) => step.description_template),
    ]),
    ...(mergedRateAmounts.length > 0
      ? { rate_amounts: mergedRateAmounts }
      : {}),
  };

  const remainingSteps = [
    mergedPreparationStep,
    ...input.steps.slice(startsTimerIndex),
  ].map((step, index) => ({
    ...step,
    step_order: index + 1,
  }));

  // old 0                      -> new 0
  // old 1..startsTimerIndex-1  -> new 0        (folded into preparation)
  // old i >= startsTimerIndex  -> new i - (startsTimerIndex - 1)
  const remapStepIndex = (stepIndex: number): number => {
    if (stepIndex <= 0) {
      return stepIndex;
    }
    if (stepIndex < startsTimerIndex) {
      return 0;
    }
    return stepIndex - (startsTimerIndex - 1);
  };

  return {
    steps: remainingSteps,
    warnings: [
      "Pre-timer actions were folded into the preparation step.",
    ],
    remapStepIndex,
  };
}

function convertWaterStepsToRunningTotals(input: {
  steps: DraftStep[];
  coffeeAmount: number | null;
  waterAmount: number | null;
}): { steps: DraftStep[]; warnings: string[] } {
  if (input.waterAmount === null || input.waterAmount <= 0) {
    return { steps: input.steps, warnings: [] };
  }

  const finalWaterAmount = input.waterAmount;
  // Pre-timer preparation actions (e.g. filling the dripper before starting
  // the timer) can get folded into the preparation step by
  // foldPreTimerStepsIntoPreparation. That step is never walked below since
  // this loop only touches kind === "brew" steps, so seed the running total
  // from any water expression already present in the preparation step —
  // otherwise water poured during a folded preparation step would be
  // excluded from the running total and later cumulative pours would be
  // understated.
  const preparationStep = input.steps[0];
  const preparationWaterExpression = preparationStep?.kind === "preparation"
    ? preparationStep.expressions.find((expression) =>
      expression.placeholder === "<final_water_amount>" &&
      expression.preview_value !== null
    )
    : undefined;
  let runningWaterAmount = preparationWaterExpression?.preview_value ?? 0;
  const warnings: string[] = [];

  const steps = input.steps.map((step) => {
    if (step.kind !== "brew") {
      return step;
    }

    const waterExpression = step.expressions.find((expression) =>
      expression.placeholder === "<final_water_amount>" &&
      expression.preview_value !== null
    );

    if (!waterExpression || waterExpression.preview_value === null) {
      return step;
    }

    const stepWaterAmount = waterExpression.preview_value;

    if (usesCumulativeWaterLanguage(step.description_template)) {
      runningWaterAmount = Math.max(runningWaterAmount, stepWaterAmount);
      return step;
    }

    const nextRunningTotal = runningWaterAmount + stepWaterAmount;
    if (runningWaterAmount <= 0 || nextRunningTotal > finalWaterAmount + 0.5) {
      runningWaterAmount = nextRunningTotal;
      return step;
    }

    const cumulativeExpression = `(${
      formatMultiplier(nextRunningTotal / finalWaterAmount)
    } x <final_water_amount>)${waterExpression.unit}`;
    const phraseRewrite = rewriteWaterPhraseToCumulative(
      replaceFirstWaterExpression(
        step.description_template,
        cumulativeExpression,
      ),
      cumulativeExpression,
    );

    // The physical running total is correct regardless of whether this
    // step's own wording could be rewritten, so later steps' cumulative
    // math must still account for the water this step adds.
    runningWaterAmount = nextRunningTotal;

    if (!phraseRewrite.rewritten) {
      // F3: no recognized quantifier phrase (pour/add [another|the
      // remaining|the rest of|a further|the final] <amount>) was found.
      // Renumbering the amount to the cumulative total while leaving
      // unrecognized wording in place (e.g. "the remaining 200g" next to
      // a computed 400g) would produce a self-contradicting sentence.
      // Skip the cumulative rewrite for this step and keep its own
      // incremental amount and wording untouched instead.
      warnings.push(
        "Cumulative water wording could not be safely rewritten for a brew step; the incremental amount was kept instead.",
      );
      return step;
    }

    return {
      ...step,
      description_template: phraseRewrite.template,
      preview_text: renderPreviewText(
        phraseRewrite.template,
        input.coffeeAmount,
        input.waterAmount,
      ),
      expressions: extractExpressions(
        phraseRewrite.template,
        input.coffeeAmount,
        input.waterAmount,
      ),
    };
  });

  return { steps, warnings };
}

// D7 (plan 020 §3 D7, §4b decision — product decision made 2026-08-13: keep
// the 10-second minimum, absorb the delta from an adjacent step rather than
// silently inflating the timeline).
//
// Before this phase, a stated sub-minimum brew step (the AeroPress WAC
// source's "0:10-0:15 stir very gently", a 5-second action) was simply
// bumped to MIN_BREW_STEP_DURATION_SECONDS, MANUFACTURING seconds that
// pushed every later elapsed landmark back by the delta — G22 then
// enumerated each shifted landmark as a warning even though the recipe
// stayed publishable. That is a symptom of the same root cause as the rest
// of plan 020 (see §1): a deterministic pass rewrote the source's own
// timeline instead of conserving it.
//
// The fix: when a step needs bumping, try to pay for the delta by shortening
// the step immediately AFTER it, so the total is conserved and every later
// landmark lands back where the source said it would.
//
// Why the FOLLOWING step pays. The step after the short one is the one whose
// START was pushed back by the expansion — it is the landmark actually
// being protected. Shortening it instead of, say, the preceding step keeps
// the short step's own elapsed_seconds (its start) untouched and repairs
// exactly the drift G22 was complaining about, in the step closest to the
// discrepancy.
//
// Why NOT cascade. A payer is only used when it can afford the delta AND
// remain at or above the minimum itself — never below. That is a structural
// guarantee, not just a check: if step i-1 successfully absorbed from step
// i, step i's post-payment duration is by construction >= the minimum, so
// when this same left-to-right pass reaches step i it will not need
// bumping and therefore will not go looking for a payer of its own. A
// shortfall never propagates past its immediate neighbour.
//
// Fallback when no payer is available (the short step is last, the
// following step isn't a brew step, or it cannot afford the delta without
// itself dropping below the minimum): bump to the minimum WITHOUT
// conservation, exactly as before this phase. That leaves the same drift
// and warning behaviour the gate has always had — strictly no worse than
// pre-D7, per plan 020 §3 D7.
//
// One accepted side effect (the trade-off the product decision was made
// with, not a bug): if the payer step itself carries duration_is_stated,
// shortening it means its OWN final duration_seconds no longer matches its
// own source-stated figure, which will surface as a new (non-blocking in
// extract mode) `stated_duration_changed` finding from verifyTimingProvenance
// for the payer. That is intentional — the alternative was leaving every
// LATER landmark wrong, which is strictly more findings, not fewer.
function enforceMinimumStepDurations(input: {
  steps: DraftStep[];
}): { steps: DraftStep[]; warnings: string[] } {
  const steps = input.steps;
  const durations = steps.map((step) => step.duration_seconds);

  let adjustedPreparation = false;
  let adjustedBrewAbsorbed = false;
  let adjustedBrewUnabsorbed = false;

  steps.forEach((step, index) => {
    if (step.kind === "preparation") {
      if (durations[index] !== 0) {
        adjustedPreparation = true;
        durations[index] = 0;
      }
      return;
    }

    if (durations[index] >= MIN_BREW_STEP_DURATION_SECONDS) {
      return;
    }

    const delta = MIN_BREW_STEP_DURATION_SECONDS - durations[index];
    const payerIndex = index + 1;
    const payer: DraftStep | undefined = steps[payerIndex];
    const canAbsorb = payer !== undefined &&
      payer.kind === "brew" &&
      durations[payerIndex] - delta >= MIN_BREW_STEP_DURATION_SECONDS;

    if (canAbsorb) {
      durations[index] = MIN_BREW_STEP_DURATION_SECONDS;
      durations[payerIndex] -= delta;
      adjustedBrewAbsorbed = true;
      return;
    }

    durations[index] = MIN_BREW_STEP_DURATION_SECONDS;
    adjustedBrewUnabsorbed = true;
  });

  const resultSteps = steps.map((step, index) =>
    durations[index] === step.duration_seconds
      ? step
      : { ...step, duration_seconds: durations[index] }
  );

  const warnings: string[] = [];
  if (adjustedPreparation) {
    warnings.push("Preparation step duration was normalized to 0 seconds.");
  }
  if (adjustedBrewAbsorbed) {
    warnings.push(
      `Brew step durations below ${MIN_BREW_STEP_DURATION_SECONDS} seconds were normalized to ${MIN_BREW_STEP_DURATION_SECONDS} seconds, shortening the following step by the same amount so the total brew time and later timings are unaffected.`,
    );
  }
  if (adjustedBrewUnabsorbed) {
    warnings.push(
      `Brew step durations below ${MIN_BREW_STEP_DURATION_SECONDS} seconds were normalized to ${MIN_BREW_STEP_DURATION_SECONDS} seconds.`,
    );
  }

  return {
    steps: resultSteps,
    warnings,
  };
}

function parseLeadingTimestampSeconds(text: string): number | null {
  const match = text.match(
    /^\s*(?:at\s*)?(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/i,
  );
  if (!match) {
    return null;
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] === undefined ? null : Number(match[3]);
  if (
    !Number.isFinite(first) || !Number.isFinite(second) ||
    (third !== null && !Number.isFinite(third))
  ) {
    return null;
  }

  return third === null
    ? first * 60 + second
    : first * 3600 + second * 60 + third;
}

const NUMBER_WORD_VALUES = new Map<string, number>([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);

function parseSmallNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeKeywordText(value).replace(/[^a-z0-9.]+/g, "");
  if (!normalized.length) {
    return null;
  }

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  return NUMBER_WORD_VALUES.get(normalized) ?? null;
}

function parseNaturalElapsedSeconds(text: string): number | null {
  const normalized = normalizeKeywordText(text);

  const minuteSecondMatch = normalized.match(
    /\b(?:at|after|in|around|about)\s+(?:(\d+(?:\.\d+)?)|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+minutes?\s+(?:and\s+)?(?:(\d+(?:\.\d+)?)|one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?\b/i,
  );
  if (minuteSecondMatch) {
    const minuteText = minuteSecondMatch[1] ??
      minuteSecondMatch[0].match(
        /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+minutes?\b/i,
      )?.[1];
    const secondText = minuteSecondMatch[2] ??
      minuteSecondMatch[0].match(
        /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?\b/i,
      )?.[1];
    const minutes = parseSmallNumber(minuteText);
    const seconds = parseSmallNumber(secondText);
    if (minutes !== null && seconds !== null) {
      return Math.round(minutes * 60 + seconds);
    }
  }

  const minuteMatch = normalized.match(
    /\b(?:at|after|in|around|about)\s+(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+minutes?\b/i,
  );
  if (minuteMatch) {
    const minutes = parseSmallNumber(minuteMatch[1]);
    if (minutes !== null) {
      return Math.round(minutes * 60);
    }
  }

  const secondMatch = normalized.match(
    /\b(?:at|after|in|around|about)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?\b/i,
  );
  if (secondMatch) {
    const seconds = parseSmallNumber(secondMatch[1]);
    if (seconds !== null) {
      return Math.round(seconds);
    }
  }

  return null;
}

const SMALL_NUMBER_SOURCE = String
  .raw`\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten`;

function parseDurationQuantitySeconds(
  amountText: string | undefined,
  unitText: string | undefined,
): number | null {
  const amount = parseSmallNumber(amountText);
  if (amount === null || !unitText) {
    return null;
  }

  return /^min/i.test(unitText) ? Math.round(amount * 60) : Math.round(amount);
}

function parseClockDurationSeconds(text: string): number | null {
  const match = text.match(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/);
  if (!match) {
    return null;
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] === undefined ? null : Number(match[3]);
  if (
    !Number.isFinite(first) || !Number.isFinite(second) ||
    (third !== null && !Number.isFinite(third))
  ) {
    return null;
  }

  return third === null
    ? first * 60 + second
    : first * 3600 + second * 60 + third;
}

// F28/F10-follow-up: ENGLISH-ONLY FALLBACK. This mines a total brew time
// out of narrowedText purely by matching English trigger words ("brew
// time", "done", "complete", "drawdown", ...). It is a deliberate,
// permanent limitation — do NOT try to internationalize these regexes by
// adding translated keyword lists; that path never ends (every language,
// every label variant, every phrasing). Semantic judgements like "is this
// sentence a stated total brew time" belong to the LLM extraction stage,
// which is multilingual by construction — see the extraction system
// prompt's total_brew_time_seconds guidance. This function only exists to
// catch cases where the extraction stage's own field came back null for
// an ENGLISH source; for non-English sources where extraction returns
// null, resolveTotalBrewTimeTargetSeconds below still calls this (it does
// no harm — it simply won't match anything in another language), but the
// caller is responsible for warning the operator that the fallback could
// not help. See the "non-English recipe with no extracted total brew
// time" warning built in finalizeDraftResponse.
function parseTotalBrewTimeTargetSeconds(text: string): number | null {
  const candidates: number[] = [];
  const sentences = normalizeKeywordText(text).split(/(?<=[.!?])\s+/);
  const rangePattern = new RegExp(
    String
      .raw`\b(${SMALL_NUMBER_SOURCE})\s*(?:-|–|—|\bto\b)\s*(${SMALL_NUMBER_SOURCE})\s+(minutes?|seconds?)\b`,
    "gi",
  );
  const singlePattern = new RegExp(
    String
      .raw`\b(?:brew(?:ing)?\s+times?|total\s+brew\s+time|finish(?:es|ed)?\s+brewing|done|complete)\b.{0,80}?\b(${SMALL_NUMBER_SOURCE})\s+(minutes?|seconds?)\b`,
    "gi",
  );

  for (const sentence of sentences) {
    if (
      !/\b(?:brew(?:ing)?\s+times?|total\s+brew\s+time|finish(?:es|ed)?\s+brewing|done|complete|draw\s*down|drawdown)\b/i
        .test(sentence)
    ) {
      continue;
    }

    for (
      const match of sentence.matchAll(/\b\d{1,2}:[0-5]\d(?::[0-5]\d)?\b/g)
    ) {
      const seconds = parseClockDurationSeconds(match[0]);
      if (seconds !== null && seconds > 0) {
        candidates.push(seconds);
      }
    }

    for (const match of sentence.matchAll(rangePattern)) {
      const seconds = parseDurationQuantitySeconds(match[1], match[3]);
      if (seconds !== null && seconds > 0) {
        candidates.push(seconds);
      }
    }

    for (const match of sentence.matchAll(singlePattern)) {
      const seconds = parseDurationQuantitySeconds(match[1], match[2]);
      if (seconds !== null && seconds > 0) {
        candidates.push(seconds);
      }
    }
  }

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function parseStepElapsedTimestampSeconds(text: string): number | null {
  return parseLeadingTimestampSeconds(text) ?? parseNaturalElapsedSeconds(text);
}

function startsTimerLikeStep(step: DraftStep): boolean {
  // Prefer the LLM-reported signal — it can recognize phrasings (e.g.
  // "start the timer") that the regex below, kept only as a fallback for
  // steps without the field, does not cover.
  if (step.starts_timer) {
    return true;
  }

  const normalized = normalizeKeywordText(
    `${step.description_source} ${step.description_template}`,
  );
  return /\bstart(?:ing)?\s+(?:your\s+)?timer\b/i.test(normalized) ||
    /\bbegin\s+(?:your\s+)?first\s+pour\b/i.test(normalized);
}

function isDrawdownLikeStep(step: DraftStep): boolean {
  // Phase C3 (F29): read the extraction-labelled role first. It identifies
  // what the step DOES independent of the language it's written in, so a
  // German "Vollständig durchlaufen lassen." (let it drain completely) is
  // recognized just as reliably as an English "let it draw down" — no
  // regex to internationalize. Only when the model left step_role null
  // (it's nullable/defaulted so omitting it can't fail the stage) do we
  // fall back to the regex below.
  if (step.step_role !== null) {
    return step.step_role === "drawdown";
  }

  // ENGLISH-ONLY FALLBACK, used only for steps without a step_role label.
  // Recognizes "draw down"/"drawdown" plus the inflected forms "drawing
  // down" and "draws down" (F28) — a recipe ending on "let it finish
  // drawing down" must match just as reliably as one ending on "let it
  // draw down". Do not internationalize this regex — see F29: that path
  // does not end. Label a step with step_role instead.
  const normalized = normalizeKeywordText(
    `${step.description_source} ${step.description_template}`,
  );
  return /\b(?:draw(?:s|ing)?\s*down|drawdown|drain|serve)\b/i.test(
    normalized,
  );
}

// F28/F10-follow-up: ENGLISH-ONLY FALLBACK, same rationale as
// parseTotalBrewTimeTargetSeconds above — do not internationalize this
// regex either. It only ever matches English completion phrasing
// ("finished", "done", "complete", "dripping", "draw down"/"drawdown").
function parseCompletionTargetSeconds(text: string): number | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const candidates = sentences
    .filter((sentence) =>
      /\b(?:finish(?:es|ed)?|done|complete|dripping|draw\s*down|drawdown)\b/i
        .test(normalizeKeywordText(sentence))
    )
    .map(parseNaturalElapsedSeconds)
    .filter((value): value is number => value !== null && value > 0);

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

// Single source of truth for "how long should this recipe's total brew
// take". Prefers the extraction stage's explicit total_brew_time_seconds
// (the LLM reads the whole transcript and is multilingual, so it can tell
// a stated brew time — in any language — from commentary); only falls
// back to mining it out of narrowedText — which is built solely from
// extraction.preparation and each step's raw_text, never the full raw
// transcript — when the extraction left it null. That regex fallback is
// ENGLISH-ONLY (see parseTotalBrewTimeTargetSeconds/
// parseCompletionTargetSeconds above), so for a non-English recipe whose
// extraction came back null, this simply returns null too — see the
// warning built in finalizeDraftResponse for surfacing that to the
// operator rather than silently producing minimal step durations.
function resolveTotalBrewTimeTargetSeconds(input: {
  extractionTotalBrewTimeSeconds: number | null;
  narrowedText: string;
}): number | null {
  if (input.extractionTotalBrewTimeSeconds !== null) {
    return input.extractionTotalBrewTimeSeconds;
  }

  const completionTarget = parseCompletionTargetSeconds(input.narrowedText);
  const totalBrewTarget = parseTotalBrewTimeTargetSeconds(input.narrowedText);
  const target = Math.max(completionTarget ?? 0, totalBrewTarget ?? 0);
  return target > 0 ? target : null;
}

// Phase B2 / defect-1 fix: a step's duration is ANCHORED — left completely
// alone by the split below — when the source can be trusted for it.
// Everything else is DERIVED, meaning no signal ties its duration to the
// source, so the value currently sitting on it is just whatever a
// particular model run guessed and must not survive into the final split.
//
// elapsed_seconds on its own is NOT such a signal: it is a begins-at
// timestamp ("at 1:30, pour to 180g" has elapsed_seconds 90), which says
// nothing about how long the step itself lasts. Treating "start time known"
// as "duration known" was the defect — a Hario Switch transcript where
// every brew step happens to carry a start timestamp (including the final
// drawdown) made every step look anchored, so derivedIndexes came back
// empty and the deterministic split bailed out entirely, leaving whatever
// inconsistent durations that model run guessed with no total enforced.
//
// The one place a duration genuinely CAN be read off two elapsed
// timestamps is by differencing them: step N's duration = step (N+1)'s
// elapsed minus step N's elapsed, which is exactly what
// normalizeAbsoluteTimestampDurations already computes for every
// timestamped step that has a successor. That is a real source-derived
// fact, on par with duration_is_stated, so those indices are anchored too.
// The LAST timestamped step has no successor to difference against — its
// duration is a nominal fallback guess (FINAL_TIMESTAMPED_STEP_DURATION_SECONDS),
// not a source fact — so it must NOT be anchored; it competes for the
// derived remainder like any other unstated step, which is precisely where
// a source-stated total should end up being enforced.
function isAnchoredBrewStep(
  step: DraftStep,
  index: number,
  timestampDifferencedIndexes: ReadonlySet<number>,
): boolean {
  return step.duration_is_stated === true ||
    timestampDifferencedIndexes.has(index) ||
    // Defensive guard: this parser never itself infers a duration above the
    // cap, so a duration that exceeds it cannot be one of our own guesses —
    // it must have come from the source (e.g. an 18-hour cold brew steep).
    step.duration_seconds > INFERRED_BREW_STEP_DURATION_CAP_SECONDS;
}

// A bloom's duration doesn't scale with how much water it adds — it's a
// fixed nominal number of seconds, not a rate.
const DERIVED_BLOOM_SECONDS = 45;
// A derived step that adds no water and isn't the drawdown (stir, swirl,
// serve) is a quick fixed action, not something that scales with volume.
const DERIVED_STIR_SECONDS = 15;
// Roughly how fast a controlled pour adds water. This is a seconds-per-gram
// ESTIMATE, not a weight/scalar — it must stay in the same units (seconds)
// as DERIVED_BLOOM_SECONDS and DERIVED_STIR_SECONDS so the three can be
// compared and summed directly, unlike the abstract weights this replaced.
const POUR_RATE_GRAMS_PER_SECOND = 8;

function findWaterExpressionValue(step: DraftStep): number | null {
  const waterExpression = step.expressions.find((expression) =>
    expression.placeholder === "<final_water_amount>" &&
    expression.preview_value !== null
  );
  return waterExpression?.preview_value ?? null;
}

function findCoffeeExpressionValue(step: DraftStep): number | null {
  const coffeeExpression = step.expressions.find((expression) =>
    expression.placeholder === "<final_coffee_amount>" &&
    expression.preview_value !== null
  );
  return coffeeExpression?.preview_value ?? null;
}

// F31: recipes routinely phrase a bloom or pour as a multiple of the
// coffee dose ("three times the dose, five times the dose, eight times
// the dose") rather than a fraction of the final water amount. For a step
// whose step_role marks it as one that adds water (bloom/pour), that
// dose-based expression's preview_value IS the cumulative water figure —
// just expressed relative to a different base — so it is a valid fallback
// when no <final_water_amount> expression is present. The water
// expression is still preferred when both are present: a pour step can
// carry both the dose expression (from an aside like "roughly 3x your
// dose on the way") and the water expression, and the water one is
// authoritative. For any other/null step_role, only the water expression
// counts — this preserves the fallback for models that omit step_role,
// and prevents a stir/serve step that happens to mention the dose from
// being counted as adding water.
function resolveBrewStepCumulativeWaterAmount(step: DraftStep): number | null {
  const waterValue = findWaterExpressionValue(step);
  if (waterValue !== null) {
    return waterValue;
  }
  if (step.step_role === "bloom" || step.step_role === "pour") {
    return findCoffeeExpressionValue(step);
  }
  return null;
}

// Water added by each brew step, seeded from any <final_water_amount> (or,
// per F31 above, dose-multiple <final_coffee_amount>) expression already
// sitting on the preparation step (folded pre-timer pours) — mirrors the
// running-total seed in convertWaterStepsToRunningTotals. By the time this
// runs, convertWaterStepsToRunningTotals has already made every water
// expression's preview_value a cumulative total, so the amount a given
// step itself adds is just that cumulative value minus the previous one.
// Non-brew steps and brew steps without a water signal return null (no
// water signal for that step).
function computeBrewStepWaterAddedAmounts(
  steps: DraftStep[],
): (number | null)[] {
  const preparationStep = steps[0];
  const preparationCumulativeWaterAmount = preparationStep?.kind ===
      "preparation"
    ? findWaterExpressionValue(preparationStep) ??
      findCoffeeExpressionValue(preparationStep)
    : null;
  let previousCumulative = preparationCumulativeWaterAmount ?? 0;

  return steps.map((step) => {
    if (step.kind !== "brew") {
      return null;
    }

    const cumulative = resolveBrewStepCumulativeWaterAmount(step);
    if (cumulative === null) {
      return null;
    }

    const added = Math.max(cumulative - previousCumulative, 0);
    previousCumulative = Math.max(previousCumulative, cumulative);
    return added;
  });
}

// Index of the last brew step in the array, or -1 when there is none.
// Deliberately avoids Array.prototype.findLastIndex for broad runtime
// compatibility.
function findLastBrewStepIndex(steps: DraftStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].kind === "brew") {
      return index;
    }
  }
  return -1;
}

function clampBrewStepDuration(value: number): number {
  return Math.min(
    Math.max(value, MIN_BREW_STEP_DURATION_SECONDS),
    INFERRED_BREW_STEP_DURATION_CAP_SECONDS,
  );
}

// Estimates a DERIVED, non-drawdown brew step's duration in SECONDS — never
// an abstract weight. A bloom is a fixed pause; a pour scales with how much
// water it itself adds at a plausible pour rate; anything else (stir,
// swirl, serve) is a quick fixed action. Because all three branches return
// seconds, they can be summed and compared directly.
function estimateDerivedStepSeconds(input: {
  isBloom: boolean;
  waterAddedGrams: number | null;
}): number {
  if (input.isBloom) {
    return DERIVED_BLOOM_SECONDS;
  }
  if (input.waterAddedGrams !== null && input.waterAddedGrams > 0) {
    return Math.max(
      MIN_BREW_STEP_DURATION_SECONDS,
      Math.ceil(input.waterAddedGrams / POUR_RATE_GRAMS_PER_SECOND),
    );
  }
  return DERIVED_STIR_SECONDS;
}

// Fallback only: spreads `available` seconds across `indexes` in proportion
// to `weights`, flooring every share but the last and giving the last
// whatever remains, then clamping each to [MIN, CAP]. Used only when the
// primary "drawdown absorbs the remainder" model below can't keep every
// derived step at or above the minimum.
function allocateAvailableSecondsByWeight(
  available: number,
  indexes: number[],
  weights: number[],
): Map<number, number> {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const allocation = new Map<number, number>();
  let allocated = 0;

  indexes.forEach((stepIndex, order) => {
    const isLast = order === indexes.length - 1;
    const rawShare = isLast
      ? available - allocated
      : Math.floor(available * (weights[order] / totalWeight));
    allocated += rawShare;
    allocation.set(stepIndex, clampBrewStepDuration(rawShare));
  });

  return allocation;
}

// Phase B2: replaces the old deficit-only redistribution. Phase B pinned
// the recipe *total* to a stated target, but left the *split* between brew
// steps at the mercy of whatever numbers a given model run happened to
// guess for the steps the source never actually timed — three identical
// transcripts could (and did, in production) come back with wildly
// different per-step splits while still summing to the same total. This
// pass makes the split itself deterministic: every step whose duration the
// source did not actually state (DERIVED) has its duration recomputed
// purely from the target total and the recipe's own water amounts/step
// roles — never from the model's guess for that step.
//
// The model is physical, not an abstract weighted split: a bloom is a
// fixed short pause, a pour takes roughly gramsAdded / pour-rate seconds,
// a quick action (stir/swirl/serve) is a fixed short duration, and the
// drawdown — which has no reliable estimate of its own — gets whatever
// time is left over after the others are accounted for. On a Chemex or
// V60 the drawdown is typically the *longest* derived step, not the
// shortest, which is why it absorbs the remainder instead of competing
// for a proportional share.
function splitDerivedBrewStepDurationsFromTarget(input: {
  steps: DraftStep[];
  narrowedText: string;
  extractionTotalBrewTimeSeconds: number | null;
  // Indices whose duration_seconds was computed by differencing two
  // genuinely known elapsed timestamps (see normalizeAbsoluteTimestampDurations
  // and the comment on isAnchoredBrewStep above) — as opposed to merely
  // carrying a non-null elapsed_seconds, which only records a start time.
  timestampDifferencedIndexes: ReadonlySet<number>;
}): { steps: DraftStep[]; warnings: string[] } {
  const targetSeconds = resolveTotalBrewTimeTargetSeconds({
    extractionTotalBrewTimeSeconds: input.extractionTotalBrewTimeSeconds,
    narrowedText: input.narrowedText,
  });
  if (targetSeconds === null || targetSeconds <= 0) {
    return { steps: input.steps, warnings: [] };
  }

  const brewSteps = input.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.kind === "brew");
  if (brewSteps.length === 0) {
    return { steps: input.steps, warnings: [] };
  }

  const waterAddedByIndex = computeBrewStepWaterAddedAmounts(input.steps);
  // Phase C3 (F29): prefer the step explicitly labelled "bloom" — it
  // identifies the bloom by what the step DOES, independent of language,
  // and independent of whether a scalable water expression even landed on
  // it. Only when no step carries that label do we fall back to the
  // pre-C3 heuristic: the first brew step that adds any water at all is
  // the bloom, whether or not it ends up anchored or derived.
  const roleBloomIndex = brewSteps.find(({ step }) =>
    step.step_role === "bloom"
  )?.index;
  const bloomIndex = roleBloomIndex ??
    (brewSteps.find(({ index }) => (waterAddedByIndex[index] ?? 0) > 0)
      ?.index ?? -1);

  let anchoredTotal = 0;
  const derivedIndexes: number[] = [];
  for (const { step, index } of brewSteps) {
    if (isAnchoredBrewStep(step, index, input.timestampDifferencedIndexes)) {
      anchoredTotal += step.duration_seconds;
    } else {
      derivedIndexes.push(index);
    }
  }

  const available = targetSeconds - anchoredTotal;
  if (
    derivedIndexes.length === 0 ||
    available < derivedIndexes.length * MIN_BREW_STEP_DURATION_SECONDS
  ) {
    // Either every brew step is already anchored (nothing to derive), or
    // the anchored steps alone already leave no room to fit the derived
    // ones above the minimum. Either way, manufacturing a split here would
    // do more harm than good — leave the model's own values in place.
    return { steps: input.steps, warnings: [] };
  }

  // The drawdown is whichever derived step reads as one; if none does,
  // treat the last derived step as the drawdown (recipes very often end on
  // an untimed "let it finish" beat even when the source never names it).
  //
  // Phase C3 (F29): isDrawdownLikeStep reads step_role === "drawdown"
  // before ever falling back to its English-only regex, so a step's
  // labelled role — not the language it happens to be written in —
  // decides whether it reads as one here.
  //
  // F28: a step that itself adds water can never be the drawdown — a
  // drawdown is by definition what happens after the last pour, so a POUR
  // step whose wording happens to also mention "drain"/"drawdown" (e.g.
  // "...avoid the filter walls, and let it drain almost completely") must
  // never be selected here, even if it matches the regex, or is even
  // mislabelled step_role "drawdown" by the model — a mislabel must not
  // resurrect that bug. And when more than one eligible (non-water) step
  // matches, the LAST one wins — recipes sometimes mention
  // drawdown-adjacent wording earlier (e.g. in a pour step's aside) before
  // the step that actually performs the drawdown.
  const matchedDrawdownIndex = derivedIndexes
    .filter((index) =>
      (waterAddedByIndex[index] ?? 0) <= 0 &&
      isDrawdownLikeStep(input.steps[index])
    )
    .at(-1);
  const fallbackDrawdownIndex = derivedIndexes.at(-1)!;
  // defect-1: the unconditional "last derived step" fallback above is only
  // physically sound when that step actually IS the recipe's last brew
  // step. Fixing isAnchoredBrewStep to stop treating a bare elapsed_seconds
  // as duration-known can leave the LAST TIMESTAMPED brew step derived
  // (its duration was never actually known — see
  // normalizeAbsoluteTimestampDurations) even when a LATER step — e.g. "let
  // it finish draining completely" — is already anchored and thus never
  // entered derivedIndexes at all. In that shape the fallback would land on
  // a mid-recipe pour that still adds water, with the recipe's true tail
  // sitting untouched after it; forcing an open-ended remainder onto that
  // pour is exactly the kind of unstated guess this split exists to
  // eliminate, just relocated. When the fallback step both adds water AND
  // is not the recipe's actual last brew step, there is no step here it
  // would be sound to dump the remainder into, so bail out entirely rather
  // than do that — this does not apply to matchedDrawdownIndex, which is
  // trusted regardless of position because it reads as a real drawdown (by
  // wording or step_role) rather than being picked by elimination.
  if (
    matchedDrawdownIndex === undefined &&
    (waterAddedByIndex[fallbackDrawdownIndex] ?? 0) > 0 &&
    fallbackDrawdownIndex !== brewSteps.at(-1)!.index
  ) {
    return { steps: input.steps, warnings: [] };
  }
  const drawdownIndex = matchedDrawdownIndex ?? fallbackDrawdownIndex;
  const otherDerivedIndexes = derivedIndexes.filter((index) =>
    index !== drawdownIndex
  );

  const otherEstimates = otherDerivedIndexes.map((index) =>
    clampBrewStepDuration(
      estimateDerivedStepSeconds({
        isBloom: index === bloomIndex,
        waterAddedGrams: waterAddedByIndex[index],
      }),
    )
  );
  const sumOtherEstimates = otherEstimates.reduce(
    (sum, estimate) => sum + estimate,
    0,
  );
  const drawdownRemainder = available - sumOtherEstimates;

  const finalDurations = new Map<number, number>();

  // D12 (plan 020 §3, following D10's precedent of not trusting an
  // end-marker as more than it actually states): "the drawdown absorbs the
  // remainder" above is a claim about PHYSICS — on a Chemex/V60 the
  // drawdown genuinely is the longest derived step because it is water
  // draining slowly through grounds, and that is still true even when a
  // drawdown's own elapsed_seconds happens to equal the resolved target
  // (see the four German V60 captures this must not regress — their
  // drawdowns keep absorbing the remainder correctly precisely because
  // their OTHER derived steps are grounded in real per-pour gram amounts).
  // It is also still true for an immersion brewer like the Hario Switch,
  // whose drawdown ("let it fully steep and drain until 1:25") legitimately
  // is the long step even though nothing in that recipe carries a per-step
  // water amount at all — see this function's own golden fixture, which
  // this must not regress either.
  //
  // What is NOT physically grounded is a drawdown that is BOTH (a) an
  // untrustworthy end-marker in exactly D10's sense — its own
  // elapsed_seconds equals the recipe's resolved completion target, i.e.
  // the source is stating WHEN the step happens, not how long it lasts —
  // AND (b) has no other derived step anywhere in the recipe carrying a
  // water-added signal to ground the "physical process" story in. A moka
  // pot's "remove from heat when steam appears, at approximately 4
  // minutes" satisfies both: "4 minutes" states the moment of removal
  // (not a duration), the step is an instantaneous action, and the recipe
  // never states how much water any individual brew step adds (only the
  // recipe-level total, consumed on the preparation step). Handing that
  // step the remainder is then not a physically-informed choice at all —
  // it is an artifact of which label the model attached.
  //
  // Confirmed against the actual failing capture (moka pot, plan 020's
  // c4637750): before this fix, [start timer]=15s, [lower heat]=15s,
  // [remove from heat/drawdown]=195s, [cool+serve]=15s against a 240s
  // target — 81% of the total on the one instantaneous step, while the
  // step immediately before it (the real long wait for coffee to start
  // flowing) sat at the 15s floor.
  //
  // Fix, gated on BOTH (a) and (b): invert which side gets the leftover.
  // The drawdown gets the same fixed, ungrounded nominal any other quick
  // action gets (DERIVED_STIR_SECONDS) — exactly what "remove from heat"
  // physically is — instead of the remainder, and `available` minus that
  // nominal is what actually gets distributed, across the OTHER derived
  // steps by their own weights (reusing allocateAvailableSecondsByWeight,
  // already this function's own established mechanism for "no better
  // basis than equal weight is available" — see the scale-down failure
  // branch below, which pools drawdown in at the same nominal weight for
  // the same reason). This does not claim to know the pre-drawdown wait is
  // longer than the extraction step that follows it — nothing in the draft
  // distinguishes them either — it only stops manufacturing false
  // precision by dumping the entire remainder onto a single step whose own
  // timestamp already tells us it is not a duration, putting the bulk of
  // the target back onto the steps that actually span the unmetered time
  // instead.
  const drawdownStep = input.steps[drawdownIndex];
  const drawdownIsUntrustworthyEndMarker = drawdownStep.step_role ===
      "drawdown" &&
    drawdownStep.elapsed_seconds === targetSeconds;
  const otherDerivedStepsHaveNoWaterSignal = otherDerivedIndexes.length >
      0 &&
    otherDerivedIndexes.every((index) => (waterAddedByIndex[index] ?? 0) <= 0);
  const drawdownRemainderIsUngrounded = drawdownIsUntrustworthyEndMarker &&
    otherDerivedStepsHaveNoWaterSignal;

  if (drawdownRemainderIsUngrounded) {
    const drawdownNominal = clampBrewStepDuration(DERIVED_STIR_SECONDS);
    finalDurations.set(drawdownIndex, drawdownNominal);
    const remainderForOthers = available - drawdownNominal;
    const allocation = allocateAvailableSecondsByWeight(
      remainderForOthers,
      otherDerivedIndexes,
      otherEstimates,
    );
    for (const [index, duration] of allocation) {
      finalDurations.set(index, duration);
    }
  } else if (drawdownRemainder >= MIN_BREW_STEP_DURATION_SECONDS) {
    // Common case: the estimates for everything else fit comfortably, so
    // the drawdown gets exactly what's left — the total lands on the
    // target exactly whenever that remainder is also within the cap.
    otherDerivedIndexes.forEach((index, order) => {
      finalDurations.set(index, otherEstimates[order]);
    });
    finalDurations.set(
      drawdownIndex,
      Math.min(drawdownRemainder, INFERRED_BREW_STEP_DURATION_CAP_SECONDS),
    );
  } else {
    // The non-drawdown estimates alone would leave the drawdown below the
    // minimum. Scale them down proportionally until the drawdown reaches
    // exactly the minimum, as long as doing so doesn't push any of them
    // below the minimum themselves.
    const targetOthersSum = available - MIN_BREW_STEP_DURATION_SECONDS;
    const scale = sumOtherEstimates > 0
      ? targetOthersSum / sumOtherEstimates
      : 0;
    const scaledFloors = otherEstimates.map((estimate) =>
      Math.floor(estimate * scale)
    );
    const everyScaledFitsMinimum = sumOtherEstimates > 0 &&
      scaledFloors.every((value) => value >= MIN_BREW_STEP_DURATION_SECONDS);

    if (everyScaledFitsMinimum) {
      let allocated = 0;
      otherDerivedIndexes.forEach((index, order) => {
        const isLastOther = order === otherDerivedIndexes.length - 1;
        // Remainder from the floor goes on the last non-drawdown step so
        // the scaled group still sums to exactly targetOthersSum, leaving
        // the drawdown at exactly the minimum.
        const value = isLastOther
          ? targetOthersSum - allocated
          : scaledFloors[order];
        allocated += value;
        finalDurations.set(index, clampBrewStepDuration(value));
      });
      finalDurations.set(drawdownIndex, MIN_BREW_STEP_DURATION_SECONDS);
    } else {
      // Even proportional scaling can't keep every derived step at or
      // above the minimum — fall back to spreading `available` across all
      // derived steps (drawdown included, using the same nominal weight as
      // a quick action) by their estimated weight instead.
      const fallbackWeights = derivedIndexes.map((index) => {
        if (index === drawdownIndex) {
          return DERIVED_STIR_SECONDS;
        }
        return otherEstimates[otherDerivedIndexes.indexOf(index)];
      });
      const fallbackAllocation = allocateAvailableSecondsByWeight(
        available,
        derivedIndexes,
        fallbackWeights,
      );
      for (const [index, duration] of fallbackAllocation) {
        finalDurations.set(index, duration);
      }
    }
  }

  const adjustedSteps = input.steps.map((step) => ({ ...step }));
  let changed = false;
  for (const [index, duration] of finalDurations) {
    if (duration !== adjustedSteps[index].duration_seconds) {
      changed = true;
    }
    adjustedSteps[index].duration_seconds = duration;
  }

  return {
    steps: changed ? adjustedSteps : input.steps,
    warnings: changed
      ? [
        "Derived brew step durations were split deterministically from the stated total brew time.",
      ]
      : [],
  };
}

// D10 (plan 020 §3, following 5cc31dc's "a known start time is not a known
// duration" precedent): a step's elapsed_seconds records when that step
// BEGAN. A drawdown step whose elapsed_seconds happens to equal the
// recipe's own resolved completion target cannot possibly be reporting its
// own begins-at time — a step that began exactly when the whole recipe
// ends would have zero duration left to occupy, which is incoherent. The
// far more plausible reading is that the model captured the source's
// END-of-brew marker ("done at 3:00") into elapsed_seconds instead of a
// genuine start timestamp for the drawdown itself.
//
// Live effect (German V60, four captures, source states 180s): the
// drawdown carried elapsed_seconds: 180, equal to the extracted total. The
// step immediately before it then differenced ITS duration against that
// bogus 180 "start", producing a real-looking but wrong anchored duration
// (e.g. 90s from a 90->180 diff). The anchored chain summed to exactly the
// 180s target, so splitDerivedBrewStepDurationsFromTarget's
// `available === 0` bail-out declined to touch anything else, and the
// derived steps' raw unreconciled guesses (a pour's guess plus the
// drawdown's own nominal guess) were left standing on top of the already-
// "complete" 180s total: 250s and 260s emitted against a stated 180s.
//
// This only disqualifies the marker as a DIFFERENCING PARTNER for the
// step immediately before it — not from `timestamped` altogether. The
// step keeps every other consequence of being the last timestamped step
// (the FINAL_TIMESTAMPED_STEP_DURATION_SECONDS nominal fallback for its
// own duration, lastTimestamped-based bookkeeping, elapsed_seconds
// canonicalization); only the false "predecessor's duration = this
// step's timestamp - predecessor's timestamp" read is suppressed.
//
// Steps 3 and 4 sharing an identical elapsed value (a landmark-resolution
// coincidence, not a stated zero-duration step — the same class of noise
// D7 gates on duration_is_stated for) are unaffected by this: that pairing
// is already excluded from anchoring by the pre-existing
// naturalDuration >= MIN_BREW_STEP_DURATION_SECONDS check, and neither of
// those steps is a drawdown, so this function never even considers them.
function isUntrustworthyDrawdownEndMarker(
  item: { index: number; timestampSeconds: number },
  steps: DraftStep[],
  completionTargetSeconds: number | null,
): boolean {
  return completionTargetSeconds !== null &&
    item.timestampSeconds === completionTargetSeconds &&
    steps[item.index].step_role === "drawdown";
}

function normalizeAbsoluteTimestampDurations(input: {
  steps: DraftStep[];
  narrowedText: string;
  extractionTotalBrewTimeSeconds: number | null;
  // F28: the already-resolved language signal (source hint, then
  // normalization/extraction detection) — gates whether a synthetic
  // English drawdown sentence may be appended below. See isEnglishLikeLanguage.
  detectedInputLanguage: string | null;
  // verify-user-recipe-draft's handler hard-502s the app the moment the
  // parser's step count diverges from the request's (see
  // verify-user-recipe-draft/handler.ts), and the synthetic drawdown append
  // below adds a step — so verify mode must skip only that append. The
  // duration/elapsed_seconds normalization above it changes values in
  // place, never the count, so it stays on for both modes.
  preserveStepCount: boolean;
}): {
  steps: DraftStep[];
  warnings: string[];
  timestampDifferencedIndexes: ReadonlySet<number>;
} {
  const detectedTimestamped = input.steps
    .map((step, index) => ({
      index,
      timestampSeconds: step.kind === "brew"
        ? step.elapsed_seconds ??
          parseStepElapsedTimestampSeconds(step.description_source) ??
          parseStepElapsedTimestampSeconds(step.description_template)
        : null,
    }))
    .filter((item): item is { index: number; timestampSeconds: number } =>
      item.timestampSeconds !== null
    );
  const firstBrewIndex = input.steps.findIndex((step) => step.kind === "brew");
  const timestamped = detectedTimestamped.length > 0 &&
      firstBrewIndex >= 0 &&
      firstBrewIndex < detectedTimestamped[0].index &&
      startsTimerLikeStep(input.steps[firstBrewIndex])
    ? [
      { index: firstBrewIndex, timestampSeconds: 0 },
      ...detectedTimestamped,
    ]
    : detectedTimestamped;

  if (timestamped.length < 2) {
    return {
      steps: input.steps,
      warnings: [],
      timestampDifferencedIndexes: new Set(),
    };
  }

  const isMonotonic = timestamped.every((item, index) =>
    index === 0 ||
    item.timestampSeconds >= timestamped[index - 1].timestampSeconds
  );
  if (!isMonotonic) {
    return {
      steps: input.steps,
      warnings: [],
      timestampDifferencedIndexes: new Set(),
    };
  }

  const lastTimestamped = timestamped.at(-1)!;
  let adjusted = false;
  const timestampByIndex = new Map(
    timestamped.map((item, index) => [item.index, { ...item, order: index }]),
  );
  const completionTargetSeconds = resolveTotalBrewTimeTargetSeconds({
    extractionTotalBrewTimeSeconds: input.extractionTotalBrewTimeSeconds,
    narrowedText: input.narrowedText,
  });

  // defect-1: indices whose duration was computed by differencing this
  // step's own timestamp against a KNOWN successor timestamp — a real
  // source-derived fact, unlike the last timestamped step (no successor),
  // whose duration below falls back to a nominal guess
  // (FINAL_TIMESTAMPED_STEP_DURATION_SECONDS) that must NOT be anchored.
  // See isAnchoredBrewStep for how this is consumed.
  const timestampDifferencedIndexes = new Set<number>();

  // D7 (plan 020 §3 D7, §4b decision): pass 1 computes each timestamped
  // step's NATURAL duration — the raw elapsed-timestamp diff against its
  // successor, or the nominal fallback for the last one — before any
  // minimum enforcement. This is the ground truth the old single-pass
  // version computed and then discarded the moment it came out below the
  // minimum, silently keeping whatever duration_seconds the model already
  // had (which is often already MIN_BREW_STEP_DURATION_SECONDS, because
  // providers are commonly prompted to enforce the same floor themselves —
  // that coincidence is exactly why the drift went unabsorbed: nothing in
  // this function ever saw a value below the minimum to react to).
  // D10: the reliable differencing partner for each timestamped step —
  // `timestamped[order + 1]`, UNLESS that candidate is itself an
  // untrustworthy drawdown end-marker (see isUntrustworthyDrawdownEndMarker
  // above), in which case this step is treated exactly like the genuinely
  // last timestamped step: no reliable successor to difference against.
  // Computed once and reused below so the differenced-marking check further
  // down can't disagree with the duration pass-1 actually used.
  //
  // NOTE (investigated and deliberately NOT narrowed further — see D10's
  // implementation report): an earlier version of this fix additionally
  // required the candidate to be this step's own immediate successor in
  // the full step sequence (`candidate.index === item.index + 1`), to
  // avoid touching a moka-pot capture whose "Start the timer" step
  // differenced against a same-shaped drawdown-equals-target marker two
  // steps later. That adjacency gate had to be reverted: two of the three
  // required German captures (51bc8f5d, 39cface0) have their OWN
  // intermediate pour steps carrying no elapsed_seconds at all, so their
  // drawdown-marker candidate is likewise non-adjacent in the full step
  // sequence — gating on adjacency silently left them unfixed (260s, still
  // blocked). The untrustworthiness of a drawdown's elapsed_seconds equal
  // to the stated total does not depend on how many un-timestamped steps
  // separate it from its differencing partner, so this now applies
  // unconditionally, matching the plan's own framing exactly.
  const reliableNextByOrder = new Map<
    number,
    { index: number; timestampSeconds: number } | undefined
  >();
  timestamped.forEach((item, order) => {
    const candidate = timestamped[order + 1];
    reliableNextByOrder.set(
      order,
      candidate &&
        !isUntrustworthyDrawdownEndMarker(
          candidate,
          input.steps,
          completionTargetSeconds,
        )
        ? candidate
        : undefined,
    );
  });

  const naturalDurationsByIndex = new Map<number, number>();
  timestamped.forEach((item, order) => {
    const nextTimestamp = reliableNextByOrder.get(order);
    const duration = nextTimestamp
      ? nextTimestamp.timestampSeconds - item.timestampSeconds
      : FINAL_TIMESTAMPED_STEP_DURATION_SECONDS;
    naturalDurationsByIndex.set(item.index, duration);
  });

  // Pass 2: enforce the minimum against the natural durations, absorbing
  // the delta from the immediately FOLLOWING timestamped step when
  // possible — that step is the one whose own elapsed start this step's
  // expansion would otherwise push back, so paying there is what keeps
  // every later stated landmark on the timeline the source actually gave.
  //
  // Gated to steps carrying duration_is_stated === true: a natural
  // duration below the minimum can also come from two source landmarks
  // that legitimately resolve to the very same elapsed second (e.g. "at
  // 1:35 put the pitcher on; at 1:40 flip the brewer" collapsed into one
  // step anchored at 1:40, diffed against "press from 1:40" landing on
  // exactly 0) — that is landmark-resolution noise, not a stated
  // sub-minimum duration, and forcing an absorption there would shorten an
  // unrelated neighbour to fix something that was never really 5 seconds
  // in the first place. Only a step the model itself marked as carrying a
  // real stated duration is D7's case; anything else keeps its prior
  // pass-through behaviour untouched (handled below via the >= MIN guard,
  // same as before this phase).
  const finalDurationsByIndex = new Map(naturalDurationsByIndex);
  let absorbedShortfall = false;
  let unabsorbedShortfall = false;
  timestamped.forEach((item, order) => {
    const current = finalDurationsByIndex.get(item.index)!;
    if (current >= MIN_BREW_STEP_DURATION_SECONDS) {
      return;
    }
    if (!input.steps[item.index].duration_is_stated) {
      return;
    }

    const delta = MIN_BREW_STEP_DURATION_SECONDS - current;
    const payer = timestamped[order + 1];
    const canAbsorb = payer !== undefined &&
      finalDurationsByIndex.get(payer.index)! - delta >=
        MIN_BREW_STEP_DURATION_SECONDS;

    if (canAbsorb) {
      finalDurationsByIndex.set(item.index, MIN_BREW_STEP_DURATION_SECONDS);
      finalDurationsByIndex.set(
        payer.index,
        finalDurationsByIndex.get(payer.index)! - delta,
      );
      absorbedShortfall = true;
    } else {
      // No eligible payer — the step is last, the next step isn't
      // timestamped, or it can't afford the delta without itself dropping
      // below the minimum. Bump to the minimum without conservation,
      // exactly as the pre-D7 pass-through behaviour left it (which, for a
      // provider that already self-normalizes, is a no-op here). Strictly
      // no worse than before this phase.
      finalDurationsByIndex.set(item.index, MIN_BREW_STEP_DURATION_SECONDS);
      unabsorbedShortfall = true;
    }
  });

  const steps = input.steps.map((step, index) => {
    const timestamp = timestampByIndex.get(index);
    if (timestamp) {
      // D10: must agree with the reliableNextByOrder used to compute
      // naturalDurationsByIndex above — otherwise a step whose "natural"
      // duration fell back to the nominal FINAL_TIMESTAMPED_STEP_DURATION_SECONDS
      // (because its candidate successor was an untrustworthy drawdown end-
      // marker) would still pass `naturalDuration >= MIN_BREW_STEP_DURATION_SECONDS`
      // here — the nominal fallback and the minimum are the same constant —
      // and get wrongly marked as genuinely timestamp-differenced anyway.
      const nextTimestamp = reliableNextByOrder.get(timestamp.order);
      const naturalDuration = naturalDurationsByIndex.get(index)!;

      if (
        nextTimestamp && naturalDuration >= MIN_BREW_STEP_DURATION_SECONDS
      ) {
        timestampDifferencedIndexes.add(index);
      }

      const duration = finalDurationsByIndex.get(index)!;

      // Canonicalize elapsed_seconds to the resolved timestamp (which may
      // have come from regex text parsing, not just the field itself) so
      // later passes — namely the deterministic brew-step split — can tell
      // this step's duration came from timestamp differencing and must not
      // be re-derived from anything else.
      if (
        duration >= MIN_BREW_STEP_DURATION_SECONDS &&
        step.duration_seconds !== duration
      ) {
        adjusted = true;
        return {
          ...step,
          duration_seconds: duration,
          elapsed_seconds: timestamp.timestampSeconds,
        };
      }

      return { ...step, elapsed_seconds: timestamp.timestampSeconds };
    }

    if (
      index > lastTimestamped.index &&
      step.kind === "brew" &&
      isDrawdownLikeStep(step) &&
      step.duration_seconds > DRAWDOWN_STEP_DURATION_SECONDS
    ) {
      adjusted = true;
      return {
        ...step,
        duration_seconds: DRAWDOWN_STEP_DURATION_SECONDS,
      };
    }

    return step;
  });

  const normalizedLastTimestamped = steps[lastTimestamped.index];
  const finalTimestampedEndsAt = lastTimestamped.timestampSeconds +
    normalizedLastTimestamped.duration_seconds;
  const hasDrawdownStep = steps.some((step, index) =>
    index > lastTimestamped.index && step.kind === "brew" &&
    isDrawdownLikeStep(step)
  );
  // Phase C3 (F29): a step can be explicitly labelled step_role
  // "drawdown" without being positioned after lastTimestamped.index — for
  // example when the drawdown step itself carries the final elapsed
  // timestamp. hasDrawdownStep above only scans steps positionally after
  // the timestamped run, so it can miss that case; this scans every step,
  // regardless of position or language, and must independently suppress
  // the synthetic append below.
  const hasRoleDrawdownStep = steps.some((step) =>
    step.step_role === "drawdown"
  );
  // F28: the recipe's actual last brew step — regardless of how it's
  // worded — is already functioning as the tail once it adds no more
  // water (nothing is poured after it), so there is nothing left to
  // synthesize even when its wording doesn't happen to match
  // isDrawdownLikeStep.
  const lastBrewStepIndex = findLastBrewStepIndex(steps);
  const lastBrewStepAddsNoWater = lastBrewStepIndex === -1
    ? false
    : (computeBrewStepWaterAddedAmounts(steps)[lastBrewStepIndex] ?? 0) <= 0;
  // F28: only ever append an English sentence when the recipe itself is
  // English-like. Losing a synthesized drawdown step is far better than
  // injecting a foreign-language recipe with one English sentence — a
  // German (or any non-English) recipe that already ends on its own
  // "let it drain completely" style step must never gain a bolted-on
  // English step.
  const isEnglishLikeRecipe = isEnglishLikeLanguage(
    input.detectedInputLanguage,
  );
  if (
    completionTargetSeconds !== null &&
    completionTargetSeconds >
      finalTimestampedEndsAt + MIN_BREW_STEP_DURATION_SECONDS &&
    !hasDrawdownStep &&
    !hasRoleDrawdownStep &&
    !lastBrewStepAddsNoWater &&
    isEnglishLikeRecipe &&
    !input.preserveStepCount
  ) {
    adjusted = true;
    steps.push({
      step_order: steps.length + 1,
      kind: "brew",
      description_source: "manual",
      description_template: "Wait for the complete drawdown.",
      preview_text: "Wait for the complete drawdown.",
      duration_seconds: completionTargetSeconds - finalTimestampedEndsAt,
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: "drawdown",
      expressions: [],
    });
  }

  const warnings: string[] = [];
  if (adjusted) {
    warnings.push("Elapsed-time brew steps were converted to step durations.");
  }
  if (absorbedShortfall) {
    warnings.push(
      `A brew step's source-stated duration was below ${MIN_BREW_STEP_DURATION_SECONDS} seconds; it was normalized to ${MIN_BREW_STEP_DURATION_SECONDS} seconds by shortening the following step by the same amount, so the total brew time and later elapsed landmarks are unaffected.`,
    );
  }
  if (unabsorbedShortfall) {
    warnings.push(
      `A brew step's source-stated duration was below ${MIN_BREW_STEP_DURATION_SECONDS} seconds and was normalized to ${MIN_BREW_STEP_DURATION_SECONDS} seconds; no adjacent step could absorb the difference, so later elapsed landmarks may be shifted by it.`,
    );
  }

  return {
    steps,
    warnings,
    timestampDifferencedIndexes,
  };
}

function applyExtractionFallbacks(args: {
  normalized: NormalizedDraft;
  extraction: ExtractionResult;
}): NormalizedDraft {
  return {
    ...args.normalized,
    recipe: {
      ...args.normalized.recipe,
      coffee_amount: args.normalized.recipe.coffee_amount ??
        args.extraction.coffee_amount_grams,
      water_amount: args.normalized.recipe.water_amount ??
        args.extraction.water_amount,
      water_temp: args.normalized.recipe.water_temp ??
        args.extraction.water_temp_celsius,
    },
    localization: {
      ...args.normalized.localization,
      name: args.normalized.localization.name ?? args.extraction.name,
      grind_size: args.normalized.localization.grind_size ??
        args.extraction.grind_size,
      short_description: args.normalized.localization.short_description ??
        args.extraction.short_description,
    },
    // G22: normalization/repair fully replace the working NormalizedDraft
    // with their own LLM output (unlike the cumulative_rewrite merge,
    // which only overwrites `steps`/`warnings`), so a provider that
    // forgets to re-emit extracted_amounts would otherwise silently drop
    // it here even though extraction captured it correctly. Prefer
    // whatever normalization/repair carried forward; fall back to
    // extraction's own copy only when that came back empty. `?? []` also
    // covers a caller that bypasses zod's `.default([])` entirely (every
    // test-provider stub in this repo does).
    extracted_amounts: (args.normalized.extracted_amounts ?? []).length > 0
      ? args.normalized.extracted_amounts
      : (args.extraction.extracted_amounts ?? []),
  };
}

// INFERABLE fields may reasonably be derived by the repair model from the
// brewing method or general context. They drive whether the repair stage
// runs at all, and whether a repair attempt is considered successful.
function getMissingRequiredRepairFields(args: {
  normalized: NormalizedDraft;
  extraction: ExtractionResult;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): string[] {
  const normalizedWithFallbacks = applyExtractionFallbacks({
    normalized: args.normalized,
    extraction: args.extraction,
  });

  const missingFields: string[] = [];

  if (!normalizedWithFallbacks.localization.name) {
    missingFields.push("localization.name");
  }
  if (!normalizedWithFallbacks.localization.grind_size) {
    missingFields.push("localization.grind_size");
  }
  if (!normalizedWithFallbacks.localization.short_description) {
    missingFields.push("localization.short_description");
  }
  if (!normalizedWithFallbacks.recipe.water_temp) {
    missingFields.push("recipe.water_temp");
  }

  return missingFields;
}

// SOURCE-ONLY fields must come from the source text. The repair model must
// never invent these, so they never trigger or gate the repair stage. They
// are only used to surface human-readable warnings when they end up null.
function getMissingSourceOnlyFields(args: {
  normalized: NormalizedDraft;
  extraction: ExtractionResult;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): string[] {
  const normalizedWithFallbacks = applyExtractionFallbacks({
    normalized: args.normalized,
    extraction: args.extraction,
  });
  const resolvedBrewingMethod = resolveBrewingMethodId({
    brewingMethods: args.brewingMethods,
    brewingMethodHint: args.brewingMethodHint,
    normalizedBrewingMethodId: normalizedWithFallbacks.recipe.brewing_method_id,
    extractedLikelyBrewingMethod: args.extraction.likely_brewing_method,
  });

  const missingFields: string[] = [];

  if (!normalizedWithFallbacks.recipe.coffee_amount) {
    missingFields.push("recipe.coffee_amount");
  }
  if (!normalizedWithFallbacks.recipe.water_amount) {
    missingFields.push("recipe.water_amount");
  }
  if (!resolvedBrewingMethod.brewingMethodId) {
    missingFields.push("recipe.brewing_method_id");
  }

  return missingFields;
}

const SOURCE_ONLY_FIELD_WARNINGS: Record<string, string> = {
  "recipe.coffee_amount":
    "Coffee amount is not stated in the source and was left empty.",
  "recipe.water_amount":
    "Water amount is not stated in the source and was left empty.",
  "recipe.brewing_method_id":
    "Brewing method could not be confidently determined from the source and was left empty.",
};

function getMalformedStepTemplateRepairFields(
  normalized: NormalizedDraft,
): string[] {
  const malformedFields: string[] = [];

  normalized.steps.forEach((step, index) => {
    if (
      collectMalformedSupportedPlaceholders(step.description_template).length &&
      hasInvalidExpressionSyntax(step.description_source)
    ) {
      malformedFields.push(`steps[${index}].description_template`);
    }
  });

  return malformedFields;
}

function shouldAttemptCumulativeRewritePass(args: {
  sourceLanguageHint?: string;
  detectedInputLanguage: string | null;
  draftSteps: DraftStep[];
}): boolean {
  const languageSignal = getPrimaryLanguageSignal([
    args.sourceLanguageHint,
    args.detectedInputLanguage,
  ]);
  if (!languageSignal || isEnglishLikeLanguage(languageSignal)) {
    return false;
  }

  const normalizedStepText = normalizeKeywordText(
    args.draftSteps.map((step) => step.description_template).join(" "),
  ).replace(/<[^>]+>/g, " ");
  const englishHintCount =
    ENGLISH_STEP_HINTS.filter((hint) =>
      new RegExp(`\\b${escapeRegExp(hint)}\\b`, "i").test(normalizedStepText)
    ).length;
  if (englishHintCount >= 2) {
    return false;
  }

  const waterBrewStepCount =
    args.draftSteps.filter((step) =>
      step.kind === "brew" &&
      step.expressions.some((expression) =>
        expression.placeholder === "<final_water_amount>"
      )
    ).length;

  return waterBrewStepCount >= 2;
}

function validateCumulativeRewriteSteps(args: {
  original: NormalizedDraft["steps"];
  rewritten: NormalizedDraft["steps"];
}): string | null {
  if (args.original.length !== args.rewritten.length) {
    return "cumulative rewrite changed step count";
  }

  for (let index = 0; index < args.original.length; index += 1) {
    const originalStep = args.original[index];
    const rewrittenStep = args.rewritten[index];

    if (originalStep.kind !== rewrittenStep.kind) {
      return `cumulative rewrite changed kind for step ${index}`;
    }

    if (originalStep.duration_seconds !== rewrittenStep.duration_seconds) {
      return `cumulative rewrite changed duration for step ${index}`;
    }

    if (originalStep.description_source !== rewrittenStep.description_source) {
      return `cumulative rewrite changed description_source for step ${index}`;
    }

    if (originalStep.elapsed_seconds !== rewrittenStep.elapsed_seconds) {
      return `cumulative rewrite changed elapsed_seconds for step ${index}`;
    }

    if (originalStep.starts_timer !== rewrittenStep.starts_timer) {
      return `cumulative rewrite changed starts_timer for step ${index}`;
    }

    if (originalStep.duration_is_stated !== rewrittenStep.duration_is_stated) {
      return `cumulative rewrite changed duration_is_stated for step ${index}`;
    }

    if (originalStep.step_role !== rewrittenStep.step_role) {
      return `cumulative rewrite changed step_role for step ${index}`;
    }
  }

  return null;
}

function validateRewrittenStepTemplates(
  steps: NormalizedDraft["steps"],
): string | null {
  for (let index = 0; index < steps.length; index += 1) {
    const template = steps[index].description_template;
    if (FORBIDDEN_TIME_PLACEHOLDER_REGEX.test(template)) {
      return `cumulative rewrite introduced time placeholders in step ${index}`;
    }

    if (collectUnsupportedPlaceholders(template).length > 0) {
      return `cumulative rewrite introduced unsupported placeholders in step ${index}`;
    }

    if (collectMalformedSupportedPlaceholders(template).length > 0) {
      return `cumulative rewrite introduced malformed scalable expressions in step ${index}`;
    }
  }

  return null;
}

// Fix 1 (Aug 2026 live pass): the cumulative_rewrite stage is explicitly
// licensed (via cumulativeHint/its own system prompt) to turn an additive
// pour into cumulative wording — that conversion is correct and by design
// whenever the RESULT is a single figure the recipe already states
// somewhere (the common case this pass exists for: "pour another 100g"
// becomes "pour up to 200g" when the source's own later steps already say
// 200g). What is NOT safe is recomputing a RANGE: a German V60 capture
// (627c64a7) had a bloom of 25g followed by "gieße nun weitere 50-70g" (an
// ADDITIVE range on top of the bloom). The cumulative_rewrite stage turned
// this into "auf insgesamt 75-95g" (a cumulative RANGE), i.e. it computed
// 25+50=75 and 25+70=95 itself. Neither 75 nor 95 appears anywhere in the
// source text, and there is no mechanism anywhere in this pipeline for
// synthesizing a matching extracted_amounts record for a value the LLM
// invented via its own arithmetic on two separate literal facts — so G22
// correctly, and permanently, reports both figures as unverifiable no
// matter how many times this is retried.
//
// A single-value cumulative rewrite doesn't have this problem because it
// almost always lands on a figure that itself already has a literal
// extracted_amounts record elsewhere in the recipe (the recipe's own later
// "pour to 300g" language). A two-endpoint RANGE has no such anchor: both
// endpoints are new arithmetic, not a restatement of an existing fact. The
// fix is therefore narrow and mechanical: if cumulative_rewrite changed the
// computed values of a step that had TWO OR MORE expressions for the same
// placeholder (a range) before the rewrite, that step's rewrite is
// rejected and its ORIGINAL (pre-rewrite, already correctly traceable)
// description_template is kept instead — every other step's legitimate
// rewrite is left untouched.
function revertUntraceableRangeCumulativeRewrites(args: {
  // The draft as rendered from `normalized.steps` BEFORE cumulative_rewrite
  // ran — i.e. provisionalDraftSteps, whose .expressions already carry the
  // correct, source-traceable preview values for every range.
  original: DraftStep[];
  // What the cumulative_rewrite stage returned.
  rewritten: NormalizedDraft["steps"];
  coffeeAmount: number | null;
  waterAmount: number | null;
}): { steps: NormalizedDraft["steps"]; warnings: string[] } {
  const warnings: string[] = [];
  const placeholders = [
    "<final_coffee_amount>",
    "<final_water_amount>",
  ] as const;

  const steps = args.rewritten.map((rewrittenStep, index) => {
    const originalStep = args.original[index];
    if (!originalStep) {
      return rewrittenStep;
    }

    for (const placeholder of placeholders) {
      const originalValues = originalStep.expressions
        .filter((expression) => expression.placeholder === placeholder)
        .map((expression) => expression.preview_value);

      // Only a RANGE (two or more expressions for the same placeholder in
      // one step) is in scope — a single-value cumulative rewrite is the
      // legitimate, by-design case this guard must not touch.
      if (originalValues.length < 2) {
        continue;
      }

      const rewrittenValues = extractExpressions(
        rewrittenStep.description_template,
        args.coffeeAmount,
        args.waterAmount,
      )
        .filter((expression) => expression.placeholder === placeholder)
        .map((expression) => expression.preview_value);

      const unchanged = originalValues.length === rewrittenValues.length &&
        originalValues.every((value, position) => {
          const rewrittenValue = rewrittenValues[position];
          return value !== null && rewrittenValue !== null &&
            Math.abs(value - rewrittenValue) < 0.01;
        });

      if (unchanged) {
        continue;
      }

      warnings.push(
        `Cumulative rewrite recomputed step ${
          index + 1
        }'s ${
          placeholder === "<final_water_amount>" ? "water" : "coffee"
        } amount range into new figures that do not trace to the source; the original wording was kept instead.`,
      );
      return {
        ...rewrittenStep,
        description_template: originalStep.description_template,
      };
    }

    return rewrittenStep;
  });

  return { steps, warnings };
}

// Exact id, exact name, normalized-exact id, or normalized-exact name
// matches (120/110/100/95) are always accepted.
//
// Containment matches are asymmetric, not a flat score floor:
//   - ACCEPT when the CANDIDATE contains the method token, e.g. candidate
//     "Kalita Wave pour over" contains method id "kalita". The candidate is
//     a more specific label for a supported method — a legitimate
//     specialization.
//   - REJECT when the METHOD contains the candidate, e.g. method name
//     "Wilfa Svart Pour Over" contains candidate "pour over". The candidate
//     is a generic fragment and the method is a specific (often branded)
//     device — guessing here routinely picks the wrong method (the "wilfa"
//     bug).
// A minimum method-token length guards against a very short id/name
// matching almost anything as a substring.
const CANDIDATE_CONTAINS_ID_SCORE = 85;
const CANDIDATE_CONTAINS_NAME_SCORE = 82;
const METHOD_CONTAINS_ID_SCORE = 40;
const METHOD_CONTAINS_NAME_SCORE = 35;
const MIN_BREWING_METHOD_TOKEN_LENGTH = 3;

// The acceptance threshold sits between the two containment directions:
// accept-direction tiers (82/85) pass, reject-direction tiers (35/40) and
// non-matches (-1) do not.
const HIGH_CONFIDENCE_BREWING_METHOD_SCORE = CANDIDATE_CONTAINS_NAME_SCORE;

function scoreBrewingMethodCandidate(args: {
  candidate: string;
  method: BrewingMethodOption;
}): number {
  const candidateRaw = args.candidate.trim();
  const candidateNormalized = normalizeBrewingMethodToken(candidateRaw);
  const methodId = args.method.brewing_method_id.trim();
  const methodName = args.method.brewing_method.trim();
  const methodIdNormalized = normalizeBrewingMethodToken(methodId);
  const methodNameNormalized = normalizeBrewingMethodToken(methodName);

  if (candidateRaw === methodId) {
    return 120;
  }

  if (candidateRaw === methodName) {
    return 110;
  }

  if (candidateNormalized === methodIdNormalized) {
    return 100;
  }

  if (candidateNormalized === methodNameNormalized) {
    return 95;
  }

  if (
    candidateNormalized.length > 0 &&
    methodIdNormalized.length >= MIN_BREWING_METHOD_TOKEN_LENGTH
  ) {
    if (candidateNormalized.includes(methodIdNormalized)) {
      return CANDIDATE_CONTAINS_ID_SCORE;
    }
    if (methodIdNormalized.includes(candidateNormalized)) {
      return METHOD_CONTAINS_ID_SCORE;
    }
  }

  if (
    candidateNormalized.length > 0 &&
    methodNameNormalized.length >= MIN_BREWING_METHOD_TOKEN_LENGTH
  ) {
    if (candidateNormalized.includes(methodNameNormalized)) {
      return CANDIDATE_CONTAINS_NAME_SCORE;
    }
    if (methodNameNormalized.includes(candidateNormalized)) {
      return METHOD_CONTAINS_NAME_SCORE;
    }
  }

  return -1;
}

function resolveBrewingMethodId(args: {
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
  normalizedBrewingMethodId: string | null;
  extractedLikelyBrewingMethod: string | null;
}): {
  brewingMethodId: string | null;
  warnings: string[];
} {
  if (args.brewingMethodHint) {
    return {
      brewingMethodId: args.brewingMethodHint,
      warnings: [],
    };
  }

  const extractedLikelyBrewingMethod =
    args.extractedLikelyBrewingMethod?.trim() ?? "";

  if (extractedLikelyBrewingMethod.length > 0) {
    const extractionMatchesAnySupportedMethod = args.brewingMethods.some(
      (method) =>
        scoreBrewingMethodCandidate({
          candidate: extractedLikelyBrewingMethod,
          method,
        }) >= HIGH_CONFIDENCE_BREWING_METHOD_SCORE,
    );

    if (!extractionMatchesAnySupportedMethod) {
      // The extraction stage identified a real brewing method mention from
      // the source text, and it does not match any supported method. Any
      // brewing_method_id the normalization stage produced in this case is
      // a guess (or a self-contradiction — the model can simultaneously
      // emit a warning that the method is unsupported and still return a
      // matching id), not a reading of the source, so don't trust it.
      return {
        brewingMethodId: null,
        warnings: [
          `Brewing method '${extractedLikelyBrewingMethod}' is not among the supported methods and was left unset.`,
        ],
      };
    }
  }

  const candidates = uniqueStrings([
    args.normalizedBrewingMethodId ?? "",
    args.extractedLikelyBrewingMethod ?? "",
  ]).filter((candidate) => candidate.length > 0);

  for (const candidate of candidates) {
    const scoredMatches = args.brewingMethods
      .map((method) => ({
        method,
        score: scoreBrewingMethodCandidate({
          candidate,
          method,
        }),
      }))
      .filter((match) => match.score >= HIGH_CONFIDENCE_BREWING_METHOD_SCORE)
      .sort((left, right) => right.score - left.score);

    if (scoredMatches.length === 0) {
      continue;
    }

    const [bestMatch] = scoredMatches;
    const competingMatches = scoredMatches.filter((match) =>
      match.method.brewing_method_id !== bestMatch.method.brewing_method_id &&
      match.score === bestMatch.score
    );

    if (competingMatches.length > 0) {
      continue;
    }

    const warnings = candidate === bestMatch.method.brewing_method_id ? [] : [
      `Brewing method '${candidate}' was normalized to supported id '${bestMatch.method.brewing_method_id}'.`,
    ];

    return {
      brewingMethodId: bestMatch.method.brewing_method_id,
      warnings,
    };
  }

  return {
    brewingMethodId: null,
    warnings: candidates.length > 0
      ? [
        `Brewing method '${
          candidates[0]
        }' is not among the supported methods and was left unset.`,
      ]
      : [],
  };
}

function validateDraft(input: {
  draftSteps: DraftStep[];
  normalized: NormalizedDraft;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): {
  issues: ValidationIssue[];
  warnings: string[];
} {
  const issues: ValidationIssue[] = [];
  const warnings = [...input.normalized.warnings];
  const methodIds = new Set(
    input.brewingMethods.map((method) => method.brewing_method_id),
  );

  if (!input.normalized.localization.name) {
    issues.push({
      code: "missing_name",
      field: "localization.name",
      message: "Recipe name is required to publish a user recipe.",
    });
  }

  if (!input.normalized.localization.grind_size) {
    issues.push({
      code: "missing_grind_size",
      field: "localization.grind_size",
      message: "Grind size is required to publish a user recipe.",
    });
  }

  if (!input.normalized.localization.short_description) {
    issues.push({
      code: "missing_short_description",
      field: "localization.short_description",
      message: "Short description is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.coffee_amount) {
    issues.push({
      code: "missing_coffee_amount",
      field: "recipe.coffee_amount",
      message: "Coffee amount is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.water_amount) {
    issues.push({
      code: "missing_water_amount",
      field: "recipe.water_amount",
      message: "Water amount is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.water_temp) {
    issues.push({
      code: "missing_water_temp",
      field: "recipe.water_temp",
      message: "Water temperature is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.brewing_method_id) {
    issues.push({
      code: "missing_brewing_method",
      field: "recipe.brewing_method_id",
      message: "Brewing method could not be resolved confidently.",
    });
  } else if (!methodIds.has(input.normalized.recipe.brewing_method_id)) {
    issues.push({
      code: "invalid_brewing_method",
      field: "recipe.brewing_method_id",
      message:
        "Brewing method id is not part of the current supported methods.",
    });
  }

  if (
    !input.brewingMethodHint &&
    input.normalized.recipe.brewing_method_id &&
    input.normalized.recipe.brewing_method_confidence !== "high"
  ) {
    warnings.push(
      `Brewing method inference confidence is ${input.normalized.recipe.brewing_method_confidence}. Review before publishing.`,
    );
  }

  if (input.draftSteps.length === 0) {
    issues.push({
      code: "missing_steps",
      field: "steps",
      message: "At least one preparation step and one brew step are required.",
    });
    return {
      issues,
      warnings: uniqueStrings(warnings),
    };
  }

  const firstStep = input.draftSteps[0];
  if (firstStep.kind !== "preparation") {
    issues.push({
      code: "invalid_preparation_step",
      field: "steps[0].kind",
      message: "The first step must be the untimed preparation step.",
    });
  }

  if (firstStep.duration_seconds !== 0) {
    issues.push({
      code: "invalid_preparation_time",
      field: "steps[0].duration_seconds",
      message: "Preparation step duration must be 0 seconds.",
    });
  }

  const brewSteps = input.draftSteps.filter((step) => step.kind === "brew");
  if (brewSteps.length === 0) {
    issues.push({
      code: "missing_brew_steps",
      field: "steps",
      message: "At least one timed brew step is required.",
    });
  }

  input.draftSteps.forEach((step, index) => {
    if (index > 0 && step.kind !== "brew") {
      issues.push({
        code: "invalid_step_kind",
        field: `steps[${index}].kind`,
        message: "Only the first step may be a preparation step.",
      });
    }

    if (
      step.kind === "brew" &&
      step.duration_seconds < MIN_BREW_STEP_DURATION_SECONDS
    ) {
      issues.push({
        code: "invalid_step_duration",
        field: `steps[${index}].duration_seconds`,
        message:
          `All brew steps must have a concrete duration of at least ${MIN_BREW_STEP_DURATION_SECONDS} seconds.`,
      });
    }

    if (FORBIDDEN_TIME_PLACEHOLDER_REGEX.test(step.description_template)) {
      issues.push({
        code: "forbidden_time_placeholder",
        field: `steps[${index}].description_template`,
        message: "User recipes must not contain <tN> timer placeholders.",
      });
    }

    const unsupportedPlaceholders = collectUnsupportedPlaceholders(
      step.description_template,
    );
    if (unsupportedPlaceholders.length > 0) {
      issues.push({
        code: "unsupported_placeholder",
        field: `steps[${index}].description_template`,
        message: `Unsupported placeholders found: ${
          unsupportedPlaceholders.join(", ")
        }`,
      });
    }

    const malformedSupportedPlaceholders =
      collectMalformedSupportedPlaceholders(
        step.description_template,
      );
    if (malformedSupportedPlaceholders.length > 0) {
      issues.push({
        code: "invalid_scalable_expression",
        field: `steps[${index}].description_template`,
        message:
          `Supported quantity placeholders must use a numeric multiplier expression like (0.2 x <final_water_amount>)g. Malformed placeholders found: ${
            malformedSupportedPlaceholders.join(", ")
          }`,
      });
    }

    if (
      malformedSupportedPlaceholders.length === 0 &&
      (hasDanglingExpressionMultiplier(step.description_template) ||
        !hasBalancedParentheses(step.description_template))
    ) {
      issues.push({
        code: "invalid_scalable_expression",
        field: `steps[${index}].description_template`,
        message:
          "Step description contains incomplete scalable expression syntax.",
      });
    }
  });

  return {
    issues,
    warnings: uniqueStrings(warnings),
  };
}

function buildPublishProjection(input: {
  userId: string;
  normalized: NormalizedDraft;
  draftSteps: DraftStep[];
  brewTimeSeconds: number;
  nowMs: number;
}): PublishProjection {
  const recipeId = `usr-${input.userId}-${input.nowMs}`;
  const lastModified = new Date(input.nowMs).toISOString();

  return {
    user_recipe: {
      id: recipeId,
      brewing_method_id: input.normalized.recipe.brewing_method_id!,
      coffee_amount: input.normalized.recipe.coffee_amount!,
      water_amount: input.normalized.recipe.water_amount!,
      water_temp: input.normalized.recipe.water_temp!,
      brew_time: input.brewTimeSeconds,
      vendor_id: `usr-${input.userId}`,
      last_modified: lastModified,
      import_id: null,
      is_imported: false,
      ispublic: false,
      is_deleted: false,
      needs_moderation_review: false,
    },
    user_recipe_localization: {
      id: crypto.randomUUID(),
      recipe_id: recipeId,
      locale: "en",
      name: input.normalized.localization.name!,
      grind_size: input.normalized.localization.grind_size!,
      short_description: input.normalized.localization.short_description!,
    },
    user_steps: input.draftSteps.map((step) => ({
      id: crypto.randomUUID(),
      recipe_id: recipeId,
      step_order: step.step_order,
      description: step.description_template,
      time: String(step.duration_seconds),
      locale: "en" as const,
    })),
  };
}

// Text the deterministic duration-normalization passes are allowed to mine
// timing numbers out of: only what the extraction stage itself identified
// as recipe content (the preparation blurb and each step's raw text) —
// never the full raw transcript, which is mostly commentary that regexes
// have historically mismined as brew-time statements.
function buildNarrowedSourceText(extraction: ExtractionResult): string {
  return [
    extraction.preparation,
    ...extraction.steps.map((step) => step.raw_text),
  ]
    .filter((part): part is string => Boolean(part && part.trim().length))
    .join(" ");
}

// G22: builds the RenderedAmount[] verifyAmountProvenance checks against,
// from the FINAL draft steps — i.e. this must run after every LLM and
// deterministic transform, so it sees exactly what the user would actually
// be shown, including cumulative rewriting and the duration split.
//
// Two sources of amounts, per step:
//  1. Scalable expressions — step.expressions already carries a computed
//     preview_value for each one (see extractExpressions). This is the
//     amount the user will actually see once <final_coffee_amount>/
//     <final_water_amount> are substituted in.
//  2. Literal numeric amounts left in the template — a fixed number the
//     model chose not to (or could not) convert into a scalable
//     expression. Found with the same NUMERIC_SCALABLE_AMOUNT_REGEX used
//     elsewhere for scalable-amount matching, after stripping out
//     expressions first so an expression's own multiplier (e.g. the "1" in
//     "(1 x <final_coffee_amount>)g") is never double-counted as a second,
//     unrelated literal amount.
//
// is_cumulative_water is only ever true for a <final_water_amount>
// expression in a step whose wording reads as cumulative
// (usesCumulativeWaterLanguage) — never for a literal leftover number,
// which by definition is not what the deterministic cumulative-rewrite
// pass touches.
function buildRenderedAmountsFromDraftSteps(
  draftSteps: DraftStep[],
): RenderedAmount[] {
  const rendered: RenderedAmount[] = [];

  draftSteps.forEach((step, stepIndex) => {
    const isCumulativeStep = usesCumulativeWaterLanguage(
      step.description_template,
    );

    for (const expression of step.expressions) {
      if (expression.preview_value === null) {
        continue;
      }
      if (
        matchesStructuredRateAmount(
          step.rate_amounts ?? [],
          expression.preview_value,
          expression.unit,
        )
      ) {
        continue;
      }
      rendered.push({
        step_index: stepIndex,
        value: expression.preview_value,
        unit: normalizeExpressionUnit(expression.unit),
        is_cumulative_water: isCumulativeStep &&
          expression.placeholder === "<final_water_amount>",
      });
    }

    const withoutExpressions = step.description_template.replaceAll(
      cloneRegex(EXPRESSION_REGEX),
      " ",
    );
    for (
      const match of withoutExpressions.matchAll(
        cloneRegex(NUMERIC_SCALABLE_AMOUNT_REGEX),
      )
    ) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) {
        continue;
      }
      const unit = normalizeExpressionUnit(match[2] ?? "");
      const tail = withoutExpressions.slice(
        (match.index ?? 0) + match[0].length,
        (match.index ?? 0) + match[0].length + 24,
      );
      if (
        matchesStructuredRateAmount(step.rate_amounts ?? [], value, unit) ||
        RATE_CONTEXT_REGEX.test(tail)
      ) {
        // Structured rate metadata is the multilingual mechanism. The regex
        // is retained only so captures/providers predating rate_amounts do not
        // regress (including the stored English Kalita E4 capture).
        continue;
      }
      rendered.push({
        step_index: stepIndex,
        value,
        unit,
        is_cumulative_water: false,
      });
    }
  });

  return rendered;
}

// G22 — timing landmark enforcement.
//
// Landmarks are captured from the draft steps AS THEY STAND RIGHT AFTER
// fold (foldPreTimerStepsIntoPreparation) — i.e. after the one pass that
// can change step count/order, but BEFORE every pass that can recompute
// duration_seconds/elapsed_seconds (convertWaterStepsToRunningTotals never
// touches timing, but normalizeAbsoluteTimestampDurations,
// splitDerivedBrewStepDurationsFromTarget, and enforceMinimumStepDurations
// all can). That makes this snapshot exactly "what the source stated,
// before this parser's own heuristics had a chance to rewrite it" — the
// same role extracted_amounts plays for verifyAmountProvenance, just
// without needing a bespoke top-level field, since duration_is_stated and
// elapsed_seconds already are that record.
//
// step_index here is guaranteed to line up 1:1 with the FINAL draftSteps
// array's own indices: fold only ever REMOVES pre-timer preparation-kind
// steps (before the first step that starts the timer), never brew-kind
// steps, and every pass between this snapshot and the final draft either
// mutates a step's fields in place or appends exactly one synthetic
// drawdown step at the very end (extract mode only) — neither reorders or
// removes anything this snapshot already captured. A landmark whose step
// was itself folded away (necessarily a pre-timer, not a source-stated
// brew landmark) simply finds nothing to compare against in
// verifyTimingProvenance and is silently skipped, which is the correct
// outcome: it is not part of the brew timeline being checked.
function buildTimingLandmarksFromFoldedSteps(
  foldedSteps: DraftStep[],
): TimingLandmark[] {
  const landmarks: TimingLandmark[] = [];

  foldedSteps.forEach((step, stepIndex) => {
    if (step.duration_is_stated) {
      landmarks.push({
        step_index: stepIndex,
        kind: "duration",
        seconds: step.duration_seconds,
      });
    }
    if (step.elapsed_seconds !== null) {
      landmarks.push({
        step_index: stepIndex,
        kind: "elapsed",
        seconds: step.elapsed_seconds,
      });
    }
  });

  return landmarks;
}

function buildRenderedTimingStepsFromDraftSteps(
  draftSteps: DraftStep[],
): RenderedTimingStep[] {
  return draftSteps.map((step, stepIndex) => ({
    step_index: stepIndex,
    kind: step.kind,
    duration_seconds: step.duration_seconds,
  }));
}

// D5 (plan 016 §4 Phase 3b, diagnosis D5): a proportional tolerance for
// deciding whether a `total_brew_time_mismatch` finding from
// verifyTimingProvenance (provenance.ts, "The source states a total brew
// time of Ns, but the final brew steps sum to Ms.") is severe enough to
// block EXTRACT-mode publication. verify mode already blocks on every
// timing finding unconditionally via `preserveStepCount` and is untouched
// by this — see the comment above the `preserveStepCount` usage further
// down for why that split exists.
//
// An absolute-seconds threshold cannot separate the two controls this was
// built against: the cold_brew fixture's deterministic split lands at
// 65100s against a stated 66600s (1500s off, ~2.3%) and must stay a
// warning, while the live Russian defect emitted 40s against a stated 180s
// (140s off, but a 4.5x contraction) and must block. Neither an absolute
// floor nor a fixed-seconds ceiling can pass the first and block the
// second — a floor loose enough to admit 1500s admits 140s too, and a
// ceiling tight enough to catch 140s catches 1500s too. A RATIO is the
// right shape for the same reason it was originally chosen.
//
// D6 (plan 020 §3, retuning the original factor-of-2 pick): the factor-of-2
// threshold was set from two data points and left most of a decade of
// headroom unused. Live captures since (plan 020 §3 D6 table) gave five:
//
//   case            stated    emitted   ratio    verdict
//   cold brew       64,800s   64,820s   1.0003   must pass  (live capture)
//   cold_brew fixture 66,600s 65,100s   1.023    must pass  (golden, deterministic split)
//   French press 4  480s      510s      1.06     defect, chosen to block
//   moka pot 1      240s      270s      1.125    must block (defect, low-variance draw)
//   moka pot 2-4    240s      490s      2.04     must block (defect, high-variance draw)
//   Russian         180s      40s       4.5      must block
//
// The two known-good points cluster at 1.0003-1.023; the moka-pot defect's
// OWN distribution spans 1.125-2.04 across four identical-input runs, so the
// 1.125 draw is the *low end* of a single defect's variance, not a fixed
// boundary — a future capture of the same contradiction could plausibly land
// lower still (e.g. 260s/240s = 1.083) and must not slip through. A
// threshold at 1.10 would clear the one 1.125 draw we captured by only 2.3%,
// with no margin against that lower variance. 1.05 keeps ~2.7 percentage
// points of clearance above the tightest known-good case (the 1.023 golden)
// while covering the moka-pot distribution's plausible low end, and it
// resolves French press's 1.06 deliberately rather than by omission: 30s
// over an explicitly stated 480s total is proportionally smaller than the
// moka-pot defect but is still a real contradiction of a stated figure, and
// this check's job is exactly that class of contradiction, not only the
// large ones. 1.05 is close to the natural gap in the data (1.023 known-good
// vs 1.06 first defect) and does not carve out an exception for short brews.
const TOTAL_BREW_TIME_BLOCKING_RATIO = 1.05;

// E1 (plan 023): a source that explicitly hedges its total is not making the
// same precision claim as a flatly stated target. The live Hario Switch source
// says "until about 1:25"; deterministic minimum-duration normalization adds a
// final 10-second serve step and emits 95s (ratio 1.118). A 15% window admits
// that physically consistent result with modest headroom. It is intentionally
// unavailable to exact totals, so the moka-pot control (240s stated, 270s
// emitted, ratio 1.125) continues to block under the 1.05 exact-total gate.
const APPROXIMATE_TOTAL_BREW_TIME_BLOCKING_RATIO = 1.15;

function isTotalBrewTimeMismatchSevere(
  statedSeconds: number,
  emittedSeconds: number,
  statedTotalIsApproximate = false,
): boolean {
  if (statedSeconds <= 0 || emittedSeconds <= 0) {
    // Defensive only, not expected on live traffic: extraction's schema
    // already requires total_brew_time_seconds to be a positive integer
    // when present (see extractionSchema above), and an emitted total of
    // zero brew seconds is a different, already-covered failure (no brew
    // steps meet MIN_BREW_STEP_DURATION_SECONDS, so brewTimeSeconds is
    // null and publish_projection is withheld below regardless of this
    // check). Treat "cannot form a meaningful ratio" as non-severe rather
    // than dividing by zero.
    return false;
  }
  const ratio = emittedSeconds >= statedSeconds
    ? emittedSeconds / statedSeconds
    : statedSeconds / emittedSeconds;
  return ratio >=
    (statedTotalIsApproximate
      ? APPROXIMATE_TOTAL_BREW_TIME_BLOCKING_RATIO
      : TOTAL_BREW_TIME_BLOCKING_RATIO);
}

type TotalBrewTimeStatedRange = NonNullable<
  ExtractionResult["total_brew_time_stated_range"]
>;

function resolveTotalBrewTimeStatedRange(
  range: TotalBrewTimeStatedRange | null,
): { low: number; high: number } | null {
  if (
    !range || !Number.isFinite(range.low) || !Number.isFinite(range.high) ||
    range.low <= 0 || range.high <= 0
  ) {
    return null;
  }
  return {
    low: Math.min(range.low, range.high),
    high: Math.max(range.low, range.high),
  };
}

function isTotalBrewTimeInsideStatedRange(
  emittedSeconds: number,
  range: { low: number; high: number },
): boolean {
  return emittedSeconds >= range.low && emittedSeconds <= range.high;
}

// F32: mirrors provenance.ts's AmountProvenance shape, taken from the
// normalized draft's own carried-through field rather than re-imported,
// since that's the exact array this repair pass reads.
type AmountProvenanceRecord = NormalizedDraft["extracted_amounts"][number];

// D4 (plan 016 §4 Phase 3a, diagnosis D4): the G22 amount check above
// (verifyAmountProvenance, called from finalizeDraftResponse below) only
// ever verifies that an EMITTED amount traces back to a recorded value —
// it has no opinion on a value that WAS recorded (a range_endpoint record,
// rule_inputs { low, high, endpoint }) but whose other endpoint never got
// emitted anywhere in the draft at all. That is exactly the Chemex/Spanish
// defect: a stated "60-90 g" bloom collapsed to a single rendered "60 g",
// silently losing the source's high endpoint, while G22 stayed green
// because the low endpoint DID trace correctly to a matching record. This
// check closes that gap: for every range_endpoint record with a genuine
// low/high spread, the endpoint NOT selected must still appear somewhere
// in the final draft (any step — a recipe may state the range once but
// the draft can legitimately show its two endpoints in different places),
// or the draft is not publishable.
//
// Scoped to coffee/water amounts by construction, not by an extra unit
// filter here: extracted_amounts only ever carries coffee/water records
// (see AMOUNT_PROVENANCE_PROMPT_RULES above — "Every numeric coffee or
// water amount ... must also get a matching record in extracted_amounts").
// total_brew_time_seconds is a separate top-level field that is never
// represented in extracted_amounts, so the deliberate total-time-range-to-
// midpoint conversion (see the extraction prompt rule above, "midpoint
// rounded to the nearest 5 seconds") can never trip this check — there is
// no total-time extracted_amounts record for it to inspect in the first
// place.
const RANGE_ENDPOINT_MATCH_TOLERANCE = 0.5;

// g/ml are treated as interchangeable, mirroring the same water-density
// assumption provenance.ts's own unit comparison already makes for the
// exact same reason (g and ml are used interchangeably for water in coffee
// recipes). This is a narrow, two-value equivalence for this one check —
// not a re-implementation of D1's Arabic/Persian unit lexicon, which is
// out of scope here and owned by provenance.ts.
function normalizeUnitForRangeCheck(unit: string): string {
  const normalized = normalizeExpressionUnit(unit).trim().toLowerCase();
  if (normalized === "g" || normalized === "ml") {
    return "mass_or_volume";
  }
  return normalized;
}

// C2 (plan 016 §3 D4′, §4 Task C): resolves, for a single provenance
// record, whether the source stated a genuine two-sided range for this
// amount and — if so — which value is the "other" endpoint that must
// still appear somewhere in the draft. Two independent sources feed this,
// tried in order:
//
// 1. The range_endpoint rule's own rule_inputs { low, high, endpoint } —
//    the original D4 detection surface. Reliable when the model chose
//    this rule, but Chemex-shaped captures show it is NOT reliably chosen
//    even when the source states a genuine range.
// 2. stated_range { low, high } — prompted for independently of which
//    rule (if any) the record ends up under, specifically so a LITERAL
//    record whose source stated a range still carries both endpoints.
//    Because stated_range has no explicit endpoint selector (unlike
//    rule_inputs.endpoint), the "other" value is inferred by matching
//    record.value against whichever of low/high it's closest to — if it
//    matches neither within tolerance, the record is left unchecked
//    rather than guessed at.
//
// Both can independently disagree or be partially missing (schema-old
// captures, model omission); this function tries rule_inputs first and
// only falls back to stated_range when rule_inputs didn't resolve —
// avoiding a double-count when both happen to describe the same range.
function resolveRangeEndpointTrigger(
  record: AmountProvenanceRecord,
): { low: number; high: number; otherValue: number } | null {
  if (record.rule === "range_endpoint" && record.rule_inputs) {
    const { low, high, endpoint } = record.rule_inputs;
    if (
      typeof low === "number" && typeof high === "number" && low !== high
    ) {
      // Only a low- or high-endpoint selection has a single, unambiguous
      // "other" value to look for. A midpoint selection (0.5) is never
      // instructed for coffee/water amounts (only total_brew_time_seconds
      // gets the midpoint treatment, and that field is never represented
      // in extracted_amounts at all — see the header comment above) —
      // left unchecked rather than guessed at.
      if (endpoint === 0) return { low, high, otherValue: high };
      if (endpoint === 1) return { low, high, otherValue: low };
    }
  }

  const statedRange = record.stated_range;
  if (
    statedRange && typeof statedRange.low === "number" &&
    typeof statedRange.high === "number" && statedRange.low !== statedRange.high
  ) {
    const { low, high } = statedRange;
    if (Math.abs(record.value - low) <= RANGE_ENDPOINT_MATCH_TOLERANCE) {
      return { low, high, otherValue: high };
    }
    if (Math.abs(record.value - high) <= RANGE_ENDPOINT_MATCH_TOLERANCE) {
      return { low, high, otherValue: low };
    }
    // record.value matches neither stated endpoint — ambiguous (e.g. a
    // midpoint-like value, or a data inconsistency between value and
    // stated_range); left unchecked rather than guessed at.
  }

  return null;
}

// D3 (plan 020 §3 D3, §1 root cause): step_index -1 is an LLM-authored
// sentinel — normalization is free to re-emit it as 0 on any given run
// (see the class header comment on findRangeEndpointCollapseIssues below),
// and CONFIRMED production data shows it does, about half the time, on
// byte-identical extraction. Four French-press captures with an identical
// raw record (`value 60, stated_range {60,70}, step_index: -1`) split
// 2 published / 2 falsely blocked purely on what normalization happened to
// re-emit for step_index. Trusting the sentinel alone is therefore not a
// safe oracle for "is this a recipe-level scalar."
//
// This function derives the same judgement from data the model does not
// get to rewrite after the fact: does the record's own value equal this
// draft's own final recipe.coffee_amount or recipe.water_amount? Those two
// fields are single numbers by schema (see the class header comment below)
// — verified against the French-press captures, whose collapsed dose
// record (value 60) equals recipe.coffee_amount (60) in all four runs,
// including the two whose step_index had already been corrupted to 0. The
// German round-3 capture that must stay blocked (D1's territory — a
// genuine step-level pour collapse) has a collapsed record of value 50
// against coffee_amount 20 / water_amount 300: neither matches, so this
// function does not exempt it.
//
// Deliberate decision (plan 020 §3 D3's second trap): a STEP-level record
// (step_index >= 0) whose value equals recipe.water_amount is exempted by
// this same rule, not just a record at the recipe level. Rationale: the
// physical quantity a value-matching record names — the recipe's OWN final
// coffee dose or final water total — has exactly one legitimate number in
// this schema regardless of which step happens to restate it (e.g. a final
// cumulative pour phrased as "top up to 300g" when water_amount is already
// 300). Collapsing a stated range for that quantity to the single final
// value is the same "not representable, so collapsing is correct" case
// plan 016 already settled for the recipe-level sentinel, extended to
// wherever the recipe's own final target is restated. This does trade away
// a narrow slice of coverage — a genuinely different step-level amount that
// happens to numerically equal the final coffee/water target by
// coincidence would also be exempted — but the coincidence is unlikely
// (confirmed absent from every capture inspected: German's real step-level
// collapse is 50 against 20/300, not a coincidental match) and the
// alternative (never exempting a step-level match) would re-introduce a
// false block for the legitimate "restated final total" case with no way
// to tell the two apart from this record's shape alone.
//
// unit_kind gates which comparison applies, permissively: a "volume"-kind
// record can equal water_amount (grams/millilitres are treated as
// interchangeable for water elsewhere in this file and in provenance.ts's
// own unit lexicon) but never coffee_amount (coffee is never expressed in
// volume in this schema). A "mass"-kind or absent unit_kind record may
// match either. This is a permissive gate, not a strict requirement, so an
// old-shape record predating unit_kind (unit_kind absent) is unaffected.
function isRecipeLevelScalarValue(
  record: AmountProvenanceRecord,
  recipeCoffeeAmount: number | null,
  recipeWaterAmount: number | null,
): boolean {
  const allowsCoffeeComparison = record.unit_kind !== "volume";
  const allowsWaterComparison = record.unit_kind !== "time" &&
    record.unit_kind !== "percent";

  if (
    allowsCoffeeComparison &&
    recipeCoffeeAmount !== null &&
    Math.abs(record.value - recipeCoffeeAmount) <=
      RANGE_ENDPOINT_MATCH_TOLERANCE
  ) {
    return true;
  }
  if (
    allowsWaterComparison &&
    recipeWaterAmount !== null &&
    Math.abs(record.value - recipeWaterAmount) <=
      RANGE_ENDPOINT_MATCH_TOLERANCE
  ) {
    return true;
  }
  return false;
}

// Phase D (plan 020 §3 D1, §4b): shared by findRangeEndpointCollapseIssues
// (below) and expandCollapsedStatedRangeEndpoints (further down) — both need
// the identical answer to "does this endpoint value already appear
// somewhere in the rendered draft", and keeping one implementation means
// the detector and the backstop that tries to fix what it detects can never
// quietly disagree about what counts as preserved. Pulled out unchanged
// from the pre-existing check `findRangeEndpointCollapseIssues` had inline
// before this phase — same tolerance, same empty-unit carve-out, no
// behaviour change for the detector.
function isRangeEndpointValuePreserved(
  renderedAmounts: RenderedAmount[],
  value: number,
  unit: string,
): boolean {
  const targetUnit = normalizeUnitForRangeCheck(unit);
  return renderedAmounts.some((rendered) => {
    if (Math.abs(rendered.value - value) > RANGE_ENDPOINT_MATCH_TOLERANCE) {
      return false;
    }

    const renderedUnit = normalizeUnitForRangeCheck(rendered.unit);
    if (renderedUnit === "") {
      // B2 (plan 016 §3 D4′/D1-empty-unit, §4 Task B): a hyphenated
      // range like "60-90g" renders through EXPRESSION_REGEX as two
      // adjacent expressions sharing one trailing unit suffix — by
      // design (see the EXPRESSION_REGEX comment further up; its
      // allowlist anchoring is what fixed the Japanese "mlまで注ぐ。"
      // corruption and must not be changed) — so the FIRST expression's
      // rendered unit is legitimately "". This function only ever sees
      // coffee/water records (see the header comment above:
      // extracted_amounts is scoped to coffee/water by construction), so
      // there is no other unit family a blank-unit rendered value here
      // could belong to. Comparing on value alone when the rendered unit
      // is empty is therefore a deliberate, narrow choice — not a
      // guess — and it closes the same empty-unit gap D1 diagnosed in
      // provenance.ts, for this local check, without reimplementing
      // provenance.ts's general unit-compatibility lexicon (out of scope
      // here, owned by provenance.ts's Phase 1a).
      return true;
    }

    return renderedUnit === targetUnit;
  });
}

function findRangeEndpointCollapseIssues(
  provenance: AmountProvenanceRecord[],
  renderedAmounts: RenderedAmount[],
  recipeCoffeeAmount: number | null,
  recipeWaterAmount: number | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const record of provenance) {
    // B1 (plan 016 §3 D4′, §4 Task B), hardened by D3 (plan 020 §3 D3): a
    // recipe-level scalar (e.g. coffee_amount, water_amount) is a single
    // number by schema — "brew 20-24g" is not representable, so collapsing
    // it to one endpoint is the CORRECT outcome, not a defect. Two
    // independent signals feed this judgement, and either is sufficient:
    //
    // 1. record.step_index < 0 — the LLM-authored recipe-level sentinel.
    //    Kept as CORROBORATION only (plan 020 §1's framing), not the sole
    //    oracle: normalization is free to re-emit this as 0 on any given
    //    run (CONFIRMED — see isRecipeLevelScalarValue's header comment),
    //    so trusting it alone reproduces D3's ~50% false-block rate.
    // 2. isRecipeLevelScalarValue — a deterministic check against data the
    //    model does not get to rewrite after extraction: does this
    //    record's value equal the FINAL draft's own recipe.coffee_amount
    //    or recipe.water_amount. This is what actually fixes D3, and it
    //    does not depend on step_index surviving normalization intact.
    if (
      record.step_index < 0 ||
      isRecipeLevelScalarValue(record, recipeCoffeeAmount, recipeWaterAmount)
    ) {
      continue;
    }

    const trigger = resolveRangeEndpointTrigger(record);
    if (trigger === null) {
      continue;
    }
    const { low, high, otherValue } = trigger;

    const preserved = isRangeEndpointValuePreserved(
      renderedAmounts,
      otherValue,
      record.unit,
    );

    if (!preserved) {
      issues.push({
        code: "range_endpoint_collapsed",
        field: record.step_index >= 0
          ? `steps[${record.step_index}].description_template`
          : "extraction.range_endpoint",
        message:
          `The source states a range of ${low}-${high}${record.unit}, ` +
          `but the final draft only shows ${record.value}${record.unit} — ` +
          `the other endpoint (${otherValue}${record.unit}) does not ` +
          `appear anywhere in the draft.`,
      });
    }
  }

  return issues;
}

// ===========================================================================
// Phase D (plan 020 §3 D1, §4b) — deterministic both-endpoint backstop.
// ===========================================================================
// CONFIRMED by diffing real captures across two deployed versions of this
// file (see the task brief this phase was executed from): v47, BEFORE
// stated_range existed, recorded a German step-level "50-70g" bloom as TWO
// literal extracted_amounts records and rendered both endpoints —
// "(0.166667 x <final_water_amount>)-(0.233333 x <final_water_amount>)g".
// v48, AFTER stated_range was added specifically to let a collapsed range be
// DETECTED (see the stated_range schema comment and
// findRangeEndpointCollapseIssues above), recorded the SAME source text as
// ONE literal record (value 50) plus stated_range {50,70} — and the
// rendering collapsed to match: "(0.166667 x <final_water_amount>)g" alone.
// Given a metadata slot for the range, the model stopped emitting a second
// per-endpoint record, and the renderer — which only ever renders what
// extraction/normalization/repair chose to emit — had nothing left to
// render for the high end. findRangeEndpointCollapseIssues correctly
// detects this (that is what it was built for); this backstop's job is to
// make the correct rendering happen in the first place, deterministically,
// from the SAME record the detector already reads, so the detector has
// nothing left to fire on in the cases this can fix.
//
// Scoping is a hard requirement, not a suggestion (task brief: "if you
// reconstruct both endpoints for a French-press dose, you have broken Phase
// C"): a recipe-level scalar (coffee_amount / water_amount, or their
// step-level restatement) is a single number by schema — "brew 60-70g" is
// not representable as a range there, and reconstructing both endpoints
// would be introducing a defect, not fixing one. This reuses Phase C's
// isRecipeLevelScalarValue (and the step_index < 0 sentinel as
// corroboration) — the EXACT SAME gate findRangeEndpointCollapseIssues
// applies just above — rather than re-deriving a second notion of
// "recipe-level" that could quietly drift from the detector's.
function reconstructRangeEndpointStep(args: {
  step: DraftStep;
  stepIndex: number;
  record: AmountProvenanceRecord;
  low: number;
  high: number;
  coffeeAmount: number | null;
  waterAmount: number | null;
}): { step: DraftStep; warning: string; syntheticRecord: AmountProvenanceRecord } | null {
  const { step, stepIndex, record, low, high, coffeeAmount, waterAmount } =
    args;

  const occurrences = findExpressionOccurrences(step.description_template);
  if (occurrences.length === 0) {
    // The collapsed endpoint was rendered as a bare literal number, not a
    // scalable expression — no `<final_coffee_amount>`/`<final_water_amount>`
    // placeholder exists here to derive a second multiplier from. Every
    // confirmed live instance of this defect (German, Chemex, Spanish — see
    // the module comment above) renders through an expression, so this is a
    // defensive "leave it to the detector" exit, not an observed gap.
    return null;
  }

  // Reuses F32's own compatibility gate (isRecordCompatibleWithPlaceholder,
  // defined above for exactly this "does this record's unit_kind make sense
  // for this placeholder" question) so a volume record can never anchor
  // itself to <final_coffee_amount> here either — the same D2 defect shape,
  // guarded the same way, rather than a second ad hoc rule.
  const candidates = occurrences.filter((occurrence) => {
    const base = occurrence.placeholder === "<final_coffee_amount>"
      ? coffeeAmount
      : waterAmount;
    if (base === null || !Number.isFinite(base) || base === 0) {
      return false;
    }
    if (!isRecordCompatibleWithPlaceholder(record, occurrence.placeholder)) {
      return false;
    }
    return Math.abs(occurrence.multiplier * base - record.value) <=
      RANGE_ENDPOINT_MATCH_TOLERANCE;
  });

  if (candidates.length !== 1) {
    // Zero candidates: nothing in this step's template renders this
    // record's own value, so there is no expression to anchor a
    // reconstruction to. More than one: ambiguous which expression the
    // record describes. Either way, never guess — same discipline
    // planStepMultiplierRepairs applies above. The draft is left exactly as
    // extraction/normalization/repair produced it; findRangeEndpointCollapseIssues
    // still reports the block.
    return null;
  }
  const [occurrence] = candidates;
  const base = occurrence.placeholder === "<final_coffee_amount>"
    ? coffeeAmount!
    : waterAmount!;

  // Which endpoint the kept record's value already represents determines
  // reconstruction order: the source's low value is always rendered first,
  // matching the natural reading order a genuine two-record range already
  // renders in (v47's own "(low)-(⁠high)" shape, and every other hyphenated
  // range this file already handles).
  const existingIsLow = Math.abs(record.value - low) <=
    RANGE_ENDPOINT_MATCH_TOLERANCE;
  const otherValue = existingIsLow ? high : low;
  const otherMultiplier = otherValue / base;
  if (!Number.isFinite(otherMultiplier)) {
    return null;
  }

  // G22 (provenance.ts's verifyAmountProvenance, out of this phase's file
  // ownership) verifies every RENDERED amount traces to a provenance
  // record — it has no notion of stated_range at all. Having just rendered
  // a second amount (otherValue) with nothing in extracted_amounts naming
  // it would otherwise fail G22's own check with `unverifiable_amount`,
  // trading one block for another. buildRangeEndpointSyntheticRecord below
  // constructs a sibling record with the same evidentiary basis as the one
  // that triggered this reconstruction — mirroring what v47's real
  // two-record extraction actually looked like. Computed BEFORE any
  // template splicing so an unsafe case (see that function's own comment)
  // bails out with the draft completely untouched, not partially rewritten.
  const syntheticRecord = buildRangeEndpointSyntheticRecord(record, otherValue);
  if (syntheticRecord === null) {
    return null;
  }
  const otherMultiplierText = formatMultiplier(otherMultiplier);

  // The existing occurrence's own multiplier TEXT (not a reformatted
  // number) is preserved byte-for-byte — only the missing endpoint is new
  // text, exactly as F32 above only ever splices in what it must. When the
  // kept value is the low endpoint, its trailing unit (already part of
  // matchText, since it was the sole endpoint) is moved to the new second
  // expression instead, matching how a real two-expression range only
  // carries the unit once, on the last expression.
  const rangeText = existingIsLow
    ? `(${occurrence.multiplierText} x ${occurrence.placeholder})-(${otherMultiplierText} x ${occurrence.placeholder})${occurrence.unit}`
    : `(${otherMultiplierText} x ${occurrence.placeholder})-${occurrence.matchText}`;

  const repairedTemplate = step.description_template.slice(
    0,
    occurrence.matchStart,
  ) + rangeText + step.description_template.slice(
    occurrence.matchStart + occurrence.matchText.length,
  );

  const repairedStep: DraftStep = {
    ...step,
    description_template: repairedTemplate,
    preview_text: renderPreviewText(
      repairedTemplate,
      coffeeAmount,
      waterAmount,
    ),
    expressions: extractExpressions(repairedTemplate, coffeeAmount, waterAmount),
  };

  const warning = `D1 backstop: step ${
    stepIndex + 1
  }'s stated range of ${low}-${high}${record.unit} had collapsed to a ` +
    `single ${record.value}${record.unit} rendering; reconstructed the ` +
    `missing endpoint (${otherValue}${record.unit}) from stated_range so ` +
    `both endpoints survive into the draft.`;

  return { step: repairedStep, warning, syntheticRecord };
}

// Builds the synthetic sibling record described in
// reconstructRangeEndpointStep's own comment above — same evidentiary basis
// as the record that triggered reconstruction, with `value` (and, for a
// range_endpoint derivation, `rule_inputs.endpoint`) pointed at the OTHER
// endpoint instead. Returns null when there is no SAFE way to do that,
// rather than emitting a record that would fail G22's own verification for
// a reason unrelated to whether the range genuinely collapsed:
//
//  - 'literal': G22's literal check (provenance.ts) only tests whether
//    source_quote appears in the request text — never the numeric value —
//    so cloning with value swapped is exactly as trustworthy as the
//    original record already was for its own value.
//  - 'derived' via the 'range_endpoint' rule: G22 RECOMPUTES the value from
//    rule_inputs { low, high, endpoint } and requires it to match. A naive
//    clone would keep the OLD endpoint selector and recompute back to the
//    ORIGINAL value, not otherValue — flipping endpoint (0<->1) is what
//    makes the recomputation agree with the value actually being
//    reconstructed. This is exactly the rule_inputs shape
//    resolveRangeEndpointTrigger's rule_inputs branch already required to
//    fire in the first place (endpoint strictly 0 or 1 — a midpoint
//    selection never reaches this function per that function's own
//    comment), so the flip is always well-defined here.
//  - Any other shape ('inferred', or 'derived' under a DIFFERENT rule that
//    only reached this function via the stated_range fallback) has no
//    known-safe transformation: recomputing under an unrelated rule (e.g.
//    'concentration') against a value that rule was never meant to
//    describe would almost certainly disagree, trading
//    range_endpoint_collapsed for a DIFFERENT G22 finding. Left to the
//    detector, same discipline as an ambiguous expression match above.
function buildRangeEndpointSyntheticRecord(
  record: AmountProvenanceRecord,
  otherValue: number,
): AmountProvenanceRecord | null {
  if (record.provenance === "literal") {
    return { ...record, value: otherValue };
  }

  if (
    record.provenance === "derived" &&
    record.rule === "range_endpoint" &&
    record.rule_inputs &&
    (record.rule_inputs.endpoint === 0 || record.rule_inputs.endpoint === 1)
  ) {
    return {
      ...record,
      value: otherValue,
      rule_inputs: {
        ...record.rule_inputs,
        endpoint: record.rule_inputs.endpoint === 0 ? 1 : 0,
      },
    };
  }

  return null;
}

// Orchestrates reconstructRangeEndpointStep over every eligible record,
// called from finalizeDraftResponse right after F32's multiplier repair and
// before renderedAmounts/findRangeEndpointCollapseIssues are built — so a
// step this successfully expands is never even reported as collapsed;
// "prefer reconstructing over blocking" (plan 020 §3 D1) applied
// deterministically rather than left to the model.
//
// renderedAmounts is rebuilt fresh on every iteration (not hoisted out of
// the loop) because an earlier record in the SAME call can have already
// rewritten the step whose rendering a later record's "is it already
// preserved" check needs to see — two independent ranges in the same draft
// must not both fire off a stale snapshot.
//
// Returns an AUGMENTED provenance array (original records plus one
// synthetic record per successful reconstruction — see
// reconstructRangeEndpointStep's own comment on syntheticRecord for why).
// The caller must use this returned array, not the original input, for
// every downstream check that reads what a rendered amount traces to
// (verifyAmountProvenance, findRangeEndpointCollapseIssues) — otherwise the
// newly-rendered endpoint has nothing to trace to and this backstop trades
// one block (range_endpoint_collapsed) for another (unverifiable_amount).
function expandCollapsedStatedRangeEndpoints(args: {
  steps: DraftStep[];
  provenance: AmountProvenanceRecord[];
  coffeeAmount: number | null;
  waterAmount: number | null;
}): {
  steps: DraftStep[];
  provenance: AmountProvenanceRecord[];
  warnings: string[];
} {
  let steps = args.steps;
  const provenance = [...args.provenance];
  const warnings: string[] = [];

  for (const record of args.provenance) {
    // Identical gate to findRangeEndpointCollapseIssues above — see that
    // function's comment for the full D3 rationale. A record this gate
    // exempts is a recipe-level scalar; collapsing it to one endpoint is
    // correct, and reconstructing a second endpoint for it would be the
    // exact regression the task brief warns against (French press).
    if (
      record.step_index < 0 ||
      isRecipeLevelScalarValue(record, args.coffeeAmount, args.waterAmount)
    ) {
      continue;
    }

    const trigger = resolveRangeEndpointTrigger(record);
    if (trigger === null) {
      continue;
    }

    const stepIndex = record.step_index;
    const step = steps[stepIndex];
    if (!step) {
      // Defensive only: foldRemappedExtractedAmounts (this function's
      // caller) already remaps every step-level record through the same
      // fold `steps` went through, so a record's step_index should always
      // resolve. Never throw on a provenance record from an upstream stage.
      continue;
    }

    const alreadyPreserved = isRangeEndpointValuePreserved(
      buildRenderedAmountsFromDraftSteps(steps),
      trigger.otherValue,
      record.unit,
    );
    if (alreadyPreserved) {
      // Nothing to reconstruct — either this record's high/low pair was
      // never actually collapsed (a genuine two-record range, exactly what
      // v47 always produced), or an earlier iteration already fixed it.
      continue;
    }

    const result = reconstructRangeEndpointStep({
      step,
      stepIndex,
      record,
      low: trigger.low,
      high: trigger.high,
      coffeeAmount: args.coffeeAmount,
      waterAmount: args.waterAmount,
    });
    if (result === null) {
      continue;
    }

    steps = steps.map((candidate, index) =>
      index === stepIndex ? result.step : candidate
    );
    warnings.push(result.warning);
    provenance.push(result.syntheticRecord);
  }

  return { steps, provenance, warnings };
}

// A tolerance for "is the rendered multiplier already numerically correct"
// — needed because the multiplier arriving in description_template is
// whatever text the LLM wrote (which may round or format differently than
// formatMultiplier would), not necessarily a byte-for-byte match even when
// the underlying number is right. Small enough to still catch a
// genuinely-different value (e.g. the diagnosed 0.2 vs 0.1875 in the
// Kalita case, a difference of 0.0125) while absorbing float/formatting
// noise around a correct one.
const MULTIPLIER_REPAIR_TOLERANCE = 0.0005;

// F33: a small, deliberately duplicated copy of provenance.ts's own
// normalizeForQuoteSearch/quoteAppearsInSource (see that file, ~line
// 103-151). parser.ts does not import from provenance.ts's internals here on
// purpose: provenance.ts is kept as a standalone, dependency-free checker
// that the parser calls into, not a shared-utility module the parser reaches
// back into — widening that boundary for one whitespace-normalisation helper
// would cost more than the few duplicated lines below. Keep this in lockstep
// with provenance.ts's implementation if that one ever changes.
function normalizeQuoteForSearchLocal(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoteAppearsInSourceLocal(
  quote: string | null,
  requestText: string,
): boolean {
  if (!quote) {
    return false;
  }
  const needle = normalizeQuoteForSearchLocal(quote);
  if (!needle) {
    return false;
  }
  return normalizeQuoteForSearchLocal(requestText).includes(needle);
}

// D9 (plan 020 §3, §4b): a rendered scalable expression can legitimately
// scale off the water (or coffee) amount without itself BEING a coffee or
// water amount — an ice quantity stated as "(0.5 x <final_water_amount>)g",
// for instance. Extraction's own instructions scope extracted_amounts to
// "every numeric COFFEE OR WATER amount" (see the G22 shared prompt block
// above), so ice, milk, a rinse volume etc. never get a record there by
// design. G22 (provenance.ts's verifyAmountProvenance) has no notion of "this
// amount is allowed to be unexplained" — its rule 1 blocks ANY rendered
// amount with no provenance record — so a correctly-scaled ice rendering was
// blocked as unverifiable_amount even though the renderer had already done
// the right thing (investigation: plan 020 §3 D9's capture table).
//
// Fix: give it a derived record off the SAME scalar the template already
// multiplies, reusing the multiplier the renderer already computed — never
// re-deriving it, and never asking the model for a new extraction field.
// Plan 020's own D1 is the standing warning against reflexively adding one
// (CLAUDE.md's "don't put semantic judgements in regexes" extends to "don't
// put them in new schema fields either" when a deterministic structural
// derivation already exists): the multiplier and which scalar it multiplies
// are both already sitting in step.expressions, produced by the SAME
// deterministic extractExpressions() every other rendered amount goes
// through, not detected via any keyword.
//
// Scoping is deliberately narrow and PROBE-GATED, not "add a record for
// every water/coffee expression": doing this unconditionally would add a
// same-valued competing candidate next to every genuine pour in the recipe,
// reintroducing the exact D4 collision Phase B fixed, just from the other
// direction (two candidate RECORDS for one rendered amount instead of two
// candidate rendered amounts for one record). So this calls the REAL G22
// check first (verifyAmountProvenance, imported above, never reimplemented)
// against the UNAUGMENTED provenance, and only adds a synthetic record for
// an expression whose OWN rendered entry comes back unverifiable_amount in
// that real result — i.e. only when G22 itself, with full knowledge of every
// other candidate in the recipe, has already decided nothing else explains
// this amount. A capture with no such finding is untouched by this function,
// byte for byte.
//
// Correlating a finding back to the specific expression that caused it
// avoids reimplementing provenance.ts's private matching internals
// (matchRenderedAmountsToProvenance is not exported, and file ownership
// keeps this file reading provenance.ts's public surface only, never
// touching it): unverifiable_amount fires at most once per rendered entry,
// and its message embeds `${value}${unit}` verbatim, in the exact same
// stringification buildRenderedAmountsFromDraftSteps already produced —
// step_index plus that substring uniquely identifies the entry for every
// case this backstop is scoped to.
//
// rule_source_quote is required by G22 for any 'derived' record, and there
// is no explicit "ice is half the water" ratio phrase in a typical source —
// the multiplier is arithmetic the renderer already did over two separately-
// stated literal facts, not a rule the text states in words. The step's own
// description_source (carried through, same text as extraction's raw_text)
// is reused instead: it is the raw sentence this step's amount came from,
// not a fabricated citation, and quoteAppearsInSourceLocal (F33's own
// duplicate of provenance.ts's real check, immediately above) confirms it
// actually appears in the submitted text before this function trusts it. If
// it does not — some steps are LLM-authored/merged text, not a guaranteed
// verbatim excerpt — this fails closed: no record is added, and the amount
// stays exactly as unverifiable as it was before this function ran. Never
// worse than the status quo.
const VOLUME_UNIT_HINTS_FOR_DERIVED_AMOUNTS = [
  "ml",
  "milliliter",
  "milliliters",
  "millilitre",
  "millilitres",
  "l",
  "liter",
  "liters",
  "litre",
  "litres",
  "cup",
  "cups",
  "fl oz",
  "floz",
  "oz",
];

// Best-effort data quality only — NOT load-bearing for G22's own match.
// Setting unit_kind makes provenance.ts's classifyRecordUnit resolve this
// record via the unit_kind branch (mass/volume -> "mass_or_volume") rather
// than its own unit-string lexicon; either path lands on the same bucket for
// an ordinary "g"/"ml" unit, since the rendered side normalizes through the
// identical string this record's own `unit` field is set from. Coffee is
// always mass (D2's own rule, isRecordCompatibleWithPlaceholder above:
// "Coffee is only ever weighed, never measured by volume, in any of this
// project's recipes") — this is a closed unit vocabulary, not a semantic
// judgement over free-form recipe prose, so it is not the English-only-regex
// pattern CLAUDE.md warns against.
function inferDerivedAmountUnitKind(
  placeholder: DraftExpression["placeholder"],
  unit: string,
): "mass" | "volume" {
  if (placeholder === "<final_coffee_amount>") {
    return "mass";
  }
  const normalized = normalizeExpressionUnit(unit).trim().toLowerCase();
  return VOLUME_UNIT_HINTS_FOR_DERIVED_AMOUNTS.includes(normalized)
    ? "volume"
    : "mass";
}

function deriveNonBrewAmountProvenance(args: {
  steps: DraftStep[];
  provenance: AmountProvenanceRecord[];
  requestText: string;
  coffeeAmount: number | null;
  waterAmount: number | null;
}): {
  steps: DraftStep[];
  provenance: AmountProvenanceRecord[];
  warnings: string[];
} {
  if (args.provenance.length === 0) {
    // G22 itself degrades an entirely-empty extracted_amounts to a single
    // "provenance could not be verified" warning (verifyAmountProvenance's
    // own backward-compatibility branch) rather than per-amount blocks —
    // there is nothing here for this backstop to trace an ice-like amount
    // off in that case either, and inventing a record would be a guess.
    return { steps: args.steps, provenance: args.provenance, warnings: [] };
  }

  const probeRenderedAmounts = buildRenderedAmountsFromDraftSteps(args.steps);
  if (probeRenderedAmounts.length === 0) {
    return { steps: args.steps, provenance: args.provenance, warnings: [] };
  }

  const probe = verifyAmountProvenance({
    requestText: args.requestText,
    renderedAmounts: probeRenderedAmounts,
    provenance: args.provenance,
  });
  const unverifiableFindings = probe.findings.filter((finding) =>
    finding.code === "unverifiable_amount"
  );
  if (unverifiableFindings.length === 0) {
    return { steps: args.steps, provenance: args.provenance, warnings: [] };
  }

  const provenance = [...args.provenance];
  const warnings: string[] = [];

  const steps = args.steps.map((step, stepIndex) => {
    let scalableAmounts = step.scalable_amounts;
    let scalableAmountsChanged = false;

    for (const expression of step.expressions) {
      if (expression.preview_value === null) {
        continue;
      }
      const baseAmount = expression.placeholder === "<final_coffee_amount>"
        ? args.coffeeAmount
        : args.waterAmount;
      if (
        baseAmount === null || !Number.isFinite(baseAmount) ||
        baseAmount === 0
      ) {
        continue;
      }

      const previewValue = expression.preview_value;
      const renderedUnit = normalizeExpressionUnit(expression.unit);
      const needle = `${previewValue}${renderedUnit}`;
      const isUnexplained = unverifiableFindings.some((finding) =>
        finding.step_index === stepIndex && finding.message.includes(needle)
      );
      if (!isUnexplained) {
        continue;
      }

      const ruleSourceQuote = step.description_source.trim();
      if (!quoteAppearsInSourceLocal(ruleSourceQuote, args.requestText)) {
        continue;
      }

      const isCoffee = expression.placeholder === "<final_coffee_amount>";
      const rule = isCoffee ? "multiple_of_coffee" : "multiple_of_water";
      const ruleInputs: Record<string, number> = isCoffee
        ? { multiplier: expression.multiplier, coffee_amount: baseAmount }
        : { multiplier: expression.multiplier, water_amount: baseAmount };
      const recordUnit = expression.unit.trim() || renderedUnit || "g";

      provenance.push({
        value: previewValue,
        unit: recordUnit,
        step_index: stepIndex,
        provenance: "derived",
        source_quote: null,
        rule,
        rule_source_quote: ruleSourceQuote,
        rule_inputs: ruleInputs,
        unit_kind: inferDerivedAmountUnitKind(
          expression.placeholder,
          expression.unit,
        ),
        stated_range: null,
      });

      warnings.push(
        `D9 backstop: step ${
          stepIndex + 1
        }'s ${previewValue}${renderedUnit} has no coffee/water provenance ` +
          `record (it is not itself a coffee or water amount) but renders ` +
          `as ${
            formatMultiplier(expression.multiplier)
          } x the recipe's own ${
            isCoffee ? "coffee" : "water"
          } amount; traced it to that scalar so it verifies and scales ` +
          `correctly.`,
      );

      if (
        !scalableAmounts.some((amount) =>
          normalizeExpressionUnit(amount.unit).trim().toLowerCase() ===
            renderedUnit.trim().toLowerCase() &&
          Math.abs(amount.value - previewValue) < 0.01
        )
      ) {
        scalableAmounts = [
          ...scalableAmounts,
          { value: previewValue, unit: recordUnit },
        ];
        scalableAmountsChanged = true;
      }
    }

    return scalableAmountsChanged
      ? { ...step, scalable_amounts: scalableAmounts }
      : step;
  });

  return { steps, provenance, warnings };
}

type ExpressionOccurrence = {
  // Position of this expression among all expressions in the step's
  // template, in left-to-right appearance order — the key used to look up
  // this occurrence's repair decision in the plan built below.
  index: number;
  matchStart: number;
  matchText: string;
  multiplierText: string;
  multiplier: number;
  unit: string;
  placeholder: "<final_coffee_amount>" | "<final_water_amount>";
};

// Same parse as extractExpressions, but keeping match position/raw text
// instead of computing preview values — this repair pass needs to splice
// text back into the template, not render it.
function findExpressionOccurrences(template: string): ExpressionOccurrence[] {
  const occurrences: ExpressionOccurrence[] = [];
  let position = 0;
  for (const match of template.matchAll(cloneRegex(EXPRESSION_REGEX))) {
    const multiplierText = match[1];
    const multiplier = Number(multiplierText);
    if (!Number.isFinite(multiplier) || match.index === undefined) {
      continue;
    }
    occurrences.push({
      index: position,
      matchStart: match.index,
      matchText: match[0],
      multiplierText,
      multiplier,
      unit: (match[3] ?? "").trim(),
      placeholder: `<${match[2]}>` as ExpressionOccurrence["placeholder"],
    });
    position += 1;
  }
  return occurrences;
}

// D2 (plan 020 §3, §4 Phase A): F32 below matches a literal provenance
// record to an expression occurrence by value/step_index/placeholder-base
// alone — it has no opinion on whether the record's own DIMENSION could
// ever be the thing the placeholder represents. Confirmed defect: a cold
// brew capture recorded { value: 4, unit: "cups", unit_kind: "volume",
// step_index: 0 } for "4 cups" of water alongside the real dose
// { value: 82, unit: "grams", unit_kind: "mass", step_index: -1 }. F32 saw
// step 0's <final_coffee_amount> expression render ~82 g, found the sole
// step-0 literal record was the 4-cups volume record, and "repaired" the
// COFFEE multiplier to 4/82 — rendering "Grind 4g coffee" against an 82 g
// recipe. Latent since F32 predates unit_kind (016); 016's richer
// extraction prompt simply started producing step-level volume records
// where the old prompt produced none for this shape.
//
// The rule is a per-placeholder allowlist, not a single-value denylist —
// deliberately asymmetric between the two placeholders, but never open by
// default for a *kind* this function has an opinion on:
//  - <final_coffee_amount> only accepts "mass". Coffee is only ever
//    weighed, never measured by volume, in any of this project's recipes
//    — there is no legitimate reading under which a volume literal is the
//    correct source-of-truth for a coffee-mass expression, however its
//    value happens to divide out. "time" and "percent" are rejected for
//    the same reason as "volume": neither is ever a coffee amount, so
//    binding one to <final_coffee_amount> is the identical defect shape as
//    the confirmed "4 cups" case — a number that was never an amount
//    quietly overwriting a real dose (e.g. a stray "30" second record
//    against a step that also renders "30g").
//  - <final_water_amount> accepts "mass" and "volume". Water is routinely
//    stated in both g and ml at density ≈ 1 in real captures — this is not
//    a guess, it is the same equivalence unit_kind's own schema comment
//    already documents ("mass and volume are mutually compatible
//    (density≈1 precedent for water)", see amountProvenanceSchema above)
//    and the same assumption normalizeUnitForRangeCheck makes a few
//    hundred lines up. Two confirmed-good repairs depend on exactly this
//    direction firing unchanged: German round-3 (a "50g" mass literal
//    repairing a <final_water_amount> expression) and a Kalita capture (a
//    "200grams" mass literal repairing <final_water_amount>). "time" and
//    "percent" are rejected here too — a stated brew duration or a stated
//    ratio percentage is no more a water amount than it is a coffee one,
//    and no confirmed-good repair depends on either kind reaching this
//    placeholder. If a real case ever needs a percent/time-labelled record
//    to repair a water expression, that is a new, deliberate exception to
//    add with its own evidence — not a default this function should fall
//    into.
//  - A record with no unit_kind at all (old captures, all six golden
//    fixtures — the field is optional+nullable for exactly this reason)
//    is always compatible with either placeholder, so this rule can never
//    change the outcome for a draft that predates unit_kind.
function isRecordCompatibleWithPlaceholder(
  record: AmountProvenanceRecord,
  placeholder: ExpressionOccurrence["placeholder"],
): boolean {
  const kind = record.unit_kind;
  if (!kind) {
    // Backward compatibility (plan 020 §Backward compatibility, CLAUDE.md):
    // absent/null unit_kind must behave exactly as before this fix — never
    // reject a binding on the strength of a field the record doesn't have.
    return true;
  }
  if (placeholder === "<final_coffee_amount>") {
    return kind === "mass";
  }
  // <final_water_amount>
  return kind === "mass" || kind === "volume";
}

// F32: decides which literal provenance record (if any) repairs which
// expression occurrence in a single step. Returns a map from occurrence
// index to the record that should replace its multiplier; an occurrence
// absent from the map is left untouched.
//
// Two shapes are handled, both observed live:
//  - Every expression in the step targets the SAME placeholder (a single
//    amount, or a range rendered as two expressions like Chemex's 60-90 g
//    bloom). Pair positionally in appearance order: extraction records
//    amounts in reading order and the template preserves that same order,
//    so this only fires when the counts line up exactly — never a guess.
//  - The step's expressions target BOTH placeholders (a coffee-scaled
//    amount and a water-scaled amount in one step). Positional order
//    across the whole step no longer says which record belongs with which
//    expression, so each side is split by base first. getCleanestPlaceholder
//    is reused here (never reimplemented) purely to classify each record's
//    likely base — the split is only trusted when a base's record count
//    exactly matches its expression count; a mismatched or empty base is
//    left untouched, same as the no-record/ambiguous cases below.
function planStepMultiplierRepairs(args: {
  occurrences: ExpressionOccurrence[];
  literalRecords: AmountProvenanceRecord[];
  coffeeAmount: number | null;
  waterAmount: number | null;
}): Map<number, AmountProvenanceRecord> {
  const plan = new Map<number, AmountProvenanceRecord>();

  if (args.occurrences.length === 0 || args.literalRecords.length === 0) {
    return plan;
  }

  const distinctPlaceholders = new Set(
    args.occurrences.map((occurrence) => occurrence.placeholder),
  );

  if (distinctPlaceholders.size === 1) {
    const [onlyPlaceholder] = distinctPlaceholders;
    // D2: drop any record whose unit_kind cannot legitimately describe
    // this placeholder (e.g. a "volume" record against
    // <final_coffee_amount>) BEFORE the count check below — a record that
    // gets filtered out here must make the counts fail to line up rather
    // than being silently paired positionally with the wrong expression.
    const compatibleRecords = args.literalRecords.filter((record) =>
      isRecordCompatibleWithPlaceholder(record, onlyPlaceholder)
    );
    if (compatibleRecords.length !== args.occurrences.length) {
      // Ambiguous — more/fewer records than expressions to pair them
      // with. Never guess: let G22 report it as it already does.
      return plan;
    }
    args.occurrences.forEach((occurrence, position) => {
      plan.set(occurrence.index, compatibleRecords[position]);
    });
    return plan;
  }

  for (const placeholder of distinctPlaceholders) {
    const occurrencesForBase = args.occurrences.filter((occurrence) =>
      occurrence.placeholder === placeholder
    );
    const recordsForBase = args.literalRecords.filter((record) =>
      getCleanestPlaceholder({
        value: record.value,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
      }) === placeholder &&
      isRecordCompatibleWithPlaceholder(record, placeholder)
    );
    if (recordsForBase.length !== occurrencesForBase.length) {
      continue;
    }
    occurrencesForBase.forEach((occurrence, position) => {
      plan.set(occurrence.index, recordsForBase[position]);
    });
  }

  return plan;
}

// F32 (PRIMARY fix — see the module-level defect note above
// buildRenderedAmountsFromDraftSteps for the failure this repairs): the
// normalization/repair LLM's prompt lists example scalable-quantity
// placeholders such as "(0.2 x <final_water_amount>)g" to illustrate the
// EXPRESSION SHAPE. Live traffic showed the model instead treating those
// numbers as a closed set of values to copy onto whichever step it
// pattern-matched, rather than as a worked example — e.g. a source step
// literally stating "40 جرام" for the bloom (against a 300 g final water
// amount, i.e. a correct multiplier of 40/300 = 0.133333) was rendered as
// "(0.2 x <final_water_amount>)g", because 0.2 happens to be one of the
// prompt's own example multipliers. The SAME run divided correctly to six
// decimals on every OTHER pour in the recipe (140/300, 220/300, 300/300),
// so this is example-copying on individual steps, not a systematic
// arithmetic bug.
//
// Rather than harden the prompt further (F30 already showed that reduces
// but never eliminates this class of failure), this recomputes the
// multiplier deterministically wherever a more reliable number already
// exists: extraction (or repair) already recorded the source's own literal
// figure for this exact step in extracted_amounts (provenance "literal" —
// appears verbatim in the submitted text, see AMOUNT_PROVENANCE_PROMPT_RULES).
// Given that literal value and the recipe's own coffee/water totals, the
// correct multiplier is a plain division; the model is never trusted to
// have divided correctly.
//
// Deliberately conservative about when it fires — see
// planStepMultiplierRepairs for the pairing rules:
//  - Only 'literal' records are authoritative enough to overwrite a
//    rendering. 'derived'/'inferred' records are the LLM's own computed or
//    inferred figures, not a verbatim source fact, so they are left alone
//    and reported by G22 (verifyAmountProvenance) exactly as before this
//    fix.
//  - The expression's EXISTING placeholder (already present in the
//    malformed text) is trusted as the base to divide by, rather than
//    re-derived from the literal record's value via getCleanestPlaceholder.
//    That heuristic scores a ratio by how "clean" (near-integer / simple
//    fraction) it looks — useful when there is no better signal, but
//    actively wrong here: the diagnosed Arabic bloom is 40 g against a
//    20 g coffee dose AND a 300 g water target, and 40/20 = 2 is a
//    "cleaner" ratio than 40/300 = 0.1333, yet 40/300 is the value proven
//    correct by every other pour in the same run. The model's placeholder
//    CHOICE has not been observed wrong in any live example — only the
//    multiplier constant — so it is trusted here. getCleanestPlaceholder is
//    still reused (never reimplemented) for the one shape that genuinely
//    needs an independent base decision: a step mixing both placeholders,
//    handled in planStepMultiplierRepairs.
//  - A step with no matching literal record, or a record/expression count
//    that cannot be paired unambiguously, is left completely untouched.
//  - Only the multiplier digits are spliced out of the matched expression
//    text; the operator, spacing, placeholder, and trailing unit are kept
//    byte-for-byte, so a non-Latin unit like جرام is never touched.
//  - Warns rather than repairing silently: every actual change emits a
//    warning naming the old and new values, so a wrong extraction can
//    never quietly overwrite a correct rendering without a trace. A
//    rendering that is already numerically correct (within
//    MULTIPLIER_REPAIR_TOLERANCE) is left untouched with no warning.
//  - F33: a 'literal' record is only trusted here once its own
//    source_quote is verified to actually appear in the request text
//    (quoteAppearsInSourceLocal, whitespace-normalised — same comparison
//    G22/provenance.ts uses). A record that claims to be literal but whose
//    quote is not really in the source (e.g. a hallucinated extraction) is
//    excluded from literalRecords below exactly as if it did not exist, so
//    the rendering is left untouched and G22 (verifyAmountProvenance) is
//    the one to report the mismatch — this pass must never rewrite a
//    correct rendering into a fabricated one on the strength of an
//    unverified record.
function repairExpressionMultipliersAgainstLiteralProvenance(input: {
  steps: DraftStep[];
  provenance: AmountProvenanceRecord[];
  coffeeAmount: number | null;
  waterAmount: number | null;
  requestText: string;
}): { steps: DraftStep[]; warnings: string[] } {
  const warnings: string[] = [];

  const steps = input.steps.map((step, stepIndex) => {
    const allOccurrences = findExpressionOccurrences(
      step.description_template,
    );
    if (allOccurrences.length === 0) {
      return step;
    }

    // Phase A/E2 (plan 023): F32 is a repair for an unexplained current
    // rendering, not a licence to replace one source-traceable amount with
    // another same-dimension record from the same step. Probe each current
    // expression through the real provenance verifier before pairing it.
    // The flash-chilled defect's coffee expression already renders the
    // recipe's source-traceable 25 g dose, so its unrelated 150 g ice record
    // must never rewrite it to 6 x <final_coffee_amount>.
    const occurrences = allOccurrences.filter((occurrence) => {
      const base = occurrence.placeholder === "<final_coffee_amount>"
        ? input.coffeeAmount
        : input.waterAmount;
      if (base === null || !Number.isFinite(base) || base === 0) {
        return true;
      }
      const probe = verifyAmountProvenance({
        requestText: input.requestText,
        renderedAmounts: [{
          step_index: stepIndex,
          value: occurrence.multiplier * base,
          unit: normalizeExpressionUnit(occurrence.unit),
          is_cumulative_water: false,
        }],
        provenance: input.provenance,
      });
      return probe.unverified || probe.findings.length > 0;
    });
    if (occurrences.length === 0) {
      return step;
    }

    const literalRecords = input.provenance.filter((record) =>
      record.step_index === stepIndex && record.provenance === "literal" &&
      quoteAppearsInSourceLocal(record.source_quote, input.requestText)
    );
    if (literalRecords.length === 0) {
      return step;
    }

    const plan = planStepMultiplierRepairs({
      occurrences,
      literalRecords,
      coffeeAmount: input.coffeeAmount,
      waterAmount: input.waterAmount,
    });
    if (plan.size === 0) {
      return step;
    }

    let repairedTemplate = "";
    let cursor = 0;
    let changed = false;

    for (const occurrence of allOccurrences) {
      repairedTemplate += step.description_template.slice(
        cursor,
        occurrence.matchStart,
      );
      cursor = occurrence.matchStart + occurrence.matchText.length;

      const record = plan.get(occurrence.index);
      const base = occurrence.placeholder === "<final_coffee_amount>"
        ? input.coffeeAmount
        : input.waterAmount;

      if (!record || base === null || !Number.isFinite(base) || base === 0) {
        repairedTemplate += occurrence.matchText;
        continue;
      }

      const newMultiplier = record.value / base;
      if (
        Math.abs(newMultiplier - occurrence.multiplier) <
          MULTIPLIER_REPAIR_TOLERANCE
      ) {
        // Already correct — no repair, no warning.
        repairedTemplate += occurrence.matchText;
        continue;
      }

      const newMultiplierText = formatMultiplier(newMultiplier);
      // Only the multiplier digits are replaced; the leading "(", operator,
      // spacing, placeholder, closing paren, and unit that surround them
      // are preserved exactly as the model wrote them. EXPRESSION_REGEX's
      // group 1 (the multiplier) always starts one character into the
      // match — right after the opening "(", with no whitespace allowed
      // between them — so multiplierStart is always 1 in practice;
      // indexOf is used rather than hardcoding 1 so this stays correct if
      // the regex ever changes.
      const multiplierStart = occurrence.matchText.indexOf(
        occurrence.multiplierText,
      );
      if (multiplierStart < 0) {
        // Defensive: unreachable given matchText/multiplierText are both
        // derived from the same regex match, but never corrupt the
        // template on an assumption that turns out false.
        repairedTemplate += occurrence.matchText;
        continue;
      }
      const rewrittenExpression = occurrence.matchText.slice(
        0,
        multiplierStart,
      ) + newMultiplierText + occurrence.matchText.slice(
        multiplierStart + occurrence.multiplierText.length,
      );
      repairedTemplate += rewrittenExpression;
      changed = true;

      const oldRenderedValue = (occurrence.multiplier * base).toFixed(2);
      const newRenderedValue = record.value;
      warnings.push(
        `F32 repair: step ${
          stepIndex + 1
        }'s scaling expression rendered ${occurrence.multiplierText} x ${occurrence.placeholder} (~${oldRenderedValue}${
          occurrence.unit ? occurrence.unit : ""
        }), but the source literally states ${newRenderedValue}${record.unit} for this step (source_quote: ${
          record.source_quote ?? "n/a"
        }). Recomputed the multiplier to ${newMultiplierText}.`,
      );
    }

    repairedTemplate += step.description_template.slice(cursor);

    if (!changed) {
      return step;
    }

    return {
      ...step,
      description_template: repairedTemplate,
      preview_text: renderPreviewText(
        repairedTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
      expressions: extractExpressions(
        repairedTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
    };
  });

  return { steps, warnings };
}

function finalizeDraftResponse(input: {
  extraction: ExtractionResult;
  normalized: NormalizedDraft;
  userId: string;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
  providerUsed: LlmProviderName;
  providerModelUsed: string;
  tokensUsed: number;
  openaiTokensUsed: number;
  skipDeterministicWaterTotals?: boolean;
  nowMs: number;
  // F28: threaded through to normalizeAbsoluteTimestampDurations so it can
  // refuse to append a synthetic English drawdown sentence onto a
  // non-English recipe.
  detectedInputLanguage: string | null;
  // Phase E (Task 3): the per-stage provider trail collected while running
  // parseDraft, surfaced verbatim on the response.
  providerTrail: ProviderTrailEntry[];
  // Threaded through so the count-changing passes below can decline to run:
  // verify-user-recipe-draft's handler hard-502s the app if the parser
  // returns a different step count than the request supplied (see
  // verify-user-recipe-draft/handler.ts), so verify mode must never let a
  // structural pass add or remove a step.
  mode: RecipeDraftParserMode;
  // G22: the raw text the user submitted, exactly as sent — every literal
  // source_quote/rule_source_quote in extracted_amounts must trace back to
  // this string, not to any narrowed/normalized derivative of it.
  requestText: string;
  // Stage-capture (opt-in via capture_stages): collected while running
  // parseDraft, null when capture wasn't requested. Surfaced on the
  // response for handler.ts to persist and then strip before responding —
  // see ParseUserRecipeDraftResponse.stage_outputs.
  stageOutputs: StageOutputs | null;
}): ParseUserRecipeDraftResponse {
  // Derived once, structurally, rather than checked ad hoc at each call
  // site below — every pass that can change the step count must consult
  // this instead of re-deriving its own notion of "am I in verify mode".
  const preserveStepCount = input.mode === "verify";
  const resolvedBrewingMethod = resolveBrewingMethodId({
    brewingMethods: input.brewingMethods,
    brewingMethodHint: input.brewingMethodHint,
    normalizedBrewingMethodId: input.normalized.recipe.brewing_method_id,
    extractedLikelyBrewingMethod: input.extraction.likely_brewing_method,
  });
  const normalizedWithHint: NormalizedDraft = {
    ...input.normalized,
    warnings: uniqueStrings([
      ...input.normalized.warnings,
      ...resolvedBrewingMethod.warnings,
    ]),
    recipe: {
      ...input.normalized.recipe,
      brewing_method_id: resolvedBrewingMethod.brewingMethodId,
    },
  };
  const normalizedWithBalancedCopy: NormalizedDraft = {
    ...normalizedWithHint,
    localization: {
      ...normalizedWithHint.localization,
      short_description: rebalanceShortDescription({
        normalized: normalizedWithHint,
        brewingMethods: input.brewingMethods,
      }),
    },
  };

  const narrowedText = buildNarrowedSourceText(input.extraction);

  const builtDraftSteps = buildDraftSteps({
    steps: normalizedWithBalancedCopy.steps,
    coffeeAmount: normalizedWithBalancedCopy.recipe.coffee_amount,
    waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
    resolvedTemperatureCelsius: resolveWaterTempStatedRange(
      input.extraction.water_temp_stated_range ?? null,
    )?.celsius,
    mode: input.mode,
  });
  const foldedDraftSteps = foldPreTimerStepsIntoPreparation({
    steps: builtDraftSteps,
    preserveStepCount,
  });
  // Plan 016 §4 Phase 4 (D2): extracted_amounts records carry step_index
  // values assigned by the LLM stages, which run BEFORE this deterministic
  // fold and therefore never see it — a Hario pre-timer dose recorded at
  // step_index 2 lands on the rendered draft's step 0 once folded, a drift
  // of 2 that trips provenance.ts's >1 block even though the draft is
  // correct. Remap every step-level record through the exact same mapping
  // the fold just applied, right here, so verifyAmountProvenance and the
  // D4 range-collapse check below both see records that already agree with
  // `foldedDraftSteps`/`draftSteps`'s own indices. Recipe-level `step_index:
  // -1` records are left untouched — -1 is a sentinel (coffee_amount/
  // water_amount), not a position the fold could have moved.
  //
  // Splits are deliberately NOT remapped here: unlike the fold, step
  // splitting happens inside the LLM stages, is not deterministic, and the
  // normalization stage already re-emits split records with corrected
  // indices (see foldPreTimerStepsIntoPreparation's own doc comment). The
  // ±1 tolerance in provenance.ts exists to absorb whatever residual drift
  // that LLM-side renumbering leaves — remapping split indices here as well
  // would double-correct them and is out of scope for this fix.
  const foldRemappedExtractedAmounts =
    (normalizedWithBalancedCopy.extracted_amounts ?? []).map((record) =>
      record.step_index < 0 ? record : {
        ...record,
        step_index: foldedDraftSteps.remapStepIndex(record.step_index),
      }
    );
  // The fold above merges plain text into steps[0]'s description; re-render
  // its preview text and re-extract its expressions so the merged content
  // is reflected (foldPreTimerStepsIntoPreparation itself only touches
  // steps, not the amounts needed to render/extract expressions).
  const preparationRenderedDraftSteps = foldedDraftSteps.steps.map(
    (step, index) => {
      if (index !== 0) {
        return step;
      }

      return {
        ...step,
        preview_text: renderPreviewText(
          step.description_template,
          normalizedWithBalancedCopy.recipe.coffee_amount,
          normalizedWithBalancedCopy.recipe.water_amount,
        ),
        expressions: extractExpressions(
          step.description_template,
          normalizedWithBalancedCopy.recipe.coffee_amount,
          normalizedWithBalancedCopy.recipe.water_amount,
        ),
      };
    },
  );
  const waterNormalizedDraftStepsResult = input.skipDeterministicWaterTotals
    ? { steps: preparationRenderedDraftSteps, warnings: [] as string[] }
    : convertWaterStepsToRunningTotals({
      steps: preparationRenderedDraftSteps,
      coffeeAmount: normalizedWithBalancedCopy.recipe.coffee_amount,
      waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
    });
  const waterNormalizedDraftSteps = waterNormalizedDraftStepsResult.steps;
  const timestampNormalizedDraftSteps = normalizeAbsoluteTimestampDurations({
    steps: waterNormalizedDraftSteps,
    narrowedText,
    extractionTotalBrewTimeSeconds: input.extraction.total_brew_time_seconds,
    detectedInputLanguage: input.detectedInputLanguage,
    preserveStepCount,
  });
  const totalTargetNormalizedDraftSteps =
    splitDerivedBrewStepDurationsFromTarget(
      {
        steps: timestampNormalizedDraftSteps.steps,
        narrowedText,
        extractionTotalBrewTimeSeconds:
          input.extraction.total_brew_time_seconds,
        timestampDifferencedIndexes:
          timestampNormalizedDraftSteps.timestampDifferencedIndexes,
      },
    );
  const durationNormalizedDraftSteps = enforceMinimumStepDurations({
    steps: totalTargetNormalizedDraftSteps.steps,
  });
  // F32: runs after every LLM and deterministic transform above (same
  // "sees exactly what the user would be shown" requirement as G22's own
  // renderedAmounts build below) and BEFORE verifyAmountProvenance, so G22
  // verifies the REPAIRED rendering rather than flagging a mismatch this
  // pass already fixed deterministically.
  //
  // Plan 016 §4 Phase 4: `steps` here (durationNormalizedDraftSteps) is
  // POST-fold, so this needs the same fold-remapped provenance G22 uses
  // below — matching a record by `record.step_index === stepIndex`
  // (planStepMultiplierRepairs' call site) against raw, unremapped indices
  // would pair a pre-fold record with whatever POST-fold step happens to
  // share that same numeric index, which is a coincidence, not a
  // correspondence. Using foldRemappedExtractedAmounts here keeps every
  // consumer of extracted_amounts downstream of the fold in agreement about
  // what "this step" means.
  const multiplierRepair = repairExpressionMultipliersAgainstLiteralProvenance(
    {
      steps: durationNormalizedDraftSteps.steps,
      provenance: foldRemappedExtractedAmounts,
      coffeeAmount: normalizedWithBalancedCopy.recipe.coffee_amount,
      waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
      requestText: input.requestText,
    },
  );
  // Phase D (plan 020 §3 D1, §4b): runs immediately after F32's multiplier
  // repair, on the exact same steps array, and BEFORE renderedAmounts/
  // findRangeEndpointCollapseIssues are built further down — see
  // expandCollapsedStatedRangeEndpoints above for the full rationale. Uses
  // the same foldRemappedExtractedAmounts F32 just used, for the same
  // reason: this is a step-indexed lookup against POST-fold `draftSteps`,
  // so it needs provenance already remapped through the same fold.
  const rangeEndpointExpansion = expandCollapsedStatedRangeEndpoints({
    steps: multiplierRepair.steps,
    provenance: foldRemappedExtractedAmounts,
    coffeeAmount: normalizedWithBalancedCopy.recipe.coffee_amount,
    waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
  });
  // D9 (plan 020 §3, §4b): runs after every other deterministic rewrite of
  // description_template/extracted_amounts above, on the same steps/
  // provenance rangeEndpointExpansion just produced — see
  // deriveNonBrewAmountProvenance's own comment for why this must be
  // probe-gated against the REAL G22 check rather than firing
  // unconditionally.
  const nonBrewAmountProvenance = deriveNonBrewAmountProvenance({
    steps: rangeEndpointExpansion.steps,
    provenance: rangeEndpointExpansion.provenance,
    requestText: input.requestText,
    coffeeAmount: normalizedWithBalancedCopy.recipe.coffee_amount,
    waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
  });
  const draftSteps = nonBrewAmountProvenance.steps;
  const brewSteps = draftSteps.filter((step) => step.kind === "brew");
  const brewTimeSeconds = brewSteps.length > 0 &&
      brewSteps.every((step) =>
        step.duration_seconds >= MIN_BREW_STEP_DURATION_SECONDS
      )
    ? brewSteps.reduce((sum, step) => sum + step.duration_seconds, 0)
    : null;

  const validation = validateDraft({
    draftSteps,
    normalized: normalizedWithBalancedCopy,
    brewingMethods: input.brewingMethods,
    brewingMethodHint: input.brewingMethodHint,
  });

  const missingSourceOnlyFieldWarnings = getMissingSourceOnlyFields({
    normalized: normalizedWithBalancedCopy,
    extraction: input.extraction,
    brewingMethods: input.brewingMethods,
    brewingMethodHint: input.brewingMethodHint,
  }).map((field) => SOURCE_ONLY_FIELD_WARNINGS[field]);

  const missingNonEnglishTotalBrewTimeWarnings =
    buildMissingNonEnglishTotalBrewTimeWarnings({
      detectedInputLanguage: input.detectedInputLanguage,
      extractionTotalBrewTimeSeconds: input.extraction.total_brew_time_seconds,
    });

  // F19: checked against the FINAL published grind_size (post-normalization/
  // repair, same "sees exactly what the user would be shown" requirement as
  // G22's own checks below), but the stated/inferred provenance signal only
  // ever comes from extraction — normalization is instructed to carry
  // localization fields through rather than re-judge them.
  const grindSizeWarnings = buildGrindSizeWarnings({
    grindSize: normalizedWithBalancedCopy.localization.grind_size ??
      input.extraction.grind_size,
    grindSizeIsStated: input.extraction.grind_size_is_stated ?? false,
    detectedInputLanguage: input.detectedInputLanguage,
  });

  // G22: runs AFTER every LLM and deterministic transform above — folding,
  // running-water-total conversion, timestamp normalization, the duration
  // split, and minimum-duration enforcement have all already produced
  // `draftSteps` by this point, so this sees exactly what the user would
  // be shown. `?? []` guards a caller that bypasses zod's `.default([])`
  // (every test-provider stub in this repo does, since they hand back a
  // plain object instead of running it through schema.parse) — without the
  // guard, a fixture predating this field would crash here instead of
  // correctly falling into verifyAmountProvenance's `unverified` path.
  const renderedAmounts = buildRenderedAmountsFromDraftSteps(draftSteps);
  // Phase D + D9: uses nonBrewAmountProvenance.provenance
  // (foldRemappedExtractedAmounts, PLUS any synthetic sibling records Phase
  // D's range-endpoint backstop added, PLUS any synthetic non-brew-amount
  // record D9's backstop just added above), not rangeEndpointExpansion.
  // provenance directly — see expandCollapsedStatedRangeEndpoints's and
  // deriveNonBrewAmountProvenance's own comments for why a newly
  // reconstructed/derived amount needs a provenance record of its own to
  // avoid trading range_endpoint_collapsed/unverifiable_amount for
  // unverifiable_amount.
  const provenanceResult = verifyAmountProvenance({
    requestText: input.requestText,
    renderedAmounts,
    provenance: nonBrewAmountProvenance.provenance,
  });

  // D4 (plan 016 Phase 3a): see findRangeEndpointCollapseIssues above.
  // Reuses the exact same (Phase D/D9-augmented) provenance array and
  // renderedAmounts G22 just built for this response — no separate
  // extraction pass, no new field.
  const rangeEndpointIssues = findRangeEndpointCollapseIssues(
    nonBrewAmountProvenance.provenance,
    renderedAmounts,
    normalizedWithBalancedCopy.recipe.coffee_amount,
    normalizedWithBalancedCopy.recipe.water_amount,
  );

  // Enforcement is asymmetric by field and mode (plans/009-recipe-draft-
  // lab-transcript-robustness.md §"G22 — settled design", point 3):
  //
  //             | extract mode | verify mode |
  //   amounts   |    block     |    block    |
  //   timing    |     warn     |    block    |
  //
  // Amounts collapse to a single behaviour regardless of mode: every
  // finding blocks. Do not special-case `input.mode` here; that would be
  // under-enforcing verify mode's amounts, which the table above never
  // asks for.
  const provenanceIssues: ValidationIssue[] = provenanceResult.findings.map(
    (finding: ProvenanceFinding) => ({
      code: finding.code,
      field: `steps[${finding.step_index}].description_template`,
      message: finding.message,
    }),
  );

  // Compatibility path (provenance.ts's own `unverified` contract): a
  // provider that ignores extracted_amounts entirely — or a fixture
  // predating this field — must not become unpublishable the moment this
  // check landed. Emit exactly one warning and do NOT block.
  const provenanceWarnings = provenanceResult.unverified
    ? [
      "Amount provenance could not be verified: the extraction stage did not report extracted_amounts, so this draft's coffee/water amounts are unconfirmed against the submitted text.",
    ]
    : [];

  // G22 — timing landmarks. Unlike amounts, this row of the matrix DOES
  // vary by mode: extract mode warns only, because Phase B2's deterministic
  // split computes every unstated duration from the target total and the
  // recipe's own water amounts — those derived durations never trace to a
  // source-stated figure BY CONSTRUCTION, and blocking on that would make
  // every ordinary transcript unpublishable. A stated landmark being
  // CHANGED is still worth surfacing even in extract mode, which is why it
  // warns rather than being skipped outright. verify mode blocks, matching
  // amounts, because verify mode's whole premise is that the source is
  // already a well-formed recipe and nothing should be silently rewritten.
  const timingLandmarks = buildTimingLandmarksFromFoldedSteps(
    preparationRenderedDraftSteps,
  );
  const renderedTimingSteps = buildRenderedTimingStepsFromDraftSteps(
    draftSteps,
  );
  const timingResult = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: input.extraction.total_brew_time_seconds,
    renderedSteps: renderedTimingSteps,
    landmarks: timingLandmarks,
  });
  // D5 (plan 016 Phase 3b): mirrors verifyTimingProvenance's own total-time
  // sum exactly (provenance.ts, "1. Total brew time.") so the severity
  // ratio below is judged against the identical figure the finding's own
  // message already reports — a fresh sum over the same renderedTimingSteps
  // input, never a regex over that message.
  const emittedTotalBrewTimeSeconds = renderedTimingSteps
    .filter((step) => step.kind === "brew")
    .reduce((sum, step) => sum + step.duration_seconds, 0);
  const statedTotalBrewTimeSeconds = input.extraction.total_brew_time_seconds;
  const statedTotalBrewTimeIsApproximate =
    input.extraction.total_brew_time_is_approximate ?? false;
  const statedTotalBrewTimeRange = resolveTotalBrewTimeStatedRange(
    input.extraction.total_brew_time_stated_range ?? null,
  );
  const emittedTotalIsInsideStatedRange = statedTotalBrewTimeRange !== null &&
    isTotalBrewTimeInsideStatedRange(
      emittedTotalBrewTimeSeconds,
      statedTotalBrewTimeRange,
    );
  // A stated range supersedes a scalar point/landmark for total-time
  // validation. Remove provenance.ts's scalar-based total finding, then
  // add a range-based finding only when the final total is outside the
  // inclusive window. Other timing findings remain untouched.
  const timingFindings = statedTotalBrewTimeRange === null
    ? timingResult.findings
    : [
      ...timingResult.findings.filter((finding) =>
        finding.code !== "total_brew_time_mismatch"
      ),
      ...(emittedTotalIsInsideStatedRange
        ? []
        : [{
          code: "total_brew_time_mismatch" as const,
          step_index: -1,
          message:
            `The source states a total brew time range of ${statedTotalBrewTimeRange.low}-${statedTotalBrewTimeRange.high}s, but the final brew steps sum to ${emittedTotalBrewTimeSeconds}s.`,
        }]),
    ];
  const severeTotalBrewTimeMismatch = statedTotalBrewTimeRange !== null
    ? !emittedTotalIsInsideStatedRange
    : statedTotalBrewTimeSeconds !== null &&
      isTotalBrewTimeMismatchSevere(
        statedTotalBrewTimeSeconds,
        emittedTotalBrewTimeSeconds,
        statedTotalBrewTimeIsApproximate,
      );
  // verify mode blocks on every timing finding unconditionally, exactly as
  // before (preserveStepCount, untouched). Extract mode still only WARNS on
  // an ordinary derived-duration/elapsed-landmark finding, exactly as
  // before — but a total_brew_time_mismatch finding that is also
  // proportionally severe (see isTotalBrewTimeMismatchSevere above) now
  // blocks even in extract mode. This is a per-finding-code gate, not a
  // change to preserveStepCount itself: flipping preserveStepCount would
  // block every derived per-step duration too, which is exactly the
  // "every ordinary transcript unpublishable" outcome the comment above
  // this block warns against.
  const isBlockingTimingFinding = (
    finding: TimingProvenanceFinding,
  ): boolean => {
    if (preserveStepCount) {
      return true;
    }
    return finding.code === "total_brew_time_mismatch" &&
      severeTotalBrewTimeMismatch;
  };
  const timingValidationIssues: ValidationIssue[] = timingFindings
    .filter(isBlockingTimingFinding)
    .map((finding: TimingProvenanceFinding) => ({
      code: finding.code,
      field: finding.step_index >= 0
        ? `steps[${finding.step_index}].duration_seconds`
        : "extraction.total_brew_time_seconds",
      message: finding.message,
    }));
  const timingWarnings = timingFindings
    .filter((finding) => !isBlockingTimingFinding(finding))
    .map((finding) => finding.message);

  const response: ParseUserRecipeDraftResponse = {
    detected_input_language:
      normalizedWithBalancedCopy.detected_input_language ??
        input.extraction.detected_input_language,
    provider_used: input.providerUsed,
    provider_model_used: input.providerModelUsed,
    provider_trail: input.providerTrail,
    // Set by handler.ts after the service.parse_user_recipe_draft_captures
    // insert completes (or left null if capture wasn't requested, or the
    // insert failed) — parseDraft itself never writes to the database, so
    // it cannot know the row id yet.
    capture_id: null,
    stage_outputs: input.stageOutputs,
    tokens_used: input.tokensUsed,
    openai_tokens_used: input.openaiTokensUsed,
    warnings: uniqueStrings([
      ...filterDiagnosticNotes(input.extraction.notes),
      ...foldedDraftSteps.warnings,
      ...waterNormalizedDraftStepsResult.warnings,
      ...timestampNormalizedDraftSteps.warnings,
      ...totalTargetNormalizedDraftSteps.warnings,
      ...durationNormalizedDraftSteps.warnings,
      ...validation.warnings,
      ...missingSourceOnlyFieldWarnings,
      ...missingNonEnglishTotalBrewTimeWarnings,
      ...grindSizeWarnings,
      ...multiplierRepair.warnings,
      ...rangeEndpointExpansion.warnings,
      ...nonBrewAmountProvenance.warnings,
      ...provenanceWarnings,
      ...timingWarnings,
    ]),
    validation: {
      is_publishable: validation.issues.length === 0 &&
        provenanceIssues.length === 0 &&
        rangeEndpointIssues.length === 0 &&
        timingValidationIssues.length === 0,
      issues: [
        ...validation.issues,
        ...provenanceIssues,
        ...rangeEndpointIssues,
        ...timingValidationIssues,
      ],
    },
    extraction: input.extraction,
    draft: {
      recipe: {
        brewing_method_id: normalizedWithBalancedCopy.recipe.brewing_method_id,
        coffee_amount: normalizedWithBalancedCopy.recipe.coffee_amount,
        water_amount: normalizedWithBalancedCopy.recipe.water_amount,
        water_temp: normalizedWithBalancedCopy.recipe.water_temp,
        brew_time_seconds: brewTimeSeconds,
        vendor_id: `usr-${input.userId}`,
      },
      localization: {
        locale: "en",
        name: normalizedWithBalancedCopy.localization.name,
        grind_size: normalizedWithBalancedCopy.localization.grind_size,
        short_description:
          normalizedWithBalancedCopy.localization.short_description,
      },
      steps: draftSteps,
    },
  };

  if (
    validation.issues.length === 0 &&
    provenanceIssues.length === 0 &&
    rangeEndpointIssues.length === 0 &&
    timingValidationIssues.length === 0 &&
    brewTimeSeconds !== null
  ) {
    response.publish_projection = buildPublishProjection({
      userId: input.userId,
      normalized: normalizedWithBalancedCopy,
      draftSteps,
      brewTimeSeconds,
      nowMs: input.nowMs,
    });
  }

  return response;
}

// ===========================================================================
// PHASE G (plans/020-provenance-oracle-hardening.md §4) — offline gate
// replay entrypoint.
// ===========================================================================
// A THIN wrapper, added solely to widen this file's export surface for
// scripts/recipe-draft-replay/ — the live request path (index.ts/handler.ts,
// createRecipeDraftParser().parseDraft) never calls this and its behaviour
// is completely unchanged by this addition. Nothing above this comment was
// modified.
//
// createRecipeDraftParser's own parseDraft (below) builds `extraction` and
// `normalized` by invoking LIVE providers, threading each stage's accepted
// result into the next (extraction -> normalization -> optional repair ->
// optional cumulative_rewrite) before calling finalizeDraftResponse. This
// entrypoint reruns EXACTLY that same merge, calling the identical internal
// functions parseDraft calls (applyExtractionFallbacks,
// normalizeDraftTemperatures/normalizeExtractionTemperatures,
// getMissingRequiredRepairFields/getMalformedStepTemplateRepairFields,
// buildDraftSteps, validateCumulativeRewriteSteps/
// validateRewrittenStepTemplates, revertUntraceableRangeCumulativeRewrites,
// getPrimaryLanguageSignal) in the same order and with the same acceptance
// criteria — never a reimplementation of that judgement — but SOURCES each
// stage's candidate "attempt" from a pre-recorded array (as captured via
// capture_stages: true into service.parse_user_recipe_draft_captures and
// read back offline) instead of invoking a live provider, then calls
// finalizeDraftResponse itself, unmodified, exactly as parseDraft does.
//
// FIDELITY: the one simplification against live behaviour is trusting that
// the RECORDED attempts array already reflects where production's own
// provider-fallback loop stopped, and re-deriving ACCEPTANCE (not ordering)
// from that array in order:
//   - extraction/normalization: first attempt with no transport/schema
//     error re-validates cleanly against the real schema. Production stops
//     at the first schema-validated success for these two stages (no
//     further semantic check gates acceptance), so this is exact, not an
//     approximation.
//   - repair: iterates every attempt in order and, for each one that
//     transport-succeeded, reruns the SAME
//     getMissingRequiredRepairFields/getMalformedStepTemplateRepairFields
//     check production uses to decide acceptance — the first attempt that
//     clears it is the one production would have accepted. If none does,
//     repair is treated as not having run, exactly like production leaving
//     `normalized` untouched when every provider exhausts its attempts.
//   - cumulative_rewrite: same pattern, using
//     validateCumulativeRewriteSteps/validateRewrittenStepTemplates as the
//     acceptance test, then applying revertUntraceableRangeCumulativeRewrites
//     to the accepted attempt exactly as parseDraft does.
// See scripts/recipe-draft-replay/gate-reconstruct.ts for the caller that
// builds this function's input from a capture row.

/** One recorded provider attempt for a single stage, projected down to what
 * this replay needs. Mirrors StageCaptureEntry's identity/outcome fields;
 * `parsed` is re-validated against the real stage schema below rather than
 * trusted as-is, so a capture whose JSON predates a newly-added optional
 * field still degrades exactly like a live run would. */
export type ReplayStageAttempt = {
  provider: string;
  model: string;
  error: string | null;
  parsed: unknown | null;
};

export type ReplayStageOutputsInput = {
  extraction: ReplayStageAttempt[];
  normalization: ReplayStageAttempt[];
  repair: ReplayStageAttempt[];
  cumulative_rewrite: ReplayStageAttempt[];
};

/** Which recorded attempt (if any) this replay actually used for each
 * stage, and whether repair/cumulative_rewrite were applied — so a caller
 * can report its sourcing exactly as visibly as
 * reconstruct.ts's existing `AmountProvenanceSource` does for the
 * provenance-only replay path (plans/020 §4 Phase G, "label any fallback
 * visibly, never silently"). */
export type ReplayDiagnostics = {
  extractionSource:
    | { attemptIndex: number; provider: string; model: string }
    | null;
  normalizationSource:
    | { attemptIndex: number; provider: string; model: string }
    | null;
  repairApplied: boolean;
  repairSource:
    | { attemptIndex: number; provider: string; model: string }
    | null;
  repairAttemptsConsidered: number;
  cumulativeRewriteApplied: boolean;
  cumulativeRewriteSource:
    | { attemptIndex: number; provider: string; model: string }
    | null;
  cumulativeRewriteAttemptsConsidered: number;
};

/** Thrown when a capture's recorded stage_outputs genuinely cannot be
 * reconstructed into valid finalizeDraftResponse input (e.g. every
 * extraction/normalization attempt errored or fails schema re-validation).
 * A caller must surface this honestly rather than substituting a plausible
 * default — see plans/020 §4 Phase G's brief. */
export class ReplayReconstructionError extends Error {}

export function replayFinalizeDraftResponseFromStageOutputs(input: {
  stageOutputs: ReplayStageOutputsInput;
  requestText: string;
  mode: RecipeDraftParserMode;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
  sourceLanguageHint?: string;
  userId: string;
  nowMs: number;
}): { response: ParseUserRecipeDraftResponse; diagnostics: ReplayDiagnostics } {
  // --- extraction: first attempt that transport-succeeded AND re-validates
  // against extractionSchema (mirrors parseDraft's provider loop, which
  // breaks at the first invokeProviderStageWithRetry success). ---
  let extraction: ExtractionResult | null = null;
  let extractionSource: ReplayDiagnostics["extractionSource"] = null;
  for (let index = 0; index < input.stageOutputs.extraction.length; index++) {
    const attempt = input.stageOutputs.extraction[index];
    if (attempt.error || attempt.parsed == null) continue;
    try {
      extraction = extractionSchema.parse(attempt.parsed);
      extractionSource = {
        attemptIndex: index,
        provider: attempt.provider,
        model: attempt.model,
      };
      break;
    } catch {
      continue;
    }
  }
  if (!extraction) {
    throw new ReplayReconstructionError(
      "no captured extraction attempt could be reconstructed (every attempt errored, was null, or failed extractionSchema re-validation) — cannot replay the gate for this capture.",
    );
  }
  extraction = normalizeExtractionTemperatures(extraction);

  // --- normalization: same pattern as extraction. ---
  let normalized: NormalizedDraft | null = null;
  let normalizationSource: ReplayDiagnostics["normalizationSource"] = null;
  for (
    let index = 0;
    index < input.stageOutputs.normalization.length;
    index++
  ) {
    const attempt = input.stageOutputs.normalization[index];
    if (attempt.error || attempt.parsed == null) continue;
    try {
      normalized = normalizedDraftSchema.parse(attempt.parsed);
      normalizationSource = {
        attemptIndex: index,
        provider: attempt.provider,
        model: attempt.model,
      };
      break;
    } catch {
      continue;
    }
  }
  if (!normalized) {
    throw new ReplayReconstructionError(
      "no captured normalization attempt could be reconstructed (every attempt errored, was null, or failed normalizedDraftSchema re-validation) — cannot replay the gate for this capture.",
    );
  }
  normalized = normalizeDraftTemperatures(normalized, extraction);
  normalized = applyExtractionFallbacks({ normalized, extraction });

  // --- repair: only "counts" once the SAME missing/malformed-field check
  // production uses reports nothing left missing (parser.ts's own repair
  // loop, mirrored here rather than approximated by a transport-error
  // proxy). ---
  let repairApplied = false;
  let repairSource: ReplayDiagnostics["repairSource"] = null;
  let repairAttemptsConsidered = 0;
  for (let index = 0; index < input.stageOutputs.repair.length; index++) {
    const attempt = input.stageOutputs.repair[index];
    if (attempt.error || attempt.parsed == null) continue;
    repairAttemptsConsidered += 1;
    let repaired: NormalizedDraft;
    try {
      repaired = normalizedDraftSchema.parse(attempt.parsed);
    } catch {
      continue;
    }
    const repairedWithNormalizedTemperatures = normalizeDraftTemperatures(
      repaired,
      extraction,
    );
    const repairedWithFallbacks = applyExtractionFallbacks({
      normalized: repairedWithNormalizedTemperatures,
      extraction,
    });
    const remainingRepairFields = uniqueStrings([
      ...getMissingRequiredRepairFields({
        normalized: repairedWithFallbacks,
        extraction,
        brewingMethods: input.brewingMethods,
        brewingMethodHint: input.brewingMethodHint,
      }),
      ...getMalformedStepTemplateRepairFields(repairedWithFallbacks),
    ]);
    if (remainingRepairFields.length > 0) {
      continue;
    }

    normalized = {
      ...repairedWithFallbacks,
      warnings: uniqueStrings([
        ...repairedWithFallbacks.warnings,
        "Missing or malformed fields were repaired after re-reading the original text.",
      ]),
    };
    repairApplied = true;
    repairSource = {
      attemptIndex: index,
      provider: attempt.provider,
      model: attempt.model,
    };
    break;
  }

  // --- cumulative_rewrite: same "same acceptance test as production"
  // pattern, then the exact same range-safety overlay. Only steps/warnings
  // change; extracted_amounts/recipe/localization are left untouched,
  // matching parseDraft. An EMPTY recorded array means the pass was never
  // attempted (shouldAttemptCumulativeRewritePass was false) — production's
  // onAttempt fires for every real provider call, so a truly-attempted
  // stage always leaves at least one recorded entry regardless of outcome;
  // this lets the replay skip re-deriving that gate itself. ---
  let skipDeterministicWaterTotals = false;
  let cumulativeRewriteApplied = false;
  let cumulativeRewriteSource: ReplayDiagnostics["cumulativeRewriteSource"] =
    null;
  let cumulativeRewriteAttemptsConsidered = 0;
  if (input.stageOutputs.cumulative_rewrite.length > 0) {
    const provisionalDraftSteps = buildDraftSteps({
      steps: normalized.steps,
      coffeeAmount: normalized.recipe.coffee_amount,
      waterAmount: normalized.recipe.water_amount,
      resolvedTemperatureCelsius: resolveWaterTempStatedRange(
        extraction.water_temp_stated_range ?? null,
      )?.celsius,
      mode: input.mode,
    });
    for (
      let index = 0;
      index < input.stageOutputs.cumulative_rewrite.length;
      index++
    ) {
      const attempt = input.stageOutputs.cumulative_rewrite[index];
      if (attempt.error || attempt.parsed == null) continue;
      cumulativeRewriteAttemptsConsidered += 1;
      let rewritten: CumulativeRewriteResult;
      try {
        rewritten = cumulativeRewriteSchema.parse(attempt.parsed);
      } catch {
        continue;
      }
      const rewriteValidationError = validateCumulativeRewriteSteps({
        original: normalized.steps,
        rewritten: rewritten.steps,
      });
      if (rewriteValidationError) continue;
      const rewrittenTemplateValidationError = validateRewrittenStepTemplates(
        rewritten.steps,
      );
      if (rewrittenTemplateValidationError) continue;

      const { steps: rangeSafeSteps, warnings: rangeSafeWarnings } =
        revertUntraceableRangeCumulativeRewrites({
          original: provisionalDraftSteps,
          rewritten: rewritten.steps,
          coffeeAmount: normalized.recipe.coffee_amount,
          waterAmount: normalized.recipe.water_amount,
        });

      normalized = {
        ...normalized,
        warnings: uniqueStrings([
          ...normalized.warnings,
          ...rewritten.warnings,
          ...rangeSafeWarnings,
        ]),
        steps: rangeSafeSteps,
      };
      skipDeterministicWaterTotals = true;
      cumulativeRewriteApplied = true;
      cumulativeRewriteSource = {
        attemptIndex: index,
        provider: attempt.provider,
        model: attempt.model,
      };
      break;
    }
  }

  const detectedInputLanguage = getPrimaryLanguageSignal([
    input.sourceLanguageHint,
    normalized.detected_input_language,
    extraction.detected_input_language,
  ]);

  const response = finalizeDraftResponse({
    extraction,
    normalized,
    userId: input.userId,
    brewingMethods: input.brewingMethods,
    brewingMethodHint: input.brewingMethodHint,
    providerUsed: (extractionSource?.provider ?? "openai") as LlmProviderName,
    providerModelUsed: extractionSource?.model ?? "unknown",
    tokensUsed: 0,
    openaiTokensUsed: 0,
    skipDeterministicWaterTotals,
    nowMs: input.nowMs,
    detectedInputLanguage,
    providerTrail: [],
    mode: input.mode,
    requestText: input.requestText,
    stageOutputs: null,
  });

  return {
    response,
    diagnostics: {
      extractionSource,
      normalizationSource,
      repairApplied,
      repairSource,
      repairAttemptsConsidered,
      cumulativeRewriteApplied,
      cumulativeRewriteSource,
      cumulativeRewriteAttemptsConsidered,
    },
  };
}

// F10: most observed provider failures are transient or truncation-shaped
// rather than a genuine capability gap, so falling through to the next
// (often weaker) model on the very first failure throws away a model that
// would likely have succeeded on a second try. This retries the SAME
// provider exactly once before the caller's own per-provider loop gives up
// on it and advances to the next provider.
//
// Phase E (Task 3): also reports how many attempts it took (1 = succeeded
// first try, 2 = succeeded on the retry) so callers can populate
// provider_trail accurately. On failure this function always makes exactly
// 2 attempts before propagating the second call's error — callers building
// a trail entry for a caught error can rely on that contract instead of
// tracking attempts themselves.
async function invokeProviderStageWithRetry<T>(args: {
  provider: RecipeDraftAiProvider;
  invocation: ProviderInvocation<T>;
  logger: Logger;
}): Promise<{ result: T; tokensUsed: number; attempts: number }> {
  try {
    const outcome = await args.provider.invokeJson<T>(args.invocation);
    return { ...outcome, attempts: 1 };
  } catch (firstError) {
    args.logger.warn(
      `[parse-user-recipe-draft] ${args.invocation.stage}_retry requestId=${args.invocation.requestId} provider=${args.provider.name} model=${args.provider.model} error=${
        summarizeError(firstError)
      }`,
    );
    const outcome = await args.provider.invokeJson<T>(args.invocation);
    return { ...outcome, attempts: 2 };
  }
}

// Phase E (Task 3): every provider ATTEMPTED for a stage is used exactly
// once before either succeeding or being abandoned by
// invokeProviderStageWithRetry, so a caught error always means exactly
// STAGE_RETRY_ATTEMPT_COUNT attempts were made.
const STAGE_RETRY_ATTEMPT_COUNT = 2;

// Stage-capture size guard (required — see the task brief): an unbounded
// row is a liability once transcripts plus four stages of JSON accumulate,
// so any single raw_text longer than this is truncated, with the tail
// replaced by a marker and `truncated: true` set on the entry.
const STAGE_CAPTURE_MAX_RAW_TEXT_LENGTH = 200_000;
const STAGE_CAPTURE_TRUNCATION_MARKER = "\n…[truncated for storage]";

function truncateRawTextForCapture(
  rawText: string,
): { text: string; truncated: boolean } {
  if (rawText.length <= STAGE_CAPTURE_MAX_RAW_TEXT_LENGTH) {
    return { text: rawText, truncated: false };
  }

  const keepLength = Math.max(
    0,
    STAGE_CAPTURE_MAX_RAW_TEXT_LENGTH - STAGE_CAPTURE_TRUNCATION_MARKER.length,
  );
  return {
    text: rawText.slice(0, keepLength) + STAGE_CAPTURE_TRUNCATION_MARKER,
    truncated: true,
  };
}

// Stage-capture (opt-in via capture_stages): builds the onAttempt callback
// for one provider's invocation(s) within a single stage. `targetArray` is
// the specific stage's array inside the run's StageOutputs (or null when
// capture is off, in which case this returns a no-op — zero allocation,
// zero retention, matching the "zero overhead when off" requirement).
// `attemptCounter` is threaded in BY REFERENCE (as a single-element array)
// so it keeps incrementing across every provider this stage tries, not just
// within one provider's own retries — matching how provider_trail itself
// accumulates across provider fallback.
function createStageAttemptRecorder(
  targetArray: StageCaptureEntry[] | null,
  attemptCounter: { count: number },
  provider: { name: string; model: string },
):
  | ((info: {
    rawText: string;
    finishReason: string | null;
    parsed: unknown;
    error: string | null;
  }) => void)
  | undefined {
  if (!targetArray) {
    return undefined;
  }

  return (info) => {
    attemptCounter.count += 1;
    const { text, truncated } = truncateRawTextForCapture(info.rawText);
    const entry: StageCaptureEntry = {
      attempt: attemptCounter.count,
      provider: provider.name,
      model: provider.model,
      finish_reason: info.finishReason,
      raw_text: text,
      parsed: info.parsed ?? null,
      error: info.error,
    };
    if (truncated) {
      entry.truncated = true;
    }
    targetArray.push(entry);
  };
}

export function createRecipeDraftParser(
  config: RecipeDraftParserConfig,
): RecipeDraftParser {
  const providers = buildProviders(config);
  const logger = config.logger ?? console;
  const now = config.now ?? (() => Date.now());

  if (providers.length === 0) {
    throw new Error(
      "No AI providers configured for parse-user-recipe-draft.",
    );
  }

  return {
    async parseDraft(
      input: RecipeDraftParserInput,
    ): Promise<ParseUserRecipeDraftResponse> {
      const activeProviders = input.disabledProviders?.length
        ? providers.filter((p) => !input.disabledProviders!.includes(p.name))
        : providers;

      let totalTokensUsed = 0;
      let openaiTokensUsed = 0;
      const providerTrail: ProviderTrailEntry[] = [];

      // Stage-capture (opt-in via capture_stages): allocated only when
      // requested — "zero overhead when off" per the task brief. Each
      // stage's attempt counter lives in its own ref cell so it can
      // increment across that stage's own provider fallback loop (and, for
      // repair, its nested per-provider attempt loop too) without
      // interfering with the other stages' counters.
      const stageOutputs: StageOutputs | null = input.captureStages
        ? { extraction: [], normalization: [], repair: [], cumulative_rewrite: [] }
        : null;
      const extractionAttemptCounter = { count: 0 };
      const normalizationAttemptCounter = { count: 0 };
      const repairAttemptCounter = { count: 0 };
      const cumulativeRewriteAttemptCounter = { count: 0 };

      let extraction: ExtractionResult | null = null;
      let extractionProviderIndex = -1;
      let extractionLastError: unknown = null;

      for (let index = 0; index < activeProviders.length; index += 1) {
        const provider = activeProviders[index];
        try {
          const { result, tokensUsed, attempts } =
            await invokeProviderStageWithRetry<ExtractionResult>({
              provider,
              logger,
              invocation: {
                requestId: input.requestId,
                stage: "extraction",
                systemPrompt: buildExtractionSystemPrompt(),
                userPrompt: buildExtractionUserPrompt({
                  text: input.text,
                  brewingMethodHint: input.brewingMethodHint,
                  sourceLanguageHint: input.sourceLanguageHint,
                }),
                schema: extractionSchema,
                maxCompletionTokens: STAGE_MAX_COMPLETION_TOKENS.extraction,
                onAttempt: createStageAttemptRecorder(
                  stageOutputs?.extraction ?? null,
                  extractionAttemptCounter,
                  provider,
                ),
              },
            });
          extraction = result;
          totalTokensUsed += tokensUsed;
          if (provider.name === "openai") openaiTokensUsed += tokensUsed;
          extractionProviderIndex = index;
          providerTrail.push({
            stage: "extraction",
            provider: provider.name,
            model: provider.model,
            attempts,
          });
          break;
        } catch (error) {
          extractionLastError = error;
          providerTrail.push({
            stage: "extraction",
            provider: provider.name,
            model: provider.model,
            attempts: STAGE_RETRY_ATTEMPT_COUNT,
          });
          logger.warn(
            `[parse-user-recipe-draft] extraction_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} error=${
              summarizeError(error)
            }`,
          );
        }
      }

      if (!extraction || extractionProviderIndex === -1) {
        throw new Error(
          `All providers failed during recipe extraction: ${
            summarizeError(extractionLastError)
          }`,
        );
      }

      extraction = normalizeExtractionTemperatures(extraction);

      // Phase E (Task 3): the provider that served extraction is pinned and
      // preferred for every subsequent stage (normalization, repair,
      // cumulative_rewrite). Each of those stages starts its own walk from
      // this SAME index — not from wherever the previous stage happened to
      // land — and only advances past it if the pinned provider exhausts
      // its retry for that stage. This stops a later stage's fallback
      // (e.g. normalization dropping to a weaker model) from becoming the
      // new "current" provider for every stage after it.
      const pinnedProviderIndex = extractionProviderIndex;

      let normalized: NormalizedDraft | null = null;
      let normalizationProviderIndex = -1;
      let normalizationLastError: unknown = null;

      for (
        let index = pinnedProviderIndex;
        index < activeProviders.length;
        index += 1
      ) {
        const provider = activeProviders[index];
        try {
          const { result, tokensUsed, attempts } =
            await invokeProviderStageWithRetry<NormalizedDraft>({
              provider,
              logger,
              invocation: {
                requestId: input.requestId,
                stage: "normalization",
                systemPrompt: buildNormalizationSystemPrompt(
                  input.mode ?? "extract",
                ),
                userPrompt: buildNormalizationUserPrompt({
                  extraction,
                  brewingMethods: input.brewingMethods,
                  brewingMethodHint: input.brewingMethodHint,
                }),
                schema: normalizedDraftSchema,
                maxCompletionTokens: STAGE_MAX_COMPLETION_TOKENS.normalization,
                onAttempt: createStageAttemptRecorder(
                  stageOutputs?.normalization ?? null,
                  normalizationAttemptCounter,
                  provider,
                ),
              },
            });
          normalized = result;
          totalTokensUsed += tokensUsed;
          if (provider.name === "openai") openaiTokensUsed += tokensUsed;
          normalizationProviderIndex = index;
          providerTrail.push({
            stage: "normalization",
            provider: provider.name,
            model: provider.model,
            attempts,
          });
          break;
        } catch (error) {
          normalizationLastError = error;
          providerTrail.push({
            stage: "normalization",
            provider: provider.name,
            model: provider.model,
            attempts: STAGE_RETRY_ATTEMPT_COUNT,
          });
          logger.warn(
            `[parse-user-recipe-draft] normalization_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} error=${
              summarizeError(error)
            }`,
          );
        }
      }

      if (!normalized || normalizationProviderIndex === -1) {
        throw new Error(
          `All providers failed during recipe normalization: ${
            summarizeError(normalizationLastError)
          }`,
        );
      }

      normalized = normalizeDraftTemperatures(normalized, extraction);
      normalized = applyExtractionFallbacks({
        normalized,
        extraction,
      });

      const repairFields = uniqueStrings([
        ...getMissingRequiredRepairFields({
          normalized,
          extraction,
          brewingMethods: input.brewingMethods,
          brewingMethodHint: input.brewingMethodHint,
        }),
        ...getMalformedStepTemplateRepairFields(normalized),
      ]);

      const REPAIR_MAX_ATTEMPTS_PER_PROVIDER = 2;

      if (repairFields.length > 0) {
        for (
          let index = pinnedProviderIndex;
          index < activeProviders.length;
          index += 1
        ) {
          const provider = activeProviders[index];
          let repairSucceeded = false;
          let repairAttemptsMade = 0;

          for (
            let attempt = 0;
            attempt < REPAIR_MAX_ATTEMPTS_PER_PROVIDER;
            attempt += 1
          ) {
            repairAttemptsMade = attempt + 1;
            try {
              // Note: repair already retries the same provider up to
              // REPAIR_MAX_ATTEMPTS_PER_PROVIDER times below on ANY error
              // (transient/truncation or a still-missing-fields semantic
              // failure) before the outer loop advances to the next
              // provider, so it does not need invokeProviderStageWithRetry
              // on top — that would compound into up to 4 attempts.
              const { result: repaired, tokensUsed } = await provider
                .invokeJson<NormalizedDraft>({
                  requestId: input.requestId,
                  stage: "repair",
                  systemPrompt: buildRepairSystemPrompt(
                    input.mode ?? "extract",
                  ),
                  userPrompt: buildRepairUserPrompt({
                    text: input.text,
                    extraction,
                    normalized,
                    missingFields: repairFields,
                    brewingMethods: input.brewingMethods,
                    brewingMethodHint: input.brewingMethodHint,
                  }),
                  schema: normalizedDraftSchema,
                  maxCompletionTokens: STAGE_MAX_COMPLETION_TOKENS.repair,
                  onAttempt: createStageAttemptRecorder(
                    stageOutputs?.repair ?? null,
                    repairAttemptCounter,
                    provider,
                  ),
                });
              totalTokensUsed += tokensUsed;
              if (provider.name === "openai") openaiTokensUsed += tokensUsed;

              const repairedWithNormalizedTemperatures =
                normalizeDraftTemperatures(
                  repaired,
                  extraction,
                );
              const repairedWithFallbacks = applyExtractionFallbacks({
                normalized: repairedWithNormalizedTemperatures,
                extraction,
              });
              const remainingRepairFields = uniqueStrings([
                ...getMissingRequiredRepairFields({
                  normalized: repairedWithFallbacks,
                  extraction,
                  brewingMethods: input.brewingMethods,
                  brewingMethodHint: input.brewingMethodHint,
                }),
                ...getMalformedStepTemplateRepairFields(repairedWithFallbacks),
              ]);

              if (remainingRepairFields.length > 0) {
                throw new Error(
                  `repair still missing or malformed fields: ${
                    remainingRepairFields.join(", ")
                  }`,
                );
              }

              normalized = {
                ...repairedWithFallbacks,
                warnings: uniqueStrings([
                  ...repairedWithFallbacks.warnings,
                  "Missing or malformed fields were repaired after re-reading the original text.",
                ]),
              };
              repairSucceeded = true;
              break;
            } catch (error) {
              logger.warn(
                `[parse-user-recipe-draft] repair_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} attempt=${
                  attempt + 1
                }/${REPAIR_MAX_ATTEMPTS_PER_PROVIDER} missing_fields=${
                  repairFields.join(",")
                } error=${summarizeError(error)}`,
              );
            }
          }

          providerTrail.push({
            stage: "repair",
            provider: provider.name,
            model: provider.model,
            attempts: repairAttemptsMade,
          });

          if (repairSucceeded) break;
        }
      }

      let skipDeterministicWaterTotals = false;
      const provisionalDraftSteps = buildDraftSteps({
        steps: normalized.steps,
        coffeeAmount: normalized.recipe.coffee_amount,
        waterAmount: normalized.recipe.water_amount,
        resolvedTemperatureCelsius: resolveWaterTempStatedRange(
          extraction.water_temp_stated_range ?? null,
        )?.celsius,
        mode: input.mode ?? "extract",
      });
      const detectedInputLanguage = getPrimaryLanguageSignal([
        input.sourceLanguageHint,
        normalized.detected_input_language,
        extraction.detected_input_language,
      ]);

      if (
        shouldAttemptCumulativeRewritePass({
          sourceLanguageHint: input.sourceLanguageHint,
          detectedInputLanguage,
          draftSteps: provisionalDraftSteps,
        })
      ) {
        for (
          let index = pinnedProviderIndex;
          index < activeProviders.length;
          index += 1
        ) {
          const provider = activeProviders[index];
          try {
            const {
              result: rewritten,
              tokensUsed,
              attempts,
            }: {
              result: CumulativeRewriteResult;
              tokensUsed: number;
              attempts: number;
            } = await invokeProviderStageWithRetry<CumulativeRewriteResult>({
              provider,
              logger,
              invocation: {
                requestId: input.requestId,
                stage: "cumulative_rewrite",
                systemPrompt: buildCumulativeRewriteSystemPrompt(
                  input.mode ?? "extract",
                ),
                userPrompt: buildCumulativeRewriteUserPrompt({
                  mode: input.mode ?? "extract",
                  detectedInputLanguage,
                  normalized,
                  draftSteps: provisionalDraftSteps,
                }),
                schema: cumulativeRewriteSchema,
                maxCompletionTokens:
                  STAGE_MAX_COMPLETION_TOKENS.cumulative_rewrite,
                onAttempt: createStageAttemptRecorder(
                  stageOutputs?.cumulative_rewrite ?? null,
                  cumulativeRewriteAttemptCounter,
                  provider,
                ),
              },
            });
            totalTokensUsed += tokensUsed;
            if (provider.name === "openai") openaiTokensUsed += tokensUsed;

            const rewriteValidationError = validateCumulativeRewriteSteps({
              original: normalized.steps,
              rewritten: rewritten.steps,
            });
            if (rewriteValidationError) {
              throw new Error(rewriteValidationError);
            }

            const rewrittenTemplateValidationError =
              validateRewrittenStepTemplates(rewritten.steps);
            if (rewrittenTemplateValidationError) {
              throw new Error(rewrittenTemplateValidationError);
            }

            // Fix 1 (Aug 2026 live pass): reject any step where
            // cumulative_rewrite recomputed a RANGE's numeric content
            // itself (see the function doc above) rather than merely
            // rewording around an unchanged amount — that recomputation
            // invents a figure with no traceable provenance record. Falls
            // back to that one step's pre-rewrite (already-traceable)
            // template; every other step's legitimate rewrite is kept.
            const { steps: rangeSafeSteps, warnings: rangeSafeWarnings } =
              revertUntraceableRangeCumulativeRewrites({
                original: provisionalDraftSteps,
                rewritten: rewritten.steps,
                coffeeAmount: normalized.recipe.coffee_amount,
                waterAmount: normalized.recipe.water_amount,
              });

            normalized = {
              ...normalized,
              warnings: uniqueStrings([
                ...normalized.warnings,
                ...rewritten.warnings,
                ...rangeSafeWarnings,
              ]),
              steps: rangeSafeSteps,
            };
            skipDeterministicWaterTotals = true;
            providerTrail.push({
              stage: "cumulative_rewrite",
              provider: provider.name,
              model: provider.model,
              attempts,
            });
            break;
          } catch (error) {
            providerTrail.push({
              stage: "cumulative_rewrite",
              provider: provider.name,
              model: provider.model,
              attempts: STAGE_RETRY_ATTEMPT_COUNT,
            });
            logger.warn(
              `[parse-user-recipe-draft] cumulative_rewrite_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} error=${
                summarizeError(error)
              }`,
            );
          }
        }
      }

      // Phase E (Task 3): provider_used/provider_model_used reflect the
      // provider that served EXTRACTION — the stage that sets the draft's
      // substance — not whichever provider a later stage happened to fall
      // through to. See provider_trail for the full per-stage record.
      return finalizeDraftResponse({
        extraction,
        normalized,
        userId: input.userId,
        brewingMethods: input.brewingMethods,
        brewingMethodHint: input.brewingMethodHint,
        providerUsed: activeProviders[extractionProviderIndex].name,
        providerModelUsed: activeProviders[extractionProviderIndex].model,
        tokensUsed: totalTokensUsed,
        openaiTokensUsed,
        skipDeterministicWaterTotals,
        nowMs: now(),
        detectedInputLanguage,
        providerTrail,
        mode: input.mode ?? "extract",
        requestText: input.text,
        stageOutputs,
      });
    },
  };
}
