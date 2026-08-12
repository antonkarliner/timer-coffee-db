// Golden-fixture suite for parse-user-recipe-draft.
//
// WHY THIS FILE EXISTS: seven phases of parser rework were verified by
// pasting transcripts into an admin UI by hand and eyeballing the output.
// That process twice let a regression ship inside a green test suite,
// because an existing expectation was silently rewritten to match new
// (wrong) behaviour. The worst example: a Chemex recipe once came out as
// durations [0, 45, 217, 10] -- a 3m37s pour followed by a 10-second
// drawdown, physically backwards -- and the test suite stayed green
// because the expectation had been updated to match the bug.
//
// A pure snapshot suite would have recorded that bug as "expected". So
// this suite is goldens PLUS explicit invariant assertions that encode
// what is physically correct, INDEPENDENT of whatever the code currently
// emits. See fixtures/README.md for how to regenerate goldens and why
// that is never a substitute for the invariants below.
//
// Every invariant check runs unconditionally -- including while
// regenerating goldens with UPDATE_GOLDENS=1 -- specifically so a bad
// regeneration cannot be rubber-stamped the way the historical bug was.

import {
  createRecipeDraftParser,
  type ExtractionResult,
  type NormalizedDraft,
  type ParseUserRecipeDraftResponse,
  type RecipeDraftAiProvider,
  type RecipeDraftParserInput,
} from "../parser.ts";

// ---------------------------------------------------------------------
// Minimal local assertion helpers (mirrors parser_test.ts's own style --
// no std/assert dependency needed).
// ---------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

// ---------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------

const CASES_DIR = new URL("./cases/", import.meta.url);
// Fixed clock used for every fixture run so publish_projection.last_modified
// and the deterministic recipe id stay stable across regenerations.
const FIXED_NOW_MS = 1776000000000;

async function readText(caseName: string, file: string): Promise<string> {
  const text = await Deno.readTextFile(
    new URL(`${caseName}/${file}`, CASES_DIR),
  );
  return text.replace(/\n$/, "");
}

async function readJson<T>(caseName: string, file: string): Promise<T> {
  return JSON.parse(await readText(caseName, file)) as T;
}

type FixtureRequest = Omit<RecipeDraftParserInput, "text">;

type CaseBundle = {
  name: string;
  source: string;
  extraction: ExtractionResult;
  normalized: NormalizedDraft;
  request: FixtureRequest;
};

async function loadCase(
  caseName: string,
  options?: { normalizedFile?: string; requestFile?: string },
): Promise<CaseBundle> {
  const [source, extraction, normalized, request] = await Promise.all([
    readText(caseName, "source.txt"),
    readJson<ExtractionResult>(caseName, "extraction.json"),
    readJson<NormalizedDraft>(
      caseName,
      options?.normalizedFile ?? "normalized.json",
    ),
    readJson<FixtureRequest>(
      caseName,
      options?.requestFile ?? "request.json",
    ),
  ]);
  return { name: caseName, source, extraction, normalized, request };
}

// A stub provider that returns exactly the fixture's extraction/normalized
// JSON -- "what a good LLM would return for it" -- and never makes a
// network call. Repair and cumulative_rewrite are deliberately unstubbed:
// none of these fixtures need them, and an unstubbed stage fails closed
// (rejects, gets logged, parseDraft carries on) rather than silently
// fabricating a repaired/rewritten draft.
function buildFixtureProvider(
  extraction: ExtractionResult,
  normalized: NormalizedDraft,
): RecipeDraftAiProvider {
  return {
    name: "groq",
    model: "groq/fixture",
    invokeJson<T>(input: { stage: string }) {
      if (input.stage === "extraction") {
        return Promise.resolve(
          { result: extraction as unknown as T, tokensUsed: 0 },
        );
      }
      if (input.stage === "normalization") {
        return Promise.resolve(
          { result: normalized as unknown as T, tokensUsed: 0 },
        );
      }
      return Promise.reject(
        new Error(`fixture provider has no stub for stage "${input.stage}"`),
      );
    },
  };
}

async function runBundle(
  bundle: CaseBundle,
): Promise<ParseUserRecipeDraftResponse> {
  const parser = createRecipeDraftParser({
    providers: [buildFixtureProvider(bundle.extraction, bundle.normalized)],
    now: () => FIXED_NOW_MS,
  });
  return await parser.parseDraft(
    { ...bundle.request, text: bundle.source } as RecipeDraftParserInput,
  );
}

async function runCase(
  caseName: string,
  options?: { normalizedFile?: string; requestFile?: string },
): Promise<{ bundle: CaseBundle; result: ParseUserRecipeDraftResponse }> {
  const bundle = await loadCase(caseName, options);
  const result = await runBundle(bundle);
  return { bundle, result };
}

// ---------------------------------------------------------------------
// Golden comparison
// ---------------------------------------------------------------------

// publish_projection.user_recipe_localization.id and each
// publish_projection.user_steps[].id are crypto.randomUUID() -- genuinely
// random on every run, unlike user_recipe.id (deterministic:
// `usr-${userId}-${nowMs}`). Golden files compare everything BYTE FOR BYTE
// except these two random id shapes, which are replaced with a fixed
// placeholder before compare/write and separately checked for UUID shape.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PLACEHOLDER = "<random-uuid>";

function sanitizeForGolden(response: ParseUserRecipeDraftResponse): unknown {
  const clone = JSON.parse(JSON.stringify(response));
  if (clone.publish_projection) {
    clone.publish_projection.user_recipe_localization.id = UUID_PLACEHOLDER;
    for (const step of clone.publish_projection.user_steps) {
      step.id = UUID_PLACEHOLDER;
    }
  }
  return clone;
}

function assertRandomIdsAreWellFormed(
  response: ParseUserRecipeDraftResponse,
  caseName: string,
): void {
  const projection = response.publish_projection;
  if (!projection) return;

  assert(
    UUID_REGEX.test(projection.user_recipe_localization.id),
    `[${caseName}] Expected user_recipe_localization.id to be a UUID.`,
  );
  for (const step of projection.user_steps) {
    assert(
      UUID_REGEX.test(step.id),
      `[${caseName}] Expected every user_steps[].id to be a UUID.`,
    );
  }
  assertEquals(
    projection.user_recipe_localization.recipe_id,
    projection.user_recipe.id,
    `[${caseName}] Expected user_recipe_localization.recipe_id to match user_recipe.id.`,
  );
  for (const step of projection.user_steps) {
    assertEquals(
      step.recipe_id,
      projection.user_recipe.id,
      `[${caseName}] Expected every user_steps[].recipe_id to match user_recipe.id.`,
    );
  }
}

// Regenerate with:
//   UPDATE_GOLDENS=1 deno test --allow-all
// run from supabase/functions/parse-user-recipe-draft/. See
// fixtures/README.md -- regenerating is a deliberate, visible act, and it
// is NEVER a substitute for the invariant assertions in this file, which
// run unconditionally (including during regeneration) below.
const UPDATE_GOLDENS = Deno.env.get("UPDATE_GOLDENS") === "1";

async function checkGolden(
  caseName: string,
  result: ParseUserRecipeDraftResponse,
  goldenFile = "golden.json",
): Promise<void> {
  const sanitized = sanitizeForGolden(result);
  const goldenUrl = new URL(`${caseName}/${goldenFile}`, CASES_DIR);

  if (UPDATE_GOLDENS) {
    await Deno.writeTextFile(
      goldenUrl,
      JSON.stringify(sanitized, null, 2) + "\n",
    );
    return;
  }

  let stored: unknown;
  try {
    stored = JSON.parse(await Deno.readTextFile(goldenUrl));
  } catch (error) {
    throw new Error(
      `[${caseName}] Could not read golden file "${goldenFile}" (${
        (error as Error).message
      }). Run "UPDATE_GOLDENS=1 deno test --allow-all" to create it -- but read fixtures/README.md first.`,
    );
  }

  assertEquals(
    sanitized,
    stored,
    `[${caseName}] Golden mismatch against "${goldenFile}". If this change is intentional, regenerate with UPDATE_GOLDENS=1 deno test --allow-all -- but that is never a substitute for re-checking the invariant assertions in this file: a green golden diff is exactly how the [0, 45, 217, 10] Chemex regression shipped.`,
  );
}

// ---------------------------------------------------------------------
// Shared, cross-case invariants (F-series regressions this suite guards)
// ---------------------------------------------------------------------

function allStepTexts(result: ParseUserRecipeDraftResponse): string[] {
  return result.draft.steps.flatMap((step) => [
    step.description_template,
    step.preview_text,
  ]);
}

// Invariant 1: no zero-collapse. A nonzero source amount must never render
// as "(0 x ...)" -- the class of bug where a real quantity silently
// collapses to zero in the scalable expression.
function assertNoZeroCollapse(
  result: ParseUserRecipeDraftResponse,
  caseName: string,
): void {
  for (const text of allStepTexts(result)) {
    assert(
      !text.includes("(0 x "),
      `[${caseName}] Expected no "(0 x " zero-collapse expression in step text, found it in: ${text}`,
    );
  }
}

// Invariant 2: no canned sentences. simplifyVerboseChemexPreparation /
// simplifyVerboseBrewTemplate used to replace ANY step containing a
// trigger phrase with one of a handful of canned sentences, discarding
// real detail (temperature, technique, equipment asides) that happened to
// sit in the same step. Those functions were deleted; this guards against
// their reintroduction, and separately checks that real source detail
// survives verbatim.
const FORBIDDEN_CANNED_SENTENCES = [
  /consistent pour pattern/i,
  /spiraling from the center out and back/i,
  /same pouring pattern, then pause/i,
];

function assertNoCannedSentences(
  result: ParseUserRecipeDraftResponse,
  caseName: string,
): void {
  for (const text of allStepTexts(result)) {
    for (const pattern of FORBIDDEN_CANNED_SENTENCES) {
      assert(
        !pattern.test(text),
        `[${caseName}] Expected no deleted canned-rewrite sentence (matched ${pattern}) in step text: ${text}`,
      );
    }
  }
}

function assertDetailSurvives(
  result: ParseUserRecipeDraftResponse,
  caseName: string,
  detail: string,
): void {
  const found = allStepTexts(result).some((text) => text.includes(detail));
  assert(
    found,
    `[${caseName}] Expected source detail to survive verbatim in some step's text: "${detail}"`,
  );
}

// Invariant 4: rate phrasing ("N grams a second", "N ml/sec", etc.) is a
// SPEED, not a scalable recipe quantity -- it must stay completely
// literal, never wrapped in a "(multiplier x <placeholder>)" expression.
function assertRateStaysLiteral(
  result: ParseUserRecipeDraftResponse,
  caseName: string,
  ratePhrase: string,
): void {
  assertDetailSurvives(result, caseName, ratePhrase);
}

// Invariant 6: durations sum exactly to the resolved total when a total
// was resolved and the remainder fit (i.e. brew_time_seconds is non-null).
function assertDurationsSumToResolvedTotal(
  result: ParseUserRecipeDraftResponse,
  caseName: string,
): void {
  const brewTime = result.draft.recipe.brew_time_seconds;
  if (brewTime === null) return;

  const sum = result.draft.steps
    .filter((step) => step.kind === "brew")
    .reduce((total, step) => total + step.duration_seconds, 0);
  assertEquals(
    sum,
    brewTime,
    `[${caseName}] Expected brew step durations to sum exactly to the resolved brew_time_seconds.`,
  );
}

// Equipment capacities / product specs (Kalita reservoir, Chemex/Hario
// filter weights) must never be picked up as a scalable recipe quantity --
// checked structurally against the extracted expressions, not just by
// eyeballing rendered text.
function assertAmountNeverScaled(
  result: ParseUserRecipeDraftResponse,
  caseName: string,
  forbiddenValue: number,
): void {
  for (const step of result.draft.steps) {
    for (const expression of step.expressions) {
      assert(
        expression.preview_value !== forbiddenValue,
        `[${caseName}] Expected ${forbiddenValue} to never be captured as a scalable expression (equipment capacity/product spec), but found it as preview_value on step ${step.step_order}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------
// Case 1: Kalita Wave -- dose multipliers, equipment aside, deterministic
// split, and a spoken-word total brew time range.
// ---------------------------------------------------------------------

Deno.test("[kalita] golden matches and invariants hold", async () => {
  const { result } = await runCase("kalita", {
    normalizedFile: "normalized.variant-a.json",
  });

  // Invariants run BEFORE the golden check/write below on purpose: this is
  // what makes "regenerating is never a substitute for the invariants"
  // literally true rather than aspirational. If any invariant here throws,
  // checkGolden below never runs, so `UPDATE_GOLDENS=1` can never write a
  // golden that encodes a physically-wrong result -- the exact failure
  // mode described in fixtures/README.md.
  assertNoZeroCollapse(result, "kalita");
  assertNoCannedSentences(result, "kalita");
  assertDurationsSumToResolvedTotal(result, "kalita");
  assertRandomIdsAreWellFormed(result, "kalita");

  // Invariant 3: the Gabi Dripmaster's 120ml reservoir is an equipment
  // capacity, not a recipe quantity -- it must never scale with dose/water.
  assertAmountNeverScaled(result, "kalita", 120);
  assertDetailSurvives(result, "kalita", "120 milliliter reservoir");

  // Invariant 4: "roughly 5 grams a second" is a pour-rate aside, not an
  // amount -- it must stay completely literal.
  assertRateStaysLiteral(result, "kalita", "roughly 5 grams a second");

  // F31 regression guard: both pours here are phrased as multiples of the
  // coffee dose ("five times the dose... eight times the dose") or the
  // final water amount, never an incremental amount, and step_role marks
  // each as "pour". Before the fix, computeBrewStepWaterAddedAmounts only
  // ever recognized a <final_water_amount> expression, so the dose-phrased
  // pour registered as adding NO water and fell back to the flat 15s
  // DERIVED_STIR_SECONDS quick-action estimate -- the same "flat stir
  // where a pour-rate estimate belongs" shape as the [0, 45, 217, 10]
  // Chemex bug. Assert neither pour lands on that flat quick-action value.
  const kalitaPourDurations = result.draft.steps
    .filter((step) => step.step_role === "pour")
    .map((step) => step.duration_seconds);
  assert(
    kalitaPourDurations.every((duration) => duration !== 15),
    `[kalita] Expected every dose- or water-phrased pour to receive a distinct pour-rate-based duration, not the flat 15s quick-action estimate. Got: ${
      JSON.stringify(kalitaPourDurations)
    }`,
  );

  assert(
    result.validation.is_publishable,
    "[kalita] Expected a fully-specified recipe to be publishable.",
  );

  await checkGolden("kalita", result);
});

Deno.test("[kalita] deterministic split: three different model-guessed duration splits (real production numbers) produce identical final durations", async () => {
  // F7 / Phase B2 acceptance test, reproduced as a fixture. Three real
  // production transcript runs of the same recipe guessed wildly different
  // per-step durations while still (coincidentally) summing close to the
  // same total:
  //   run 1   67 / 10 / 67 / 66
  //   run 2   45 / 45 / 90 / 30
  //   run 3   10 / 10 / 180 / 10
  // None of the four brew steps states its own duration in the source, so
  // all four are DERIVED -- the final per-step split must be a pure
  // function of the target total, the water amounts, and each step's
  // role, and must NOT depend on whatever duration a given model run
  // guessed for that step. This is the per-step-variance guard: without
  // it, re-running the identical transcript through the identical parser
  // could legitimately produce a different (but equally "passing") answer
  // every time.
  const variants = [
    "normalized.variant-a.json", // [67, 10, 67, 66]
    "normalized.variant-b.json", // [45, 45, 90, 30]
    "normalized.variant-c.json", // [10, 10, 180, 10]
  ];

  const results = await Promise.all(
    variants.map((normalizedFile) =>
      runCase("kalita", { normalizedFile }).then((r) => r.result)
    ),
  );

  const durationsPerRun = results.map((result) =>
    result.draft.steps.map((step) => step.duration_seconds)
  );

  assertEquals(
    durationsPerRun[0],
    durationsPerRun[1],
    "Expected run 0 (guessed [67,10,67,66]) and run 1 (guessed [45,45,90,30]) to produce byte-identical step durations.",
  );
  assertEquals(
    durationsPerRun[1],
    durationsPerRun[2],
    "Expected run 1 (guessed [45,45,90,30]) and run 2 (guessed [10,10,180,10]) to produce byte-identical step durations.",
  );

  for (const result of results) {
    assertEquals(
      result.draft.recipe.brew_time_seconds,
      210,
      "Expected every run to land on the stated 210s ('three fifteen to three forty-five') total regardless of the model's own guessed split.",
    );
  }
});

// ---------------------------------------------------------------------
// Case 2: Hario Switch -- pre-timer actions folded into preparation in
// extract mode, and the verify-mode step-count-preservation invariant.
// ---------------------------------------------------------------------

Deno.test("[hario_switch] golden matches and invariants hold (extract mode)", async () => {
  const { bundle, result } = await runCase("hario_switch");

  assertNoZeroCollapse(result, "hario_switch");
  assertNoCannedSentences(result, "hario_switch");
  assertDurationsSumToResolvedTotal(result, "hario_switch");
  assertRandomIdsAreWellFormed(result, "hario_switch");

  assertEquals(
    result.draft.steps.length,
    4,
    "Expected the 2 pre-timer actions (fill, add coffee) to fold into a single preparation step alongside the rinse/close-switch preparation, leaving 4 steps: prep, stir-start, switch-open, drain.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    85,
    "Expected total brew time to match the source's own 'about 1:25' (85s).",
  );

  // Sanity: the fixture's underlying normalized draft really did supply 6
  // steps -- the fold, not a leaner fixture, is what produces 4.
  assertEquals(
    bundle.normalized.steps.length,
    6,
    "Expected the fixture's normalized draft to supply 6 steps before folding.",
  );

  await checkGolden("hario_switch", result);
});

Deno.test("[hario_switch] verify mode preserves the supplied step count instead of folding pre-timer actions", async () => {
  // Invariant 12. verify-user-recipe-draft's handler hard-502s the app if
  // the parser returns a different step count than the request supplied,
  // so mode: "verify" must disable any pass that changes step count --
  // including foldPreTimerStepsIntoPreparation, which was historically NOT
  // mode-gated (see plan 010 SS3). As of this writing finalizeDraftResponse
  // threads `mode` through as `preserveStepCount = mode === "verify"` and
  // foldPreTimerStepsIntoPreparation's caller consults it, so this
  // currently PASSES -- kept as a live (non-ignored) assertion so a future
  // regression that removes that gate is caught immediately. If this ever
  // starts failing again: do NOT fix parser.ts from inside this fixture
  // suite and do NOT weaken this assertion -- re-ignore it with
  // Deno.test.ignore, point the comment at plan 010 SS3, and report it
  // prominently, exactly as it would have been reported here originally.
  const { bundle, result } = await runCase("hario_switch", {
    requestFile: "request.verify.json",
  });

  assertEquals(
    result.draft.steps.length,
    bundle.normalized.steps.length,
    "Expected verify mode to return the SAME number of steps supplied (no pre-timer folding), unlike extract mode.",
  );
});

// ---------------------------------------------------------------------
// Case 3: Chemex -- commentary-heavy transcript, filter-weight trivia, and
// the drawdown-longer-than-pour regression guard.
// ---------------------------------------------------------------------

Deno.test("[chemex] golden matches and invariants hold", async () => {
  const { result } = await runCase("chemex");

  assertNoZeroCollapse(result, "chemex");
  assertNoCannedSentences(result, "chemex");
  assertDurationsSumToResolvedTotal(result, "chemex");
  assertRandomIdsAreWellFormed(result, "chemex");

  // Invariant 3: Chemex/Hario filter paper weights are product specs, not
  // recipe quantities.
  assertAmountNeverScaled(result, "chemex", 4.5);
  assertAmountNeverScaled(result, "chemex", 1.5);
  assertDetailSurvives(result, "chemex", "4.5 grams dry");
  assertDetailSurvives(result, "chemex", "1.5 grams for a Hario paper");

  // Invariant 4.
  assertRateStaysLiteral(result, "chemex", "maybe 3 grams a second");

  // Invariant 2 (detail survives, not just "no canned sentence"): the
  // technique wording actually present in this transcript must not have
  // been discarded.
  assertDetailSurvives(result, "chemex", "avoiding the filter walls");

  // Invariant 5: the regression guard for the [0, 45, 217, 10] class of
  // bug. A Chemex (or V60) drawdown is physically the long tail of the
  // brew -- it must come out longer than the pour that precedes it, never
  // shorter.
  const pourStep = result.draft.steps.find((step) =>
    step.step_role === "pour"
  );
  const drawdownStep = result.draft.steps.find((step) =>
    step.step_role === "drawdown"
  );
  assert(pourStep !== undefined, "[chemex] Expected a pour step.");
  assert(drawdownStep !== undefined, "[chemex] Expected a drawdown step.");
  assert(
    drawdownStep!.duration_seconds > pourStep!.duration_seconds,
    `[chemex] Expected the drawdown step (${drawdownStep!.duration_seconds}s) to take longer than the pour step (${pourStep!.duration_seconds}s) -- a Chemex drawdown is the long tail of the brew, not a quick action. This is the direct regression guard for the historical [0, 45, 217, 10] bug (a 3m37s pour followed by a 10s drawdown).`,
  );

  await checkGolden("chemex", result);
});

// ---------------------------------------------------------------------
// Case 4: German V60 -- labelled fields, non-English text, elapsed-time
// pours, and the "bloom must not absorb the remainder" regression guard.
// ---------------------------------------------------------------------

Deno.test("[german_v60] golden matches and invariants hold", async () => {
  const { result } = await runCase("german_v60");

  assertNoZeroCollapse(result, "german_v60");
  assertNoCannedSentences(result, "german_v60");
  assertDurationsSumToResolvedTotal(result, "german_v60");
  assertRandomIdsAreWellFormed(result, "german_v60");

  assertEquals(
    result.detected_input_language,
    "de",
    "[german_v60] Expected the detected input language to stay German.",
  );

  // Invariant 9a: non-English recipes never gain English text. The
  // synthetic "Wait for the complete drawdown." sentence is English-only
  // and must never be appended onto a German recipe, even though this
  // fixture's elapsed-timestamp pours (index 2/3) go through the same
  // timestamp-normalization pass that Chemex's does.
  for (const text of allStepTexts(result)) {
    assert(
      !/wait for the complete drawdown/i.test(text),
      `[german_v60] Expected no synthesized English drawdown sentence, found: ${text}`,
    );
    assert(
      !/\bthe\b|\bwait\b|\bplease\b/i.test(text) ||
        /Vorspuel|Filter|Wasser/i.test(text),
      `[german_v60] Suspicious English-looking text in a German recipe step: ${text}`,
    );
  }

  // Invariant 9b: the bloom must not absorb the deficit remainder. F7/
  // Phase B2 predates step_role; before it, a German "Vollstaendig
  // durchlaufen lassen." (drawdown) step with no English drawdown wording
  // could go undetected, and the bloom -- being the first derived-looking
  // step -- absorbed the whole leftover instead (a real production
  // instance was assigned 130s this way). This fixture's bloom states its
  // own duration (duration_is_stated: true, 30s) and is separately
  // protected by step_role "bloom", so it must survive at exactly 30s
  // regardless of the resolved 180s total.
  const bloomStep = result.draft.steps.find((step) =>
    step.step_role === "bloom"
  );
  assert(bloomStep !== undefined, "[german_v60] Expected a bloom step.");
  assertEquals(
    bloomStep!.duration_seconds,
    30,
    "[german_v60] Expected the bloom to survive at its stated 30s instead of absorbing part of the 180s total remainder.",
  );

  // The drawdown ("Vollstaendig durchlaufen lassen.") is what should
  // legitimately absorb the remainder instead.
  const drawdownStep = result.draft.steps.find((step) =>
    step.step_role === "drawdown"
  );
  assert(drawdownStep !== undefined, "[german_v60] Expected a drawdown step.");
  assert(
    drawdownStep!.duration_seconds > bloomStep!.duration_seconds,
    "[german_v60] Expected the drawdown, not the bloom, to be where the deficit lands.",
  );

  await checkGolden("german_v60", result);
});

// ---------------------------------------------------------------------
// Case 5: Cold Brew -- imperial units, a very long explicit steep, the
// inferred-duration cap, and an unsupported brewing method.
// ---------------------------------------------------------------------

Deno.test("[cold_brew] golden matches and invariants hold", async () => {
  const { result } = await runCase("cold_brew");

  assertNoZeroCollapse(result, "cold_brew");
  assertNoCannedSentences(result, "cold_brew");
  assertRandomIdsAreWellFormed(result, "cold_brew");

  // Invariant 7: the explicit 18-hour (64800s) steep is source-stated
  // (duration_is_stated: true) and must survive completely untouched, even
  // though it is far larger than the 300s inferred-duration cap. Only
  // durations the parser itself INFERS may ever be clamped.
  const steepStep = result.draft.steps.find((step) =>
    step.duration_is_stated === true
  );
  assert(steepStep !== undefined, "[cold_brew] Expected the stated steep step.");
  assertEquals(
    steepStep!.duration_seconds,
    64800,
    "[cold_brew] Expected the explicit 18-hour steep to pass through completely unclamped.",
  );

  // The vague "swirl and strain" step, by contrast, IS inferred and must be
  // capped rather than inflated to fill whatever's left of the stated
  // total.
  const strainStep = result.draft.steps.find((step) =>
    step.step_role === "serve"
  );
  assert(strainStep !== undefined, "[cold_brew] Expected the strain/serve step.");
  assert(
    strainStep!.duration_seconds <= 300,
    `[cold_brew] Expected the inferred strain step to be capped at 300s, got ${
      strainStep!.duration_seconds
    }s.`,
  );

  // Invariant 11: the real brewing_methods table has no cold brew entry.
  // The fixture's normalized stub even stubs a CONTRADICTING id
  // ("french_press") to prove resolveBrewingMethodId's guard rejects it
  // rather than trusting an exact-but-contradicted id match at face value.
  assertEquals(
    result.draft.recipe.brewing_method_id,
    null,
    "[cold_brew] Expected brewing_method_id to stay null -- never coerced to a nearest match like French Press.",
  );
  assert(
    !result.validation.is_publishable,
    "[cold_brew] Expected an unresolved brewing method to block publishing.",
  );
  assert(
    result.publish_projection === undefined,
    "[cold_brew] Expected no publish_projection while the brewing method is unresolved.",
  );

  await checkGolden("cold_brew", result);
});

// ---------------------------------------------------------------------
// Case 6: Under-specified -- no amounts, no temperature, no method, no
// timings. Nothing may be fabricated.
// ---------------------------------------------------------------------

Deno.test("[underspecified] golden matches and invariants hold", async () => {
  const { result } = await runCase("underspecified");

  assertNoZeroCollapse(result, "underspecified");
  assertNoCannedSentences(result, "underspecified");

  // Invariant 10: nothing is fabricated.
  assertEquals(
    result.draft.recipe.coffee_amount,
    null,
    "[underspecified] Expected coffee_amount to stay null instead of being invented.",
  );
  assertEquals(
    result.draft.recipe.water_amount,
    null,
    "[underspecified] Expected water_amount to stay null instead of being invented.",
  );
  assertEquals(
    result.draft.recipe.brewing_method_id,
    null,
    "[underspecified] Expected brewing_method_id to stay null instead of being invented.",
  );
  assertEquals(
    result.validation.is_publishable,
    false,
    "[underspecified] Expected an under-specified recipe to be unpublishable.",
  );
  assert(
    result.publish_projection === undefined,
    "[underspecified] Expected no publish_projection for an under-specified recipe.",
  );

  await checkGolden("underspecified", result);
});
