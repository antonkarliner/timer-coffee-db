#!/usr/bin/env -S deno run --allow-read --allow-env
// Phase G (plans/020-provenance-oracle-hardening.md §4) — offline FULL-GATE
// replay CLI.
//
// Unlike replay.ts (which calls only provenance.ts's
// verifyAmountProvenance/verifyTimingProvenance, and therefore cannot see
// range_endpoint_collapsed, the fold-index remap, or the stated-total
// severity gate — see that file's "COVERAGE LIMITATION" header), this CLI
// calls the REAL finalizeDraftResponse, via parser.ts's exported
// `replayFinalizeDraftResponseFromStageOutputs`. Every validation issue
// code finalizeDraftResponse can emit is visible here, and is_publishable
// is the actual gate decision, not an approximation of it.
//
// USAGE
//   deno run --allow-read --allow-env scripts/recipe-draft-replay/gate-replay.ts <id> [<id> ...]
//   deno run --allow-read --allow-env scripts/recipe-draft-replay/gate-replay.ts --all
//   deno run --allow-read --allow-env scripts/recipe-draft-replay/gate-replay.ts --all --verbose
//
// Reads cache/captures.json and cache/brewing_methods.json by default.
// NEVER calls the live Supabase MCP tools or network — offline only, same
// contract as replay.ts.
import type { BrewingMethodOption } from "../../supabase/functions/parse-user-recipe-draft/parser.ts";
import type { CaptureRow, CaptureValidationIssue } from "./reconstruct.ts";
import { replayGateForCapture } from "./gate-reconstruct.ts";
import { lookupExpectation } from "./expectations.ts";

type Args = {
  ids: string[];
  all: boolean;
  verbose: boolean;
  cachePath: string;
  brewingMethodsPath: string;
};

function parseArgs(argv: string[]): Args {
  const ids: string[] = [];
  let all = false;
  let verbose = false;
  let cachePath = new URL("./cache/captures.json", import.meta.url).pathname;
  let brewingMethodsPath =
    new URL("./cache/brewing_methods.json", import.meta.url).pathname;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") all = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--cache") cachePath = argv[++i];
    else if (arg === "--brewing-methods") brewingMethodsPath = argv[++i];
    else if (!arg.startsWith("--")) ids.push(arg);
  }

  return { ids, all, verbose, cachePath, brewingMethodsPath };
}

async function loadJson<T>(path: string): Promise<T> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as T;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------
// Finding IDENTITY — code + step_index + value (or, when no numeric value
// can be parsed out of the message, the message text itself). Same
// discipline as replay.ts's own identity comparison (see that file's
// header comment for why count-only comparison is unsafe), extended to
// EVERY validation issue code finalizeDraftResponse can emit — not just
// the G22-coded ones — because Phase G's whole point is that the gate
// decision includes validateDraft's structural checks and
// range_endpoint_collapsed, not only amount/timing provenance.
//
// Every message parsed here is produced by parser.ts's own deterministic
// message templates (ValidationIssue.message), never LLM-authored source
// text — parsing a leading number out of OUR OWN system-generated English
// string is not the CLAUDE.md regex-over-meaning antipattern.

type FindingIdentity = {
  code: string;
  stepIndex: number;
  value: number | null;
  message: string;
};

function parseIdentityValue(code: string, message: string): number | null {
  // range_endpoint_collapsed: "The source states a range of 50-70g, but the
  // final draft only shows 50g — the other endpoint (70g) does not appear
  // anywhere in the draft." The OFFENDING (rendered, collapsed) value is
  // the one after "only shows".
  if (code === "range_endpoint_collapsed") {
    const match = message.match(/only shows (-?[\d.]+)/);
    if (match) return Number(match[1]);
  }
  // "Step N states V<unit>, which does not trace..." / "Step N states a
  // duration of Vs..." / "Step N should begin at Vs elapsed..."
  let match = message.match(
    /^Step \d+ (?:states(?: a duration of)?|should begin at) (-?[\d.]+)/,
  );
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

function toIdentities(
  issues: { code: string; field?: string; message: string }[],
): FindingIdentity[] {
  return issues.map((issue) => ({
    code: issue.code,
    stepIndex: stepIndexFromField(issue.field),
    value: parseIdentityValue(issue.code, issue.message),
    message: issue.message,
  }));
}

function identityKey(id: FindingIdentity): string {
  const valuePart = id.value !== null ? String(id.value) : JSON.stringify(id.message);
  return `${id.code}@step${id.stepIndex}=${valuePart}`;
}

function diffIdentities(
  captured: FindingIdentity[],
  replayed: FindingIdentity[],
): {
  matched: FindingIdentity[];
  capturedOnly: FindingIdentity[];
  replayedOnly: FindingIdentity[];
} {
  const replayedKeys = new Set(replayed.map(identityKey));
  const capturedKeys = new Set(captured.map(identityKey));
  const matched: FindingIdentity[] = [];
  const capturedOnly: FindingIdentity[] = [];
  for (const f of captured) {
    if (replayedKeys.has(identityKey(f))) matched.push(f);
    else capturedOnly.push(f);
  }
  const replayedOnly = replayed.filter((f) => !capturedKeys.has(identityKey(f)));
  return { matched, capturedOnly, replayedOnly };
}

async function main() {
  const args = parseArgs(Deno.args);
  const cache = await loadJson<Record<string, CaptureRow>>(args.cachePath);
  const brewingMethods = await loadJson<BrewingMethodOption[]>(
    args.brewingMethodsPath,
  );

  const ids = args.all ? Object.keys(cache).sort() : args.ids;
  if (ids.length === 0) {
    console.error(
      "Usage: gate-replay.ts <capture-id> [<capture-id> ...] | --all [--verbose] [--cache <path>] [--brewing-methods <path>]",
    );
    Deno.exit(1);
  }

  console.log(
    "=".repeat(78) +
      "\nFULL-GATE REPLAY: calls the real finalizeDraftResponse (parser.ts) via\n" +
      "replayFinalizeDraftResponseFromStageOutputs — is_publishable and every\n" +
      "validation.issues code below are the ACTUAL gate decision, not an\n" +
      "approximation of it. See gate-reconstruct.ts for exactly what is\n" +
      "reconstructed and replayGateForCapture's doc comment for known gaps.\n" +
      "=".repeat(78),
  );

  const verdictRows: {
    id: string;
    reconstructable: boolean;
    reconstructError: string;
    capturedPublishable: boolean | null;
    replayedPublishable: boolean | null;
    matched: number;
    capturedOnly: number;
    replayedOnly: number;
    expectation: string;
  }[] = [];

  for (const id of ids) {
    const capture = cache[id];
    console.log(
      `\n=== ${id} ${capture ? `(${capture.request_mode})` : "(NOT IN CACHE)"} ==================================`,
    );
    if (!capture) {
      console.error(`!! capture ${id} not found in cache (${args.cachePath})`);
      verdictRows.push({
        id,
        reconstructable: false,
        reconstructError: "not in cache",
        capturedPublishable: null,
        replayedPublishable: null,
        matched: 0,
        capturedOnly: 0,
        replayedOnly: 0,
        expectation: "unknown",
      });
      continue;
    }

    const result = replayGateForCapture(capture, brewingMethods);
    const expectation = lookupExpectation(id);

    if (!result.ok) {
      console.log(`  !! UNRECONSTRUCTABLE: ${result.error}`);
      verdictRows.push({
        id,
        reconstructable: false,
        reconstructError: result.error,
        capturedPublishable: capture.response.validation.is_publishable,
        replayedPublishable: null,
        matched: 0,
        capturedOnly: 0,
        replayedOnly: 0,
        expectation: expectation.expectation,
      });
      continue;
    }

    const { response, diagnostics } = result;
    console.log(
      `  sourcing: extraction=${
        diagnostics.extractionSource
          ? `attempt#${diagnostics.extractionSource.attemptIndex} (${diagnostics.extractionSource.provider}:${diagnostics.extractionSource.model})`
          : "?"
      } normalization=${
        diagnostics.normalizationSource
          ? `attempt#${diagnostics.normalizationSource.attemptIndex} (${diagnostics.normalizationSource.provider}:${diagnostics.normalizationSource.model})`
          : "?"
      }`,
    );
    console.log(
      `  repair: applied=${diagnostics.repairApplied} attemptsConsidered=${diagnostics.repairAttemptsConsidered}${
        diagnostics.repairSource
          ? ` acceptedAttempt#${diagnostics.repairSource.attemptIndex} (${diagnostics.repairSource.provider}:${diagnostics.repairSource.model})`
          : ""
      }`,
    );
    console.log(
      `  cumulative_rewrite: applied=${diagnostics.cumulativeRewriteApplied} attemptsConsidered=${diagnostics.cumulativeRewriteAttemptsConsidered}${
        diagnostics.cumulativeRewriteSource
          ? ` acceptedAttempt#${diagnostics.cumulativeRewriteSource.attemptIndex} (${diagnostics.cumulativeRewriteSource.provider}:${diagnostics.cumulativeRewriteSource.model})`
          : ""
      }`,
    );

    const capturedIssues: CaptureValidationIssue[] =
      capture.response.validation.issues;
    const capturedPublishable = capture.response.validation.is_publishable;
    const replayedIssues = response.validation.issues;
    const replayedPublishable = response.validation.is_publishable;

    const capturedIdentities = toIdentities(capturedIssues);
    const replayedIdentities = toIdentities(replayedIssues);
    const { matched, capturedOnly, replayedOnly } = diffIdentities(
      capturedIdentities,
      replayedIdentities,
    );

    console.log(
      `  captured: is_publishable=${capturedPublishable} issues=${capturedIssues.length}`,
    );
    console.log(
      `  replayed: is_publishable=${replayedPublishable} issues=${replayedIssues.length}`,
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
    if (args.verbose) {
      console.log(`    matched:`);
      for (const f of matched) {
        console.log(`      [${identityKey(f)}] ${f.message}`);
      }
    }

    // Some defects (D1's collapsed-range rendering, D2's mis-bound
    // multiplier) never surface as a validation.issues code at all — the
    // draft renders WRONG NUMBERS that G22 still traces cleanly, so the
    // only way to see them is the rendered text itself. Printed under
    // --verbose so a future phase can eyeball this without a one-off
    // script (see plans/020 §5 items 1/3's acceptance criteria).
    if (args.verbose) {
      const capturedSteps = capture.response.draft.steps;
      const replayedSteps = response.draft.steps;
      console.log(`    rendered steps (captured -> replayed preview_text):`);
      const maxLen = Math.max(capturedSteps.length, replayedSteps.length);
      for (let i = 0; i < maxLen; i++) {
        const capturedText = capturedSteps[i]?.preview_text ?? "<missing>";
        const replayedText = replayedSteps[i]?.preview_text ?? "<missing>";
        const marker = capturedText === replayedText ? "=" : "!=";
        console.log(`      [${i}] ${marker} ${JSON.stringify(capturedText)}`);
        if (marker === "!=") {
          console.log(`            -> ${JSON.stringify(replayedText)}`);
        }
      }
    }

    console.log(
      `  expectation: ${expectation.expectation} — ${expectation.reason}`,
    );

    verdictRows.push({
      id,
      reconstructable: true,
      reconstructError: "",
      capturedPublishable,
      replayedPublishable,
      matched: matched.length,
      capturedOnly: capturedOnly.length,
      replayedOnly: replayedOnly.length,
      expectation: expectation.expectation,
    });
  }

  console.log(
    `\n\n=== verdict table ===========================================================`,
  );
  console.log(
    "id        reconstructable  cap_pub  rep_pub  ident(match/cap-only/rep-only)  expectation",
  );
  for (const row of verdictRows) {
    console.log(
      `${shortId(row.id)}  ${String(row.reconstructable).padEnd(15)}  ${
        String(row.capturedPublishable).padEnd(7)
      }  ${String(row.replayedPublishable).padEnd(7)}  ${
        `${row.matched}/${row.capturedOnly}/${row.replayedOnly}`.padEnd(31)
      }  ${row.expectation}`,
    );
  }

  const reconstructable = verdictRows.filter((r) => r.reconstructable);
  const unreconstructable = verdictRows.filter((r) => !r.reconstructable);
  console.log(
    `\nGate-provable by this harness: ${reconstructable.length}/${verdictRows.length}. ` +
      `NOT gate-provable (stage_outputs missing/pre-fidelity-fix/reconstruction gap): ${unreconstructable.length}/${verdictRows.length}` +
      (unreconstructable.length > 0
        ? ` (${unreconstructable.map((r) => shortId(r.id)).join(", ")})`
        : ""),
  );
}

if (import.meta.main) {
  await main();
}
