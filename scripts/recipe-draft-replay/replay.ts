#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
// Phase 0 (plans/016-publish-gate-correction.md) — offline replay CLI.
//
// Re-runs provenance.ts's verifyAmountProvenance/verifyTimingProvenance, AS
// CURRENTLY WRITTEN, against cached `parse_user_recipe_draft_captures` rows,
// and prints a per-capture verdict plus every finding next to the record(s)
// it failed against. Built so that after Phases 1-4 land fixes in
// provenance.ts/parser.ts, re-running this same command against the same
// capture ids proves exit criterion 3 (plans/016 §6): specific captures flip
// blocked<->publishable, and every PASS/control stays unchanged.
//
// USAGE
//   deno run --allow-read scripts/recipe-draft-replay/replay.ts <id> [<id> ...]
//   deno run --allow-read scripts/recipe-draft-replay/replay.ts --all
//   deno run --allow-read scripts/recipe-draft-replay/replay.ts --all --verbose
//
// Reads scripts/recipe-draft-replay/cache/captures.json by default (a
// {[id]: CaptureRow} map). Pass --cache <path> to point elsewhere. This
// harness NEVER calls the live Supabase MCP tools itself — it only reads
// whatever JSON has already been cached (see fetch.ts / the module doc
// there for how the cache is populated). Nothing here writes to
// service.parse_user_recipe_draft_captures.
//
// ===========================================================================
// COVERAGE LIMITATION — READ BEFORE TRUSTING A GREEN RESULT
// ===========================================================================
// This harness calls ONLY provenance.ts's verifyAmountProvenance and
// verifyTimingProvenance. It does NOT run parser.ts's finalizeDraftResponse,
// which is where the actual publish/block DECISION is made. Confirmed by
// reading parser.ts directly (2026-08-12), finalizeDraftResponse wraps
// provenance.ts with THREE mechanisms this harness cannot reproduce:
//
//   1. Fold-index remap (D2/Phase 4, parser.ts ~5978-5990,
//      `foldedDraftSteps.remapStepIndex`) — runs BEFORE
//      verifyAmountProvenance, rewriting each record's step_index to
//      account for pre-timer steps folded into preparation. This harness
//      passes each stage's RAW step_index straight through unchanged, so a
//      capture whose only defect is fold-index drift (the Hario full
//      transcript captures) will show blocked here even when production
//      now correctly remaps and publishes it.
//   2. Range-collapse detection (D4/Phase 3a, parser.ts ~5983-5990,
//      `findRangeEndpointCollapseIssues`) — a SEPARATE check from
//      verifyAmountProvenance entirely; this harness never calls it, so a
//      silently-collapsed range (Chemex, Spanish) will show ZERO amount
//      findings here even when production now blocks it.
//   3. Timing severity gate (D5/Phase 3b, parser.ts ~6172-6196,
//      `isTotalBrewTimeMismatchSevere`) — decides whether a
//      `total_brew_time_mismatch` finding BLOCKS or only warns in extract
//      mode. This harness's verifyTimingProvenance call DOES compute and
//      print the same finding (provenance.ts's own logic is untouched),
//      but has no equivalent severity gate, so it cannot tell you whether
//      production now blocks on it.
//
// A "still blocked"/"still publishable" result for a capture affected by
// any of the three mechanisms above is a HARNESS COVERAGE GAP, not
// necessarily evidence the underlying fix is missing — see
// expectations.ts's `harnessCanReplayFix` field, which is false for every
// such capture, and README.md "Coverage limitation" for what porting the
// rest would cost. Only captures whose fix lives ENTIRELY inside
// provenance.ts (the Phase 1a unit lexicon — Arabic/Persian/German) are
// fully provable by this harness alone.
// ===========================================================================

import {
  type ProvenanceFinding,
  type TimingProvenanceFinding,
  verifyAmountProvenance,
  verifyTimingProvenance,
} from "../../supabase/functions/parse-user-recipe-draft/provenance.ts";
import {
  type AmountProvenanceSource,
  buildRenderedAmounts,
  buildTimingInputs,
  type CaptureRow,
  type CaptureValidationIssue,
  selectAmountProvenanceSource,
} from "./reconstruct.ts";
import { lookupExpectation } from "./expectations.ts";

type Args = {
  ids: string[];
  all: boolean;
  verbose: boolean;
  cachePath: string;
};

function parseArgs(argv: string[]): Args {
  const ids: string[] = [];
  let all = false;
  let verbose = false;
  let cachePath = new URL("./cache/captures.json", import.meta.url).pathname;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--cache") {
      cachePath = argv[++i];
    } else if (!arg.startsWith("--")) {
      ids.push(arg);
    }
  }

  return { ids, all, verbose, cachePath };
}

async function loadCache(
  cachePath: string,
): Promise<Record<string, CaptureRow>> {
  const text = await Deno.readTextFile(cachePath);
  return JSON.parse(text) as Record<string, CaptureRow>;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * For display only: find the closest provenance record to a rendered value
 * BY VALUE ALONE (unit ignored), so a unit-mismatch finding can be shown
 * next to the record it most likely should have matched. This duplicates no
 * verification logic — verifyAmountProvenance's own matching (value AND
 * unit) is the actual result being reported; this is a diagnostic aid.
 */
function closestRecordByValue(
  records: ReturnType<typeof selectAmountProvenanceSource>["records"],
  value: number,
) {
  let best: (typeof records)[number] | null = null;
  let bestDelta = Infinity;
  for (const record of records) {
    const delta = Math.abs(record.value - value);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = record;
    }
  }
  return best;
}

function printAmountFinding(
  finding: ProvenanceFinding,
  renderedAmounts: ReturnType<typeof buildRenderedAmounts>["amounts"],
  records: ReturnType<typeof selectAmountProvenanceSource>["records"],
) {
  const rendered = renderedAmounts.find((r) =>
    r.step_index === finding.step_index
  );
  console.log(`    [${finding.code}] step_index=${finding.step_index}`);
  console.log(`      message: ${finding.message}`);
  if (rendered) {
    console.log(
      `      rendered side: value=${rendered.value} unit=${
        JSON.stringify(rendered.unit)
      } step_index=${rendered.step_index} is_cumulative_water=${rendered.is_cumulative_water}`,
    );
    const closest = closestRecordByValue(records, rendered.value);
    if (closest) {
      console.log(
        `      closest provenance record (by value): value=${closest.value} unit=${
          JSON.stringify(closest.unit)
        } step_index=${closest.step_index} provenance=${closest.provenance} rule=${closest.rule}`,
      );
    } else {
      console.log(`      closest provenance record: <none — records empty>`);
    }
  } else {
    console.log(
      `      (no reconstructed rendered amount at this step_index — likely a recipe-level (-1) finding or a reconstruction gap)`,
    );
  }
}

function printTimingFinding(finding: TimingProvenanceFinding) {
  console.log(`    [${finding.code}] step_index=${finding.step_index}`);
  console.log(`      message: ${finding.message}`);
}

function diffVerifyModeWording(capture: CaptureRow) {
  if (capture.request_mode !== "verify") return;
  console.log(`  --- verify-mode wording diff ---`);
  capture.response.draft.steps.forEach((step, index) => {
    const sourceInRequest = capture.request_text.includes(
      step.description_source,
    );
    const templateEqualsSource = step.description_template ===
      step.description_source;
    console.log(`    step[${index}] (${step.step_role}):`);
    console.log(
      `      description_source:   ${JSON.stringify(step.description_source)}`,
    );
    console.log(
      `      description_template: ${
        JSON.stringify(step.description_template)
      }`,
    );
    console.log(
      `      description_source verbatim in request_text: ${sourceInRequest}`,
    );
    console.log(
      `      description_template === description_source: ${templateEqualsSource}`,
    );
  });
}

// ---------------------------------------------------------------------
// Finding IDENTITY — fixes the masking bug this fidelity fix exists for.
//
// A count-only comparison ("captured 1 issue, replayed 1 finding") can
// look correct while the two are entirely different findings (a013c479:
// captured `unverifiable_amount` at step 2 vs a naively-sourced replay's
// `amount_step_binding_mismatch` at step 4 — both count 1, neither is the
// other). Identity is CODE + STEP_INDEX + VALUE, so a disappeared finding
// replaced by an unrelated new one can never look like a match.
//
// `field`/`message` on a captured validation.issues entry and `message` on
// a replayed ProvenanceFinding/TimingProvenanceFinding are both produced
// by the SAME deterministic message templates in provenance.ts (parser.ts
// copies a finding's `code`/`step_index`/`message` verbatim into a
// ValidationIssue — see parser.ts's `provenanceIssues`/
// `timingValidationIssues` construction). Parsing a leading number out of
// that message is therefore parsing OUR OWN system-generated English
// string, never LLM-authored source text — not the CLAUDE.md regex-over-
// meaning antipattern the rest of this codebase avoids.

type FindingIdentity = {
  code: string;
  stepIndex: number;
  value: number | null;
  message: string;
};

/** Every finding code either module can produce. Anything else on a
 * captured validation issue (missing_water_temp, missing_brewing_method,
 * ...) is a different validation category this harness does not replay at
 * all, and is reported separately rather than folded into this
 * comparison. */
const KNOWN_G22_CODES = new Set<string>([
  "unverifiable_amount",
  "amount_provenance_mismatch",
  "unsupported_derivation_rule",
  "inferred_amount_not_permitted",
  "amount_step_binding_mismatch",
  "non_monotonic_cumulative",
  "total_brew_time_mismatch",
  "stated_duration_changed",
  "elapsed_landmark_mismatch",
]);

function parseLeadingValue(message: string): number | null {
  // "Step N states V<unit>, which does not trace..." / "Step N states a
  // duration of Vs..." / "Step N should begin at Vs elapsed..."
  let match = message.match(/^Step \d+ (?:states(?: a duration of)?|should begin at) (-?[\d.]+)/);
  if (match) return Number(match[1]);
  // "V<unit> was recorded for step..." / "V<unit> is marked..." /
  // "V<unit> cites..." / "V<unit> claims..." / "V<unit> could not..." /
  // "V<unit> does not match..."
  match = message.match(/^(-?[\d.]+)/);
  if (match) return Number(match[1]);
  // "Cumulative water does not increase from X to Y at step N" — the
  // OFFENDING value is Y, the one that failed to increase.
  match = message.match(/does not increase from -?[\d.]+ to (-?[\d.]+)/);
  if (match) return Number(match[1]);
  // "The source states a total brew time of Xs, but the final brew steps
  // sum to Ys." — the offending/emitted value is Y.
  match = message.match(/sum to (-?[\d.]+)s/);
  if (match) return Number(match[1]);
  return null;
}

function stepIndexFromField(field: string | undefined): number {
  if (!field) return -1;
  const match = field.match(/steps\[(\d+)\]/);
  return match ? Number(match[1]) : -1;
}

function capturedG22Findings(
  issues: CaptureValidationIssue[],
): { known: FindingIdentity[]; other: CaptureValidationIssue[] } {
  const known: FindingIdentity[] = [];
  const other: CaptureValidationIssue[] = [];
  for (const issue of issues) {
    if (!KNOWN_G22_CODES.has(issue.code)) {
      other.push(issue);
      continue;
    }
    known.push({
      code: issue.code,
      stepIndex: stepIndexFromField(issue.field),
      value: parseLeadingValue(issue.message),
      message: issue.message,
    });
  }
  return { known, other };
}

function replayedG22Findings(
  amountFindings: ProvenanceFinding[],
  timingFindings: TimingProvenanceFinding[],
): FindingIdentity[] {
  return [
    ...amountFindings.map((f) => ({
      code: f.code,
      stepIndex: f.step_index,
      value: parseLeadingValue(f.message),
      message: f.message,
    })),
    ...timingFindings.map((f) => ({
      code: f.code,
      stepIndex: f.step_index,
      value: parseLeadingValue(f.message),
      message: f.message,
    })),
  ];
}

function identityKey(id: FindingIdentity): string {
  return `${id.code}@step${id.stepIndex}=${id.value ?? "?"}`;
}

function diffFindingIdentities(
  captured: FindingIdentity[],
  replayed: FindingIdentity[],
): {
  matched: FindingIdentity[];
  capturedOnly: FindingIdentity[];
  replayedOnly: FindingIdentity[];
} {
  const replayedKeys = new Map(replayed.map((f) => [identityKey(f), f]));
  const capturedKeys = new Set(captured.map(identityKey));

  const matched: FindingIdentity[] = [];
  const capturedOnly: FindingIdentity[] = [];
  for (const finding of captured) {
    const key = identityKey(finding);
    if (replayedKeys.has(key)) {
      matched.push(finding);
    } else {
      capturedOnly.push(finding);
    }
  }
  const replayedOnly = replayed.filter((f) =>
    !capturedKeys.has(identityKey(f))
  );

  return { matched, capturedOnly, replayedOnly };
}

function printSourceInfo(source: AmountProvenanceSource) {
  const label = source.fellBackToRawExtraction
    ? "!! FALLBACK TO RAW EXTRACTION"
    : `sourced from ${source.sourceStage}`;
  console.log(`  provenance source: ${label}`);
  console.log(`    ${source.reason}`);
  if (source.ambiguousRepairAttempts) {
    console.log(
      `    ! repair had multiple non-erroring attempts — "last successful attempt" is an approximation here (see reconstruct.ts doc).`,
    );
  }
}

async function main() {
  const args = parseArgs(Deno.args);
  const cache = await loadCache(args.cachePath);

  const ids = args.all ? Object.keys(cache).sort() : args.ids;
  if (ids.length === 0) {
    console.error(
      "Usage: replay.ts <capture-id> [<capture-id> ...] | --all [--verbose] [--cache <path>]",
    );
    Deno.exit(1);
  }

  console.log(
    "=".repeat(78) +
      "\nCOVERAGE LIMITATION: this harness replays ONLY provenance.ts " +
      "(verifyAmountProvenance/verifyTimingProvenance).\nIt does NOT run " +
      "parser.ts's finalizeDraftResponse, so fold-index remap (D2/Phase 4), " +
      "range-collapse\ndetection (D4/Phase 3a) and the timing severity gate " +
      "(D5/Phase 3b) are NOT exercised, even though\nall three are " +
      "confirmed already landed in parser.ts as of 2026-08-12. See the " +
      "header comment above\nmain() and expectations.ts's " +
      "`harnessCanReplayFix` field for exactly which captures this affects.\n" +
      "=".repeat(78),
  );

  const verdictRows: {
    id: string;
    mode: string;
    sourceStage: string;
    fellBack: boolean;
    capturedPublishable: boolean;
    capturedIssueCount: number;
    replayedAmountFindings: number;
    replayedTimingFindings: number;
    replayedUnverified: boolean;
    identityMatched: number;
    identityCapturedOnly: number;
    identityReplayedOnly: number;
    expectation: string;
    harnessCanReplayFix: boolean;
    reason: string;
  }[] = [];

  for (const id of ids) {
    const capture = cache[id];
    if (!capture) {
      console.error(`!! capture ${id} not found in cache (${args.cachePath})`);
      continue;
    }

    console.log(
      `\n=== ${id} (${capture.request_mode}) ==================================`,
    );

    const source = selectAmountProvenanceSource(capture);
    printSourceInfo(source);

    const records = source.records;
    const { amounts: renderedAmounts, unmatchedLiteralNumbers } =
      buildRenderedAmounts(capture.response.draft.steps);
    const { renderedSteps, landmarks } = buildTimingInputs(
      capture.response.draft.steps,
    );

    const amountResult = verifyAmountProvenance({
      requestText: capture.request_text,
      renderedAmounts,
      provenance: records,
    });
    const timingResult = verifyTimingProvenance({
      statedTotalBrewTimeSeconds:
        capture.response.extraction.total_brew_time_seconds,
      renderedSteps,
      landmarks,
    });

    const capturedIssues = capture.response.validation.issues;
    const { known: capturedKnown, other: capturedOther } =
      capturedG22Findings(capturedIssues);
    const replayedKnown = replayedG22Findings(
      amountResult.findings,
      timingResult.findings,
    );
    const { matched, capturedOnly, replayedOnly } = diffFindingIdentities(
      capturedKnown,
      replayedKnown,
    );

    console.log(
      `  captured:  is_publishable=${capture.response.validation.is_publishable} issues=${capturedIssues.length} (${capturedKnown.length} G22-coded, ${capturedOther.length} other)`,
    );
    console.log(
      `  replayed:  amount_findings=${amountResult.findings.length} timing_findings=${timingResult.findings.length} unverified=${amountResult.unverified}`,
    );
    console.log(
      `  identity match: ${matched.length} matched, ${capturedOnly.length} captured-only (disappeared), ${replayedOnly.length} replayed-only (new)`,
    );
    if (capturedOnly.length > 0) {
      console.log(`    captured-only (present at capture time, gone now):`);
      for (const f of capturedOnly) {
        console.log(`      [${identityKey(f)}] ${f.message}`);
      }
    }
    if (replayedOnly.length > 0) {
      console.log(`    replayed-only (new, not present at capture time):`);
      for (const f of replayedOnly) {
        console.log(`      [${identityKey(f)}] ${f.message}`);
      }
    }
    if (capturedOther.length > 0) {
      console.log(
        `    other captured validation issues (not G22-coded, not replayed by this harness):`,
      );
      for (const issue of capturedOther) {
        console.log(`      [${issue.code}] ${issue.message}`);
      }
    }

    if (unmatchedLiteralNumbers.length > 0) {
      console.log(
        `  ! reconstruction gap: ${unmatchedLiteralNumbers.length} literal number(s) in description_template could not be classified by this harness's approximate unit list (see reconstruct.ts doc). Findings below may under-report relative to production.`,
      );
    }

    if (args.verbose || amountResult.findings.length > 0) {
      console.log(`  provenance records (${records.length}, from ${source.sourceStage}):`);
      for (const record of records) {
        console.log(
          `    value=${record.value} unit=${
            JSON.stringify(record.unit)
          } step_index=${record.step_index} provenance=${record.provenance} rule=${record.rule} source_quote=${
            JSON.stringify(record.source_quote)
          }`,
        );
      }
      console.log(`  rendered amounts (${renderedAmounts.length}):`);
      for (const rendered of renderedAmounts) {
        console.log(
          `    value=${rendered.value} unit=${
            JSON.stringify(rendered.unit)
          } step_index=${rendered.step_index} is_cumulative_water=${rendered.is_cumulative_water}`,
        );
      }
    }

    if (amountResult.findings.length > 0) {
      console.log(`  amount findings:`);
      for (const finding of amountResult.findings) {
        printAmountFinding(finding, renderedAmounts, records);
      }
    }
    if (timingResult.findings.length > 0) {
      console.log(`  timing findings:`);
      for (const finding of timingResult.findings) {
        printTimingFinding(finding);
      }
    }

    diffVerifyModeWording(capture);

    const expectation = lookupExpectation(id);
    console.log(
      `  expectation: ${expectation.expectation} (depends on ${expectation.dependsOn}, harnessCanReplayFix=${expectation.harnessCanReplayFix})`,
    );
    console.log(`    ${expectation.reason}`);

    verdictRows.push({
      id,
      mode: capture.request_mode,
      sourceStage: source.sourceStage,
      fellBack: source.fellBackToRawExtraction,
      capturedPublishable: capture.response.validation.is_publishable,
      capturedIssueCount: capturedIssues.length,
      replayedAmountFindings: amountResult.findings.length,
      replayedTimingFindings: timingResult.findings.length,
      replayedUnverified: amountResult.unverified,
      identityMatched: matched.length,
      identityCapturedOnly: capturedOnly.length,
      identityReplayedOnly: replayedOnly.length,
      expectation: expectation.expectation,
      harnessCanReplayFix: expectation.harnessCanReplayFix,
      reason: expectation.reason,
    });
  }

  console.log(
    `\n\n=== verdict table ===========================================================`,
  );
  console.log(
    "id        mode     source          fallback  cap_pub  cap_iss  rep_amt  rep_tmg  ident(match/cap-only/rep-only)  expectation        provable",
  );
  for (const row of verdictRows) {
    console.log(
      `${shortId(row.id)}  ${row.mode.padEnd(7)}  ${
        row.sourceStage.padEnd(14)
      }  ${String(row.fellBack).padEnd(8)}  ${
        String(row.capturedPublishable).padEnd(7)
      }  ${String(row.capturedIssueCount).padEnd(7)}  ${
        String(row.replayedAmountFindings).padEnd(7)
      }  ${String(row.replayedTimingFindings).padEnd(7)}  ${
        `${row.identityMatched}/${row.identityCapturedOnly}/${row.identityReplayedOnly}`
          .padEnd(31)
      }  ${row.expectation.padEnd(17)}  ${row.harnessCanReplayFix}`,
    );
  }

  const fellBackRows = verdictRows.filter((row) => row.fellBack);
  console.log(
    `\nFell back to raw extraction: ${fellBackRows.length} of ${verdictRows.length} captures` +
      (fellBackRows.length > 0
        ? ` (${fellBackRows.map((row) => shortId(row.id)).join(", ")})`
        : ""),
  );

  const provable = verdictRows.filter((row) => row.harnessCanReplayFix);
  const notProvable = verdictRows.filter((row) => !row.harnessCanReplayFix);
  console.log(
    `Provable by this harness alone: ${provable.length}/${verdictRows.length}. ` +
      `NOT provable by this harness (fix confirmed landed in parser.ts, outside provenance.ts): ${notProvable.length}/${verdictRows.length}` +
      (notProvable.length > 0
        ? ` (${notProvable.map((row) => shortId(row.id)).join(", ")})`
        : ""),
  );
}

if (import.meta.main) {
  await main();
}
