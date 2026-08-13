// Phase G (plans/020-provenance-oracle-hardening.md §4) — builds
// finalizeDraftResponse's actual input from a capture row and runs the REAL
// gate, via parser.ts's `replayFinalizeDraftResponseFromStageOutputs` (the
// one new export parser.ts gained for this phase — see that function's
// module-doc comment for exactly what it does and does not approximate).
//
// This file does none of the merge judgement itself — it only reshapes a
// CaptureRow's `stage_outputs` into the flat per-stage attempt arrays that
// function expects, and supplies the request-context fields
// (brewingMethods, brewingMethodHint, mode, requestText) it needs but a
// capture row does not carry inline for every field.
//
// OWNERSHIP: scripts/recipe-draft-replay/ (this whole directory). Imports
// only parser.ts's exported surface — never provenance.ts, handler.ts,
// index.ts, or fixtures/.
import {
  type BrewingMethodOption,
  type ParseUserRecipeDraftResponse,
  type RecipeDraftParserMode,
  type ReplayDiagnostics,
  type ReplayStageAttempt,
  type ReplayStageOutputsInput,
  ReplayReconstructionError,
  replayFinalizeDraftResponseFromStageOutputs,
} from "../../supabase/functions/parse-user-recipe-draft/parser.ts";
import type { CaptureRow, StageAttempt } from "./reconstruct.ts";

// Neither of these affects is_publishable/validation.issues — userId only
// ever lands in `draft.recipe.vendor_id`/publish_projection, and nowMs only
// ever lands in publish_projection timestamps. Fixed, clearly-labelled
// placeholders rather than reading real values off the capture (which does
// not carry user_id at all in this harness's projection — see fetch.ts) so
// nobody mistakes replayed output for a real user's data.
export const REPLAY_USER_ID = "00000000-0000-0000-0000-000000000000";
export const REPLAY_NOW_MS = 1_755_000_000_000; // fixed, arbitrary, deterministic

export type GateReplayResult =
  | {
    ok: true;
    response: ParseUserRecipeDraftResponse;
    diagnostics: ReplayDiagnostics;
  }
  | { ok: false; error: string };

function toReplayAttempts(attempts: StageAttempt[] | undefined): {
  attempts: ReplayStageAttempt[];
  /** True when the stage had recorded attempts but NONE carry a `.parsed`
   * object — i.e. this cache entry predates the Phase G fidelity fix (only
   * `extracted_amounts` was projected, not the full parsed object). A
   * caller must treat this as UNRECONSTRUCTABLE, not as "stage never ran". */
  missingParsedField: boolean;
} {
  if (!attempts || attempts.length === 0) {
    return { attempts: [], missingParsedField: false };
  }
  const hasAnyParsed = attempts.some((a) =>
    a.parsed !== undefined && a.parsed !== null
  );
  const hasAnyNonErroring = attempts.some((a) => !a.error);
  return {
    attempts: attempts.map((a) => ({
      provider: String(a.provider ?? "unknown"),
      model: String(a.model ?? "unknown"),
      error: a.error,
      parsed: a.parsed ?? null,
    })),
    // Only a real gap if there's a non-erroring attempt with no `parsed` at
    // all — an attempt that genuinely errored legitimately has no parsed
    // output in production either, so that alone is not a fidelity gap.
    missingParsedField: hasAnyNonErroring && !hasAnyParsed,
  };
}

/**
 * Builds `replayFinalizeDraftResponseFromStageOutputs`'s input from a
 * capture row and brewing-methods list, then calls it. Returns `ok: false`
 * with a plain-English reason — never a plausible-looking substitute —
 * whenever the capture's `stage_outputs` genuinely cannot support a
 * faithful gate replay. Known gap classes, all surfaced by name:
 *
 *   1. No `stage_outputs` at all (pre-2026-08-12 cache entry).
 *   2. `stage_outputs` present but only the old amount-only projection
 *      (`extracted_amounts` per attempt, no `.parsed`) — cached before the
 *      Phase G fidelity fix. This is the MOST LIKELY gap for any capture
 *      fetched before this phase; re-fetch with fetch.ts's current query
 *      (see README.md) to close it.
 *   3. Every extraction/normalization attempt errored or fails schema
 *      re-validation — `replayFinalizeDraftResponseFromStageOutputs` itself
 *      throws `ReplayReconstructionError` for this; caught here and
 *      reported the same way.
 */
export function replayGateForCapture(
  capture: CaptureRow,
  brewingMethods: BrewingMethodOption[],
): GateReplayResult {
  const stageOutputs = capture.stage_outputs;
  if (!stageOutputs) {
    return {
      ok: false,
      error:
        "no stage_outputs at all in this cache entry (pre-fidelity-fix capture, or fetched with the wrong columns) — cannot reconstruct extraction/normalization, let alone repair/cumulative_rewrite. Re-fetch this capture.",
    };
  }

  const extraction = toReplayAttempts(stageOutputs.extraction);
  const normalization = toReplayAttempts(stageOutputs.normalization);
  const repair = toReplayAttempts(stageOutputs.repair);
  const cumulativeRewrite = toReplayAttempts(stageOutputs.cumulative_rewrite);

  const missingParsedStages = [
    extraction.missingParsedField && "extraction",
    normalization.missingParsedField && "normalization",
    repair.missingParsedField && "repair",
    cumulativeRewrite.missingParsedField && "cumulative_rewrite",
  ].filter((s): s is string => Boolean(s));

  if (missingParsedStages.length > 0) {
    return {
      ok: false,
      error:
        `this capture's stage_outputs.{${
          missingParsedStages.join(", ")
        }} has non-erroring attempts but no \`.parsed\` field on any of them — this is the OLD amount-only cache projection from before the Phase G fidelity fix (parsed-per-attempt), not a genuine data gap. Re-fetch this capture with the current fetch.ts query to close it.`,
    };
  }

  const stageOutputsInput: ReplayStageOutputsInput = {
    extraction: extraction.attempts,
    normalization: normalization.attempts,
    repair: repair.attempts,
    cumulative_rewrite: cumulativeRewrite.attempts,
  };

  const mode: RecipeDraftParserMode = capture.request_mode === "verify"
    ? "verify"
    : "extract";

  try {
    const { response, diagnostics } = replayFinalizeDraftResponseFromStageOutputs({
      stageOutputs: stageOutputsInput,
      requestText: capture.request_text,
      mode,
      brewingMethods,
      brewingMethodHint: capture.request_brewing_method_id ?? undefined,
      sourceLanguageHint: capture.request_source_language_hint ?? undefined,
      userId: REPLAY_USER_ID,
      nowMs: REPLAY_NOW_MS,
    });
    return { ok: true, response, diagnostics };
  } catch (error) {
    if (error instanceof ReplayReconstructionError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
