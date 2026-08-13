// Phase 0 (plans/016-publish-gate-correction.md) — offline replay harness.
//
// Rebuilds the exact inputs verifyAmountProvenance/verifyTimingProvenance
// need, out of a captured `parse-user-recipe-draft` row (see
// supabase/migrations/20260812101856_parse_user_recipe_draft_captures.sql).
//
// OWNERSHIP: this directory is new-files-only (plans/016 §"File ownership",
// Agent C). Nothing here imports anything except the READ-ONLY exported
// surface of provenance.ts — no edits are made to parser.ts, parser_test.ts,
// provenance.ts or provenance_test.ts.
//
// ---------------------------------------------------------------------
// FIDELITY FIX (2026-08-12): where provenance records actually come from
// ---------------------------------------------------------------------
// An earlier version of this harness sourced provenance records straight
// from `response.extraction.extracted_amounts` — the raw EXTRACTION-stage
// output. That is NOT what production feeds `verifyAmountProvenance`.
//
// Verified by reading parser.ts (never edited, only read, per this
// directory's ownership rule):
//
//   - `applyExtractionFallbacks` (parser.ts:4367-4403) is the merge rule.
//     Read literally: prefer whatever the CURRENT `normalized` draft's own
//     `extracted_amounts` carries; fall back to `extraction`'s copy only
//     when the current draft's array is EMPTY.
//   - It is called twice in the pipeline (parser.ts:6519-6522 and
//     6589-6592): once right after normalization, and again — if the
//     repair stage runs — on repair's own output. Each call REPLACES the
//     working `normalized` value wholesale (comment at parser.ts:4390-4392
//     contrasts this with cumulative_rewrite, which only ever overwrites
//     `steps`/`warnings`, never `extracted_amounts` — confirmed separately:
//     `cumulativeRewriteSchema`, parser.ts:261-264, has no
//     `extracted_amounts` field at all, so cumulative_rewrite structurally
//     cannot re-emit provenance records).
//   - Consequence: if repair ran and its own `applyExtractionFallbacks`
//     call sees a NON-EMPTY array from repair's output, that becomes the
//     final `normalizedWithBalancedCopy.extracted_amounts` fed to
//     `verifyAmountProvenance` (parser.ts:5936) — and normalization's
//     contribution is discarded entirely, not merely superseded. If
//     repair's own array is EMPTY (a provider that repaired other missing
//     fields but forgot to re-emit amounts), production falls straight
//     through to raw `extraction` — it does NOT fall back to
//     normalization's array. Only when repair never ran at all does
//     normalization's own (already-fallback-applied) array survive to the
//     end.
//
// So the true precedence, last-stage-wins with an empty-array skip AT EACH
// STAGE INDEPENDENTLY, is:
//
//   1. repair, if the repair stage ran AND its last successful attempt's
//      `extracted_amounts` is non-empty.
//   2. otherwise, if repair never ran (or every attempt errored/never
//      succeeded), normalization's last successful attempt's
//      `extracted_amounts`, if non-empty.
//   3. otherwise, raw `response.extraction.extracted_amounts`.
//
// This CONFIRMS the plan author's description ("repair's output if the
// repair stage ran, else normalization's, else fall back to
// response.extraction.extracted_amounts") with one sharper nuance worth
// recording: when repair ran but re-emitted an EMPTY array, production
// skips normalization entirely and falls straight to extraction — see
// `selectAmountProvenanceSource` below, case "repair-ran-but-empty".
//
// KNOWN APPROXIMATION — "last successful attempt": production's repair loop
// tries each provider up to REPAIR_MAX_ATTEMPTS_PER_PROVIDER (2) times and
// only accepts an attempt when `getMissingRequiredRepairFields` /
// `getMalformedStepTemplateRepairFields` (parser.ts, NOT re-implemented
// here — that would mean copying substantial parser.ts business logic into
// a directory that is barred from importing parser.ts) report nothing
// missing. The stage-capture recorder (`createStageAttemptRecorder`,
// parser.ts:6298-6327) only records a per-provider-call `error` field
// (transport/schema-validation failure), NOT that higher-level
// still-missing-fields rejection — so several recorded attempts can all
// have `error: null` while production only accepted the LAST one (or
// none at all, if every provider's repair attempts kept failing the
// missing-fields check). This harness approximates "succeeded" as "the
// last attempt with no recorded transport/schema error", which is
// optimistic: it can pick an attempt production actually discarded.
// Observed impact in the current cache (2026-08-12, 31 captures): the one
// capture with multiple non-erroring repair attempts before the stage
// truly exhausted (508382e8, cold brew control, attempts 1-4 clean then
// 5-6 hard-erroring on a missing Gemini model) carried IDENTICAL
// `extracted_amounts` across every non-erroring attempt AND normalization,
// so the approximation happens not to change this harness's amount-
// provenance verdict for that capture. A future capture where repair
// attempts disagree on amounts could still expose this gap — flagged
// per-capture below whenever repair had more than one non-erroring
// attempt, so it is visible rather than silently trusted.
import type {
  AmountProvenance,
  RenderedAmount,
  RenderedTimingStep,
  TimingLandmark,
} from "../../supabase/functions/parse-user-recipe-draft/provenance.ts";

// ---------------------------------------------------------------------
// Minimal capture shape. Only the fields this harness actually reads are
// typed; everything else in the row passes through as `unknown`.

export type CaptureDraftExpression = {
  unit: string;
  multiplier: number;
  placeholder: string;
  preview_value: number | null;
};

export type CaptureDraftStep = {
  kind: "preparation" | "brew";
  step_role: string;
  step_order: number;
  expressions: CaptureDraftExpression[];
  starts_timer: boolean;
  elapsed_seconds: number | null;
  duration_seconds: number;
  scalable_amounts: { unit: string; value: number }[];
  description_source: string;
  description_template: string;
  duration_is_stated: boolean;
  // Present on every captured response.draft.steps entry (DraftStep.
  // preview_text, parser.ts) but unused by the amount/timing reconstruction
  // above — typed here only so gate-replay.ts's rendered-text diff (Phase G,
  // plans/020 §4) can read it without an `any` cast.
  preview_text?: string;
};

export type CaptureExtractedAmount = AmountProvenance;

export type CaptureExtraction = {
  extracted_amounts: CaptureExtractedAmount[];
  total_brew_time_seconds: number | null;
  // The extraction response carries several other fields (name, notes,
  // grind_size, preparation, water_amount, short_description, ...) that
  // this harness never reads. Typed loosely rather than duplicating
  // extractionSchema's full shape here.
  [key: string]: unknown;
};

export type CaptureValidationIssue = {
  code: string;
  field?: string;
  message: string;
};

export type CaptureResponse = {
  draft: { steps: CaptureDraftStep[] };
  extraction: CaptureExtraction;
  validation: { issues: CaptureValidationIssue[]; is_publishable: boolean };
  warnings?: string[];
};

/**
 * One recorded attempt at a stage, projected down to what this harness
 * needs (see the fetch query documented in README.md): identity
 * (attempt/provider/model), the transport/schema-validation `error` a
 * provider call surfaced (mirrors createStageAttemptRecorder's `error`
 * field, parser.ts:6298-6327), and that attempt's full, schema-validated
 * `parsed` output (`result` from `input.schema.parse(parsedJson)` inside
 * `invokeJson`, parser.ts ~2064-2069 — the SAME object
 * `createStageAttemptRecorder` stores verbatim as `StageCaptureEntry.parsed`
 * and the DB persists whole in `service.parse_user_recipe_draft_captures
 * .stage_outputs`).
 *
 * FIDELITY FIX (Phase G, plans/020 §4): an earlier version of this type
 * only carried a stage attempt's `extracted_amounts` — enough to replay
 * verifyAmountProvenance/verifyTimingProvenance in isolation (replay.ts),
 * but NOT enough to reconstruct finalizeDraftResponse's actual input,
 * which needs the attempt's full `steps`/`recipe`/`localization`/
 * `warnings`/`detected_input_language` (normalization/repair) or
 * `steps`/`warnings` (cumulative_rewrite). `parsed` now carries the whole
 * object; gate-reconstruct.ts derives `extracted_amounts` from
 * `parsed.extracted_amounts` when it needs the amount-only view.
 * cumulative_rewrite attempts' `parsed` never carries `extracted_amounts`
 * at all (cumulativeRewriteSchema has no such field — parser.ts:261-264).
 */
export type StageAttempt = {
  attempt: number;
  provider: unknown;
  model: unknown;
  error: string | null;
  parsed?: Record<string, unknown> | null;
  // DEPRECATED, read-only-for-backward-compat: the pre-Phase-G cache
  // projection carried only this field (no `parsed`). Captures fetched
  // before 2026-08-13 (the original 31; see README.md) are still cached in
  // this shape and are NOT gate-replayable (gate-reconstruct.ts reports
  // them as such, by name) — but their amount-only provenance.ts replay
  // (replay.ts, selectAmountProvenanceSource below) must keep working
  // unchanged, so this field is read as a fallback whenever `parsed` is
  // absent. Never populated by a fresh fetch; new cache entries only ever
  // set `parsed`.
  extracted_amounts?: CaptureExtractedAmount[] | null;
};

export type CaptureStageOutputs = {
  extraction: StageAttempt[];
  normalization: StageAttempt[];
  repair: StageAttempt[];
  cumulative_rewrite: StageAttempt[];
};

export type CaptureRow = {
  id: string;
  request_mode: string;
  request_text: string;
  // Phase G (plans/020 §4): needed by gate-reconstruct.ts to reproduce
  // resolveBrewingMethodId's/getMissingSourceOnlyFields' inputs faithfully.
  // Absent on captures cached before this fidelity fix; gate-reconstruct.ts
  // treats a missing value the same as the live request did (undefined/
  // null, i.e. "no hint supplied"), which is what production actually saw
  // whenever the capture predates this column being selected.
  request_brewing_method_id?: string | null;
  request_source_language_hint?: string | null;
  response: CaptureResponse;
  // Per-stage attempts, projected to {attempt, provider, model, error,
  // parsed} — see fetch.ts / README.md for the exact query. Absent for a
  // capture cached before the 2026-08-12 fidelity fix;
  // `selectAmountProvenanceSource` degrades to raw extraction, LABELLED,
  // when this is missing. A capture whose stage_outputs predates the
  // Phase G fidelity fix (parsed-per-attempt, not just extracted_amounts)
  // cannot be gate-replayed at all — see gate-reconstruct.ts.
  stage_outputs?: CaptureStageOutputs;
};

// ---------------------------------------------------------------------
// Provenance-record sourcing — the fidelity fix itself.

export type AmountProvenanceSourceStage =
  | "repair"
  | "normalization"
  | "extraction";

export type AmountProvenanceSource = {
  records: CaptureExtractedAmount[];
  sourceStage: AmountProvenanceSourceStage;
  /**
   * True whenever the records ultimately came from raw
   * `response.extraction.extracted_amounts` — whether because that is
   * where production's own precedence lands (repair ran but re-emitted an
   * empty array), or because this harness's cache lacks the
   * `stage_outputs` needed to do better. `reason` disambiguates which.
   * The CLI must never let this be silent (plans/016 task brief,
   * "Make the fallback visible, never silent").
   */
  fellBackToRawExtraction: boolean;
  /** Human-readable explanation, always printed by the CLI. */
  reason: string;
  /** True when repair had >1 non-erroring attempt (see the "known
   * approximation" doc above) — a signal this capture's "last successful
   * attempt" pick is less trustworthy than usual. */
  ambiguousRepairAttempts: boolean;
};

/**
 * The last attempt with no recorded transport/schema error, scanning from
 * the end. See the module-doc "KNOWN APPROXIMATION" above for what this
 * does and does not prove about production's own accept/reject decision.
 */
function lastAttemptWithoutError(
  attempts: StageAttempt[] | undefined,
): StageAttempt | null {
  if (!attempts || attempts.length === 0) return null;
  for (let index = attempts.length - 1; index >= 0; index--) {
    if (!attempts[index].error) return attempts[index];
  }
  return null;
}

function countNonErroringAttempts(attempts: StageAttempt[] | undefined) {
  if (!attempts) return 0;
  return attempts.filter((attempt) => !attempt.error).length;
}

/** Reads an attempt's extracted_amounts from whichever shape this cache
 * entry actually carries — the current full-`parsed` format, or the
 * legacy amount-only projection (see StageAttempt's `extracted_amounts`
 * doc comment). Prefers `parsed` when both are somehow present. */
function attemptExtractedAmounts(
  attempt: StageAttempt,
): CaptureExtractedAmount[] {
  if (attempt.parsed) {
    return (attempt.parsed.extracted_amounts as
      | CaptureExtractedAmount[]
      | undefined) ?? [];
  }
  return attempt.extracted_amounts ?? [];
}

export function selectAmountProvenanceSource(
  capture: CaptureRow,
): AmountProvenanceSource {
  const extractionRecords = capture.response.extraction.extracted_amounts ??
    [];
  const stageOutputs = capture.stage_outputs;

  if (!stageOutputs) {
    return {
      records: extractionRecords,
      sourceStage: "extraction",
      fellBackToRawExtraction: true,
      reason:
        "this capture's cache entry has no stage_outputs (cached before the 2026-08-12 fidelity fix, or fetched without per-stage attempts) — falling back to raw extraction. This is a HARNESS gap, not necessarily what production did: if repair or normalization re-emitted corrected step_index values live, this capture cannot reproduce that until re-fetched.",
      ambiguousRepairAttempts: false,
    };
  }

  const repairAmbiguous = countNonErroringAttempts(stageOutputs.repair) > 1;
  const repairAttempt = lastAttemptWithoutError(stageOutputs.repair);

  if (repairAttempt) {
    const repairRecords = attemptExtractedAmounts(repairAttempt);
    if (repairRecords.length > 0) {
      return {
        records: repairRecords,
        sourceStage: "repair",
        fellBackToRawExtraction: false,
        reason:
          `sourced from repair attempt #${repairAttempt.attempt} (${repairRecords.length} record(s))` +
          (repairAmbiguous
            ? " — NOTE: repair had more than one non-erroring attempt; this harness picked the LAST one, which is an approximation of production's true accept/reject logic (see reconstruct.ts module doc)."
            : ""),
        ambiguousRepairAttempts: repairAmbiguous,
      };
    }
    // Repair ran and (per this harness's error-based proxy) appears to
    // have succeeded, but re-emitted an EMPTY extracted_amounts.
    // Production's applyExtractionFallbacks (parser.ts:4399-4401)
    // bypasses normalization entirely in this exact case and falls
    // straight to raw extraction — it does NOT reconsider
    // normalization's own (possibly non-empty) copy. This branch is
    // therefore a FAITHFUL reproduction of production, not an
    // approximation gap.
    return {
      records: extractionRecords,
      sourceStage: "extraction",
      fellBackToRawExtraction: true,
      reason:
        "repair ran and its last non-erroring attempt re-emitted an EMPTY extracted_amounts; production's applyExtractionFallbacks bypasses normalization in exactly this case and falls straight to raw extraction (parser.ts:4399-4401) — this fallback is faithful to production, not a harness approximation.",
      ambiguousRepairAttempts: repairAmbiguous,
    };
  }

  const normalizationAttempt = lastAttemptWithoutError(
    stageOutputs.normalization,
  );
  if (normalizationAttempt) {
    const normalizationRecords = attemptExtractedAmounts(
      normalizationAttempt,
    );
    if (normalizationRecords.length > 0) {
      return {
        records: normalizationRecords,
        sourceStage: "normalization",
        fellBackToRawExtraction: false,
        reason:
          `sourced from normalization attempt #${normalizationAttempt.attempt} (${normalizationRecords.length} record(s)); repair did not run` +
          (stageOutputs.repair && stageOutputs.repair.length > 0
            ? " successfully (every repair attempt recorded an error)"
            : " (repair stage was not invoked)"),
        ambiguousRepairAttempts: repairAmbiguous,
      };
    }
  }

  return {
    records: extractionRecords,
    sourceStage: "extraction",
    fellBackToRawExtraction: true,
    reason:
      "neither repair nor normalization re-emitted a non-empty extracted_amounts array (both empty, absent, or every attempt errored) — falling back to raw extraction, matching applyExtractionFallbacks' own final fallback (parser.ts:4399-4401).",
    ambiguousRepairAttempts: repairAmbiguous,
  };
}

// ---------------------------------------------------------------------
// Rendered-amount reconstruction.
//
// This is a deliberately independent reimplementation of parser.ts's
// buildRenderedAmountsFromDraftSteps (parser.ts:5074-5120) — reimplemented,
// not imported, because parser.ts is owned by Agent B in plans/016 and this
// harness may run while Agent B is mid-edit. Kept as close to the original
// logic as possible and the divergence is documented below.
//
// Source of truth for each step's amounts, in order of preference:
//   1. step.expressions[] — the response.draft already carries these
//      precomputed (preview_value, unit) exactly as parser.ts computed them.
//      This is EXACT, not approximated.
//   2. Literal numbers left in description_template after expressions are
//      stripped — approximated here with a small unit-alternation list
//      (ASCII + the scripts seen in Phase 0 captures) rather than importing
//      parser.ts's full SCALABLE_UNITS. None of the Q1-Q3 findings this
//      harness was built to reproduce depended on this path (they were all
//      expression-based), so it is best-effort only. A capture whose
//      literal-number amounts don't get picked up here will under-report
//      findings relative to production — flagged in the CLI output.

const EXPRESSION_TOKEN_REGEX =
  /\(([\d.]+)\s*(?:x|×)\s*<(final_coffee_amount|final_water_amount)>\)\s*([^\s<>()]*)?/gi;

/** Best-effort literal-unit alternation. See module doc above. */
const LITERAL_UNIT_WORDS = [
  "g",
  "gr",
  "gram",
  "grams",
  "gramme",
  "grammes",
  "ml",
  "milliliter",
  "milliliters",
  "millilitre",
  "millilitres",
  "г",
  "гр",
  "мл",
  "جرام",
  "جرامات",
  "غ",
  "مل",
  "گرم",
  "میلی‌لیتر",
];
const LITERAL_UNIT_ALTERNATION = LITERAL_UNIT_WORDS
  .slice()
  .sort((left, right) => right.length - left.length)
  .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const LITERAL_NUMERIC_AMOUNT_REGEX = new RegExp(
  `\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(${LITERAL_UNIT_ALTERNATION})(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);

function normalizeExpressionUnitLike(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (normalized === "gram" || normalized === "grams") return "g";
  if (
    normalized === "milliliter" || normalized === "milliliters" ||
    normalized === "millilitre" || normalized === "millilitres"
  ) {
    return "ml";
  }
  return unit;
}

function usesCumulativeWaterLanguageLike(template: string): boolean {
  const normalized = template
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return /\b(?:up to|total|pour to|pour until|pour till|reach|reaching)\b/i
    .test(normalized);
}

/** True count of matches lost to the literal-unit-list approximation. */
export type RenderedAmountsResult = {
  amounts: RenderedAmount[];
  /** Set when a step had a bare number the literal-number regex couldn't
   * classify — a signal the approximation may be under-reporting. */
  unmatchedLiteralNumbers: { stepIndex: number; snippet: string }[];
};

export function buildRenderedAmounts(
  steps: CaptureDraftStep[],
): RenderedAmountsResult {
  const amounts: RenderedAmount[] = [];
  const unmatchedLiteralNumbers: { stepIndex: number; snippet: string }[] =
    [];

  steps.forEach((step, stepIndex) => {
    const isCumulativeStep = usesCumulativeWaterLanguageLike(
      step.description_template,
    );

    for (const expression of step.expressions) {
      if (expression.preview_value === null) continue;
      amounts.push({
        step_index: stepIndex,
        value: expression.preview_value,
        unit: normalizeExpressionUnitLike(expression.unit),
        is_cumulative_water: isCumulativeStep &&
          expression.placeholder === "<final_water_amount>",
      });
    }

    const withoutExpressions = step.description_template.replace(
      EXPRESSION_TOKEN_REGEX,
      " ",
    );
    for (
      const match of withoutExpressions.matchAll(LITERAL_NUMERIC_AMOUNT_REGEX)
    ) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) continue;
      amounts.push({
        step_index: stepIndex,
        value,
        unit: normalizeExpressionUnitLike(match[2] ?? ""),
        is_cumulative_water: false,
      });
    }
  });

  return { amounts, unmatchedLiteralNumbers };
}

export function buildTimingInputs(steps: CaptureDraftStep[]): {
  renderedSteps: RenderedTimingStep[];
  landmarks: TimingLandmark[];
} {
  const renderedSteps: RenderedTimingStep[] = steps.map((step, index) => ({
    step_index: index,
    kind: step.kind,
    duration_seconds: step.duration_seconds,
  }));

  const landmarks: TimingLandmark[] = [];
  steps.forEach((step, index) => {
    if (step.duration_is_stated) {
      landmarks.push({
        step_index: index,
        kind: "duration",
        seconds: step.duration_seconds,
      });
    }
    if (step.elapsed_seconds !== null) {
      landmarks.push({
        step_index: index,
        kind: "elapsed",
        seconds: step.elapsed_seconds,
      });
    }
  });

  return { renderedSteps, landmarks };
}
