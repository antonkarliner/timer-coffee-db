// G22 — provenance verification for emitted amounts.
//
// A live pass found the parser silently CHANGING explicit source amounts while
// still reporting `is_publishable: true`: an explicit 50 g first pour emitted
// as 60 g, a stated 25 g bloom emitted as 60 g in 2 of 4 identical runs, and
// five ascending Japanese pours (60/120/180/240/300 ml) all emitted as 60 ml.
// Nothing downstream compared final values against source facts.
//
// This module is the comparison. It is deliberately a standalone, pure
// function: it takes the request text, the final draft steps and the recorded
// provenance, and returns findings. It performs no I/O, mutates nothing, and
// knows nothing about zod or the parser pipeline, so it can be tested in
// isolation and wired in separately.
//
// See plans/009-recipe-draft-lab-transcript-robustness.md, section "G22 —
// settled design".

export type AmountProvenanceClass = "literal" | "derived" | "inferred";

/** A closed set. A rule outside it can never be verified, so it is a finding. */
export type DerivedRule =
  | "multiple_of_coffee"
  | "multiple_of_water"
  | "ratio_of_total"
  | "concentration"
  | "concentration_water_from_coffee"
  | "range_endpoint"
  | "cumulative_sum";

export const DERIVED_RULES: ReadonlySet<string> = new Set<DerivedRule>([
  "multiple_of_coffee",
  "multiple_of_water",
  "ratio_of_total",
  "concentration",
  "concentration_water_from_coffee",
  "range_endpoint",
  "cumulative_sum",
]);

export type AmountProvenance = {
  value: number;
  unit: string;
  /** Index into the final draft steps; -1 for a recipe-level amount. */
  step_index: number;
  provenance: AmountProvenanceClass;
  /** Required for `literal`: must appear verbatim in the request text. */
  source_quote: string | null;
  /** Required for `derived`: must be a member of DERIVED_RULES. */
  rule: string | null;
  /** Required for `derived`: the rule itself must trace to the source. */
  rule_source_quote: string | null;
  /** Operands the rule was applied to, e.g. { multiplier: 3, coffee_amount: 25 }. */
  rule_inputs: Record<string, number> | null;
  /**
   * Plan 016 §4 Phase 1b: the extraction stage's own semantic judgement of
   * what KIND of unit `unit` names. This is the durable mechanism per
   * CLAUDE.md's "don't put semantic judgements in regexes" rule — the model
   * is multilingual and has already read the source text, so a conclusive
   * `unit_kind` is preferred outright over the unit-string lexicon in
   * `normalizeUnitForComparison`.
   *
   * `mass` and `volume` are mutually compatible (the existing density~1
   * precedent this file already applies). `time` and `percent` are
   * compatible with neither, nor with each other.
   *
   * Optional and nullable for backward compatibility: every existing
   * capture, every fixture, and any provider that ignores the field has no
   * `unit_kind` at all. Absent (`undefined`) or explicitly `null` must fall
   * back to the lexicon exactly as before this field existed — see
   * `classifyRecordUnit`. A missing `unit_kind` must never itself change a
   * previously-passing draft's outcome.
   */
  unit_kind?: "mass" | "volume" | "time" | "percent" | null;
};

/** One emitted amount, as it appears in the FINAL draft after every pass. */
export type RenderedAmount = {
  step_index: number;
  value: number;
  unit: string;
  /** True when the amount is a cumulative water target rather than an addition. */
  is_cumulative_water: boolean;
};

export type ProvenanceFindingCode =
  | "unverifiable_amount"
  | "amount_provenance_mismatch"
  | "unsupported_derivation_rule"
  | "inferred_amount_not_permitted"
  | "amount_step_binding_mismatch"
  | "non_monotonic_cumulative";

export type ProvenanceFinding = {
  code: ProvenanceFindingCode;
  step_index: number;
  message: string;
};

export type VerifyAmountProvenanceArgs = {
  /** The raw text the user submitted. Quotes are checked against this. */
  requestText: string;
  /** Every amount present in the final draft, after all transforms. */
  renderedAmounts: RenderedAmount[];
  /** The provenance records the extraction stage produced. */
  provenance: AmountProvenance[];
};

export type VerifyAmountProvenanceResult = {
  findings: ProvenanceFinding[];
  /**
   * True when no provenance was supplied at all. The caller must degrade to a
   * single warning rather than blocking: a provider that ignores the new
   * fields would otherwise make the tool unusable.
   */
  unverified: boolean;
};

/** Rounding slack when recomputing a derived value. */
const DERIVED_TOLERANCE = 0.5;
/** Slack when comparing a rendered value to its recorded value. */
const RENDERED_TOLERANCE = 0.01;

function normalizeForQuoteSearch(value: string): string {
  // Collapse whitespace only. Digits, units, separators and case are all
  // meaningful here: "60-90g" must not be allowed to match "60 90 G".
  return value.replace(/\s+/g, " ").trim();
}

// Defect 1 (plan 016 §3 D1, Aug 2026 live pass): this lexicon is an
// English/Russian/Arabic/Persian-only FALLBACK — it is a unit vocabulary
// (like the existing g/ml folding below), not a semantic judgement of
// meaning, so it is not the English-only-regex antipattern CLAUDE.md warns
// against. It cannot recognize a mass/volume word in any language it
// doesn't explicitly list. `unit_kind` (see `classifyRecordUnit` below) is
// the durable mechanism and is always preferred when present; this lexicon
// is only reached when `unit_kind` is absent or null. Widen it only as a
// labelled, best-effort supplement — never as the primary disambiguation
// mechanism.
//
// Arabic and Persian forms added per plan 016 Phase 0's evidence: blocked
// Arabic captures recorded `"unit": "جرام"` (source_quote "40 جرام") and
// `"unit": "مل"`/`"مليلتر"`; blocked Persian captures recorded `"گرم"` and
// `"میلی‌لیتر"` — while the RENDERED side is always plain ASCII "g"/"ml",
// because the model writes the scalable-unit token in Latin script even
// inside an otherwise-Arabic/Persian sentence. An unmatched native-script
// unit normalized to itself and never equalled the rendered "g"/"ml", so
// every amount in those captures flagged untraceable.
const MASS_UNIT_WORDS = [
  // English
  "g",
  "gr",
  "gram",
  "grams",
  "gramme",
  "grammes",
  // Russian
  "г",
  "гр",
  // Arabic — both "جرام" and "غرام" are in live use for "gram"; "جم" is a
  // common abbreviated form (parallel to "g"/"gr" in English).
  "جرام",
  "جرامات",
  "غرام",
  "غرامات",
  "جم",
  // Persian
  "گرم",
  "گرمها",
];

const VOLUME_UNIT_WORDS = [
  // English
  "ml",
  "mls",
  "milliliter",
  "milliliters",
  "millilitre",
  "millilitres",
  // Russian
  "мл",
  // Arabic
  "مل",
  "مليلتر",
  "ملليلتر",
  "مليلترات",
  // Persian. Only one spelling of "millilitre" is listed here — the ZWNJ-
  // joined form "میلی‌لیتر", the plain-space form "میلی لیتر", and the
  // unjoined form "میلیلیتر" all collapse to this same string once
  // normalizeUnitForComparison strips whitespace and zero-width joiners
  // below, so listing more than one would be redundant, not more thorough.
  "میلیلیتر",
];

// Arabic combining diacritics (tashkeel) and the tatweel elongation
// character. A model that emits fully-vocalized Arabic (e.g. "جَرَام"
// instead of "جرام") is still naming the same unit — these marks change how
// a word is rendered, never what it means.
const ARABIC_DIACRITICS_AND_TATWEEL =
  /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Units are compared loosely on purpose. `g` and `ml` are treated as
 * equivalent because coffee recipes use them interchangeably for water
 * (density ~1), and flagging "300 g water" against "300 ml water" would be a
 * false positive. What this DOES catch is a mass/volume figure being matched
 * against a percentage or a time.
 *
 * This is the FALLBACK layer only — see `classifyRecordUnit`, which prefers
 * the extraction stage's own `unit_kind` field when it is present and
 * conclusive, and reaches this lexicon only when that field is absent, null,
 * or (for the rendered side, which never carries `unit_kind` at all) always.
 */
function normalizeUnitForComparison(unit: string): string {
  const normalized = unit
    .trim()
    .toLowerCase()
    // Zero-width non-joiner/joiner: orthographically required in some
    // Persian compound words (e.g. "میلی‌لیتر") but not meaningful for unit
    // identity — see the VOLUME_UNIT_WORDS comment above.
    .replace(/[\u200B\u200C]/g, "")
    .replace(ARABIC_DIACRITICS_AND_TATWEEL, "")
    .replace(/[.\s]/g, "");

  if (
    MASS_UNIT_WORDS.includes(normalized) ||
    VOLUME_UNIT_WORDS.includes(normalized)
  ) {
    return "mass_or_volume";
  }

  return normalized;
}

/**
 * Classifies a provenance RECORD's unit into a comparison bucket. Prefers
 * `unit_kind` (plan 016 Phase 1b) outright when present and conclusive;
 * falls back to the unit-string lexicon exactly as before that field
 * existed when it is absent or explicitly null. See `AmountProvenance.
 * unit_kind`'s own doc comment for the backward-compatibility contract.
 *
 * There is no equivalent classifier for the RENDERED side: a rendered
 * amount is text extracted from the assembled final draft, not a structured
 * extraction-stage judgement, so it only ever has the lexicon to go on (see
 * `unitsAreCompatible`).
 */
function classifyRecordUnit(record: AmountProvenance): string {
  if (record.unit_kind === "mass" || record.unit_kind === "volume") {
    return "mass_or_volume";
  }
  if (record.unit_kind === "time") {
    return "time";
  }
  if (record.unit_kind === "percent") {
    return "percent";
  }
  // unit_kind is undefined or null: fall back to the lexicon.
  return normalizeUnitForComparison(record.unit);
}

/**
 * Defect 2 (plan 016 §3 D1-German): a range's first expression is rendered
 * WITHOUT a trailing unit by design — see EXPRESSION_REGEX's own comment in
 * parser.ts ("a range's first expression ... legitimately has no unit of
 * its own immediately after it"), which exists to keep that unit group
 * anchored to an allowlist rather than reintroducing the denylist that
 * corrupted Japanese output (Fix E). A source range like "50-70g" renders
 * as one unit written once, after the SECOND half, so the first rendered
 * expression's `unit` is legitimately `""`. Treating that as merely
 * "incompatible with everything" is what produced the German false block:
 * `Step 3 states 50, which does not trace to any amount recorded from the
 * source.`
 *
 * The empty-unit policy: an empty rendered unit is compatible ONLY with a
 * record that classifies as `mass_or_volume`. This is a deliberate,
 * narrower rule than "match on value alone" — this module's own docstring
 * above says what the loose g/ml folding DOES catch is "a mass/volume
 * figure being matched against a percentage or a time," and a wildcard
 * empty-unit match would silently defeat exactly that: a stray "50" that
 * actually belongs to a time or percent record would pass against ANY
 * mass/volume value in this recipe. Requiring the RECORD side to resolve to
 * mass_or_volume (via `unit_kind` or the lexicon) before an empty rendered
 * unit is accepted preserves the original guarantee while fixing the false
 * block: a mass record with a unit-less rendering still passes, but a time
 * or percent record with a unit-less rendering still fails, which is
 * exactly this check's whole purpose.
 */
function unitsAreCompatible(
  record: AmountProvenance,
  rendered: RenderedAmount,
): boolean {
  const recordClass = classifyRecordUnit(record);
  const renderedUnit = rendered.unit.trim();

  if (renderedUnit === "") {
    return recordClass === "mass_or_volume";
  }

  return recordClass === normalizeUnitForComparison(renderedUnit);
}

function quoteAppearsInSource(quote: string, requestText: string): boolean {
  const needle = normalizeForQuoteSearch(quote);
  if (!needle) {
    return false;
  }

  return normalizeForQuoteSearch(requestText).includes(needle);
}

function recomputeDerivedValue(
  record: AmountProvenance,
): number | null {
  const inputs = record.rule_inputs ?? {};
  const get = (key: string): number | null => {
    const value = inputs[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  switch (record.rule) {
    case "multiple_of_coffee": {
      const multiplier = get("multiplier");
      const coffeeAmount = get("coffee_amount");
      return multiplier === null || coffeeAmount === null
        ? null
        : multiplier * coffeeAmount;
    }
    case "multiple_of_water": {
      const multiplier = get("multiplier");
      const waterAmount = get("water_amount");
      return multiplier === null || waterAmount === null
        ? null
        : multiplier * waterAmount;
    }
    case "ratio_of_total": {
      const percent = get("percent");
      const waterAmount = get("water_amount");
      return percent === null || waterAmount === null
        ? null
        : (percent / 100) * waterAmount;
    }
    case "concentration": {
      // Coffee mass from a concentration and a water volume:
      // "60 g/L" over 500 ml -> 30 g.
      const gramsPerLitre = get("grams_per_litre");
      const millilitres = get("millilitres");
      return gramsPerLitre === null || millilitres === null
        ? null
        : (gramsPerLitre / 1000) * millilitres;
    }
    case "concentration_water_from_coffee": {
      // The inverse, which the recipes actually state more often: a dose and a
      // target strength imply the water. "60 grams per liter" at 30 g coffee
      // -> 500 ml water. Without this the Chemex case could not be recorded
      // at all, because `concentration` only solves in the other direction.
      const gramsPerLitre = get("grams_per_litre");
      const coffeeGrams = get("coffee_grams");
      return gramsPerLitre === null || coffeeGrams === null ||
          gramsPerLitre === 0
        ? null
        : (coffeeGrams / gramsPerLitre) * 1000;
    }
    case "range_endpoint": {
      const low = get("low");
      const high = get("high");
      if (low === null || high === null) {
        return null;
      }
      const endpoint = inputs["endpoint"];
      // `endpoint` is encoded numerically so rule_inputs stays Record<string,
      // number>: 0 = low, 1 = high, 0.5 = midpoint.
      if (endpoint === 0) return low;
      if (endpoint === 1) return high;
      if (endpoint === 0.5) return (low + high) / 2;
      return null;
    }
    case "cumulative_sum": {
      const total = get("sum");
      return total;
    }
    default:
      return null;
  }
}

// Plan 020 D4 (flash-chilled 150 g ice / 150 g water collision, confirmed
// on production capture 73d06a79-5e48-497f-bf71-ebd48426caa4): the matcher
// used to be `unconsumed.find(...)`, taking the FIRST unconsumed candidate
// in array order once value+unit matched. When a value legitimately repeats
// in two different roles — 150 g of ice in the preparation step, and,
// separately, a 150 g cumulative brew-water target three steps later — the
// EARLIER-rendered occurrence (the ice, which the extraction stage
// deliberately does not record, because ice is not brew water) consumed the
// only 150 g record on record, which actually belonged to the later pour.
// That produced two false findings at once: `amount_step_binding_mismatch`
// on the ice's own step (the record's real step_index was "far" from where
// array-order matching stuck it) and `unverifiable_amount` on the pour's
// step (nothing was left to match against once the record was gone).
//
// The fix pairs every rendered amount with its nearest-by-step_index
// unconsumed, value/unit-compatible record, decided GLOBALLY rather than by
// processing rendered amounts one at a time in array order. A per-item
// "take whichever unconsumed candidate is nearest" still fails this exact
// case: when the ice (step 0) is considered before the pour (step 2), the
// lone 150 g record is the ONLY candidate available at that moment, so it
// gets consumed regardless of how "near" it actually is. Deciding all pairs
// at once — sorted by distance, closest first — lets the pour's exact
// (distance-0) match claim the record before the ice's more distant
// (distance-2) one is ever considered, exactly reproducing what a human
// reading the recipe would conclude. The ice's rendered amount is then
// correctly left with no record to trace to (`unverifiable_amount` on its
// own step, step 0) — which is honest: ice genuinely was never extracted —
// rather than stealing the pour's record and reporting a fabricated
// mismatch two steps away.
//
// Recipe-level records (`step_index: -1`) are a SENTINEL, not a position —
// see `AmountProvenance.step_index`'s own doc comment. Feeding -1 into the
// ordinary `Math.abs(record.step_index - rendered.step_index)` formula
// would manufacture a fake distance that grows with how far into the recipe
// the rendered amount happens to sit (a rendered amount on step 3 would
// score "distance 4" against a -1 record, as if the record were one step
// before step 0 — meaningless).
//
// `stepDistance` below treats a -1 on EITHER side as distance ZERO instead
// — maximally compatible with every step, rather than maximally distant
// from all of them. This was not the first design tried: distance-Infinity
// (sentinel picked only as an absolute last resort) reads more
// "conservative" on paper, but it regressed a real, previously-clean
// capture (127f391d, "Hario full 4", replayed via
// `scripts/recipe-draft-replay/replay.ts --all`) the moment it was checked
// against the corpus. That capture's extraction/repair stage recorded the
// SAME value twice — once at `step_index: -1` (the recipe-level dose) and
// once more, redundantly, at a real but essentially arbitrary positional
// step_index the value is never actually re-stated at — while the final
// draft renders that value exactly once, in the preparation step. Infinity
// made the redundant positional duplicate outrank the sentinel purely
// because it named A step, even though that step was two and three
// positions away from where the value actually rendered, fabricating a
// two-step `amount_step_binding_mismatch` that did not exist before this
// fix. Distance zero fixes it: a recipe-level fact has no wrong position,
// so it is compatible with wherever it is rendered, and — being distance
// zero rather than distance-of-the-actual-nearest-real-record — it also
// never OUTRANKS an exact (distance-0) positional match, only ties with
// one, which the tie rule below then resolves deterministically. This is
// the direct application of D4's own mechanism in miniature: prefer the
// pairing closest to how a human reading the recipe would actually
// resolve it, not the one that is superficially "more specific" on paper.
const SENTINEL_STEP_DISTANCE = 0;

function stepDistance(
  recordStepIndex: number,
  renderedStepIndex: number,
): number {
  if (recordStepIndex === -1 || renderedStepIndex === -1) {
    return SENTINEL_STEP_DISTANCE;
  }
  return Math.abs(recordStepIndex - renderedStepIndex);
}

// Tie rule (needed whenever two or more candidates land on the exact same
// distance — including two sentinel candidates, or a sentinel tied with an
// exact positional match, both at distance 0): prefer the candidate for the
// EARLIER-appearing rendered amount, then the earlier-appearing provenance
// record. This is arbitrary in the sense that no other rule is physically
// forced by the data, but it is deterministic and it reduces to the
// pre-fix `.find()` behaviour on the fully-degenerate case where every
// pairing is equally (non-)specific — see `matchRenderedAmountsToProvenance`
// and its test coverage in `provenance_test.ts`.

type AmountMatchCandidate = {
  renderedIndex: number;
  recordIndex: number;
  distance: number;
};

/**
 * Decides, for every rendered amount, which (if any) provenance record it
 * traces to — one record used at most once. See the D4 comment block above
 * `stepDistance` for the full rationale; this is the "decide all pairs at
 * once, nearest first" mechanism that makes the flash-chilled 150 g/150 g
 * case resolve correctly regardless of which value happens to render first.
 *
 * Returns, for each index into `renderedAmounts`, the matched index into
 * `provenance`, or `null` when no compatible record remains unconsumed.
 */
function matchRenderedAmountsToProvenance(
  provenance: AmountProvenance[],
  renderedAmounts: RenderedAmount[],
): (number | null)[] {
  const candidates: AmountMatchCandidate[] = [];

  renderedAmounts.forEach((rendered, renderedIndex) => {
    provenance.forEach((record, recordIndex) => {
      if (
        Math.abs(record.value - rendered.value) > RENDERED_TOLERANCE ||
        !unitsAreCompatible(record, rendered)
      ) {
        return;
      }
      candidates.push({
        renderedIndex,
        recordIndex,
        distance: stepDistance(record.step_index, rendered.step_index),
      });
    });
  });

  // Nearest first. Ties (including the all-sentinel case, where every
  // distance is Infinity) fall back to rendered-array order, then
  // provenance-array order — see the D4 comment block above for why.
  // Compared with `<`/`!==` rather than subtraction so that comparing two
  // Infinity distances (two sentinel candidates) never produces NaN.
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance < b.distance ? -1 : 1;
    }
    if (a.renderedIndex !== b.renderedIndex) {
      return a.renderedIndex - b.renderedIndex;
    }
    return a.recordIndex - b.recordIndex;
  });

  const matchForRendered: (number | null)[] = renderedAmounts.map(() => null);
  const recordConsumed: boolean[] = provenance.map(() => false);

  for (const candidate of candidates) {
    if (matchForRendered[candidate.renderedIndex] !== null) {
      continue;
    }
    if (recordConsumed[candidate.recordIndex]) {
      continue;
    }
    matchForRendered[candidate.renderedIndex] = candidate.recordIndex;
    recordConsumed[candidate.recordIndex] = true;
  }

  return matchForRendered;
}

/**
 * Verifies that every emitted amount traces to a source fact.
 *
 * The catch-all is rule 1: an emitted amount with NO provenance record is
 * unexplained. That is what catches invented values — the 80 g bloom that
 * shipped five times had no source basis at all, and every other check would
 * have passed it.
 */
export function verifyAmountProvenance(
  args: VerifyAmountProvenanceArgs,
): VerifyAmountProvenanceResult {
  const findings: ProvenanceFinding[] = [];

  if (args.provenance.length === 0) {
    // Backward compatibility: a model that omits the fields must not make
    // every draft unpublishable. The caller degrades this to one warning.
    return {
      findings,
      unverified: args.renderedAmounts.length > 0,
    };
  }

  const matches = matchRenderedAmountsToProvenance(
    args.provenance,
    args.renderedAmounts,
  );

  for (const [renderedIndex, rendered] of args.renderedAmounts.entries()) {
    const recordIndex = matches[renderedIndex];

    if (recordIndex === null) {
      findings.push({
        code: "unverifiable_amount",
        step_index: rendered.step_index,
        message:
          `Step ${
            rendered.step_index + 1
          } states ${rendered.value}${rendered.unit}, ` +
          `which does not trace to any amount recorded from the source.`,
      });
      continue;
    }

    const record = args.provenance[recordIndex];

    // Steps get folded (pre-timer preparation content absorbed into the
    // preparation step), split (one extraction step's two pour targets
    // becoming two separately-timed draft steps), and merged between
    // extraction and the final draft. The normalization/repair stages are
    // asked to re-point each record's step_index at the correct FINAL step
    // when that happens ("only step_index may need to change, and only to
    // correct for a split or merge") — but that renumbering is done by an
    // LLM that never sees the deterministic fold/split passes that run
    // afterward, so on live traffic it is reliably off by exactly one step,
    // in either direction: a Chemex bloom folded into the preparation step
    // (recorded step 2, rendered on step 1) and a German V60 pour split out
    // of a single merged extraction step (recorded step 3, rendered on step
    // 4; recorded step 4, rendered on step 5). In both live incidents the
    // VALUE was exactly right — only the step it ended up on shifted by one,
    // which is the expected footprint of routine step restructuring, not
    // evidence the number itself was invented or altered.
    //
    // A one-step drift is therefore tolerated: it falls through to the
    // ordinary literal/derived verification below, which is what actually
    // establishes whether the VALUE traces to the source. A drift of two or
    // more steps is still a hard block — nothing in fold/split/merge moves a
    // single record more than one step, so a bigger jump means the amount
    // most likely belongs to different source content entirely, which is
    // exactly the shape of mis-binding this check exists to catch.
    if (
      record.step_index >= 0 &&
      Math.abs(record.step_index - rendered.step_index) > 1
    ) {
      findings.push({
        code: "amount_step_binding_mismatch",
        step_index: rendered.step_index,
        message: `${rendered.value}${rendered.unit} was recorded for step ` +
          `${record.step_index + 1} but appears on step ${
            rendered.step_index + 1
          }.`,
      });
      continue;
    }

    if (record.provenance === "inferred") {
      findings.push({
        code: "inferred_amount_not_permitted",
        step_index: rendered.step_index,
        message:
          `${rendered.value}${rendered.unit} is marked inferred. Amounts must ` +
          `come from the source; only water temperature and grind size may be inferred.`,
      });
      continue;
    }

    if (record.provenance === "literal") {
      if (!record.source_quote) {
        findings.push({
          code: "unverifiable_amount",
          step_index: rendered.step_index,
          message:
            `${rendered.value}${rendered.unit} is marked literal but carries no source quote.`,
        });
        continue;
      }
      if (!quoteAppearsInSource(record.source_quote, args.requestText)) {
        findings.push({
          code: "amount_provenance_mismatch",
          step_index: rendered.step_index,
          message:
            `${rendered.value}${rendered.unit} cites "${record.source_quote}", ` +
            `which does not appear in the submitted text.`,
        });
      }
      continue;
    }

    // derived
    if (!record.rule || !DERIVED_RULES.has(record.rule)) {
      findings.push({
        code: "unsupported_derivation_rule",
        step_index: rendered.step_index,
        message: `${rendered.value}${rendered.unit} claims derivation rule ` +
          `"${record.rule ?? "none"}", which is not a recognised rule.`,
      });
      continue;
    }

    if (
      !record.rule_source_quote ||
      !quoteAppearsInSource(record.rule_source_quote, args.requestText)
    ) {
      findings.push({
        code: "amount_provenance_mismatch",
        step_index: rendered.step_index,
        message:
          `${rendered.value}${rendered.unit} is derived by "${record.rule}", but ` +
          `the rule itself does not appear in the submitted text.`,
      });
      continue;
    }

    const recomputed = recomputeDerivedValue(record);
    if (recomputed === null) {
      findings.push({
        code: "unsupported_derivation_rule",
        step_index: rendered.step_index,
        message:
          `${rendered.value}${rendered.unit} could not be recomputed from rule ` +
          `"${record.rule}" — its inputs are missing or incomplete.`,
      });
      continue;
    }

    if (Math.abs(recomputed - rendered.value) > DERIVED_TOLERANCE) {
      findings.push({
        code: "amount_provenance_mismatch",
        step_index: rendered.step_index,
        message:
          `${rendered.value}${rendered.unit} does not match its stated derivation ` +
          `"${record.rule}", which yields ${recomputed}.`,
      });
    }
  }

  // Cumulative water targets must STRICTLY increase: every pour adds water, so
  // two consecutive cumulative targets that are equal mean a pour added
  // nothing, which is wrong by construction.
  //
  // Strictness is the point. An earlier version only flagged a DECREASE, which
  // left a flat run (60, 60, 60, 60, 60) entirely unreported — precisely the
  // shape of the Japanese failure this check exists for.
  //
  // This is a second line of defence, not the primary one. When the extraction
  // correctly records 60/120/180/240/300 and the draft renders a flat 60, the
  // presence check above already fires `unverifiable_amount` for every
  // unmatched value. Monotonicity covers the case where the extraction is ALSO
  // flat, leaving presence with nothing to disagree about.
  let previousCumulative: number | null = null;
  for (const rendered of args.renderedAmounts) {
    if (!rendered.is_cumulative_water) {
      continue;
    }
    if (previousCumulative !== null && rendered.value <= previousCumulative) {
      findings.push({
        code: "non_monotonic_cumulative",
        step_index: rendered.step_index,
        message:
          `Cumulative water does not increase from ${previousCumulative} to ` +
          `${rendered.value} at step ${
            rendered.step_index + 1
          }; each pour must raise the running total.`,
      });
    }
    previousCumulative = Math.max(previousCumulative ?? 0, rendered.value);
  }

  return { findings, unverified: false };
}

// ---------------------------------------------------------------------
// G22 — timing landmark enforcement.
//
// The amounts half above catches an invented or rewritten NUMBER. This half
// catches an invented or rewritten CLOCK: a French V60 stating "complete at
// 3:00" emitted 3:10, a Spanish V60 stating "total 3:30-4:00" emitted 2:55,
// a Hario Switch (verify mode) stating "completes around 1:25" emitted
// 2:40, and video captions stating "bloom by 0:45, 60% by 1:15, all water
// by 1:45" emitted a step starting at 3:30 because the bloom and the first
// pour got double-counted into the running elapsed time. Every one of
// these stayed publishable, because nothing compared the final draft's
// timing against what the source actually said.
//
// Three source-traceable landmarks are checked, all of which already exist
// as fields the extraction/normalization stages populate — this adds no
// new extraction fields, only the comparison:
//
//  1. Total brew time — extraction.total_brew_time_seconds, when the source
//     stated one, must match the sum of the FINAL brew steps' durations.
//  2. A step's stated duration (duration_is_stated: true) must survive
//     unchanged into that step's final duration_seconds.
//  3. A step's elapsed landmark (elapsed_seconds, non-null) must equal the
//     sum of every FINAL brew step's duration that precedes it — i.e. the
//     step must actually begin, on the assembled timeline, when the source
//     said it would.
//
// Like verifyAmountProvenance, this is deliberately pure: it takes flat,
// already-resolved records — never raw step objects, never pipeline state
// (fold/split/timestamp-normalization are all parser.ts concerns) — and
// returns findings. The caller decides what "landmarks" and "renderedSteps"
// mean in terms of its own pipeline stages.

export type TimingLandmarkKind = "duration" | "elapsed";

/**
 * One source-traceable timing fact, captured BEFORE any pass that recomputes
 * duration_seconds/elapsed_seconds can have altered it — i.e. this is what
 * the source actually said, not what the final draft ended up with.
 */
export type TimingLandmark = {
  /** Index into the final draft steps this landmark corresponds to. */
  step_index: number;
  kind: TimingLandmarkKind;
  /**
   * For "duration": the stated duration, in seconds, for this step.
   * For "elapsed": the stated elapsed timestamp, in seconds, at which this
   * step's action begins.
   */
  seconds: number;
};

/** One step of the FINAL draft, as timing checks need to see it. */
export type RenderedTimingStep = {
  step_index: number;
  kind: "preparation" | "brew";
  duration_seconds: number;
};

export type TimingProvenanceFindingCode =
  | "total_brew_time_mismatch"
  | "stated_duration_changed"
  | "elapsed_landmark_mismatch";

export type TimingProvenanceFinding = {
  code: TimingProvenanceFindingCode;
  step_index: number;
  message: string;
};

export type VerifyTimingProvenanceArgs = {
  /** extraction.total_brew_time_seconds — null when the source stated none. */
  statedTotalBrewTimeSeconds: number | null;
  /** Every step of the FINAL draft, in order. */
  renderedSteps: RenderedTimingStep[];
  /** Source-traceable duration/elapsed facts, captured pre-mutation. */
  landmarks: TimingLandmark[];
};

export type VerifyTimingProvenanceResult = {
  findings: TimingProvenanceFinding[];
};

/**
 * Tolerance, in seconds, for a timing comparison whose emitted side is the
 * sum of `stepCount` step durations.
 *
 * The ONLY legitimate source of divergence between a source-stated timing
 * figure and the emitted one is integer-second rounding: every emitted
 * duration_seconds is a whole number, so distributing a stated figure across
 * N steps can lose at most half a second per step, bounding the summed error
 * at ceil(N / 2). Nothing else earns slack.
 *
 * In particular this deliberately has no percentage-of-target term. A
 * proportional tolerance says a longer brew may drift further, which is
 * physically backwards — rounding error tracks the number of steps, not the
 * length of the brew — and in practice it licensed the exact failure this
 * check exists to catch: the live French V60 incident emitted 3:10 against a
 * source-stated 3:00, a 10s drift that sat comfortably inside 10% of 180s.
 *
 * The 2s floor covers the degenerate single-step case (ceil(1/2) = 1) without
 * holding a one-step brew to sub-second exactness.
 */
function timingToleranceSeconds(stepCount: number): number {
  return Math.max(2, Math.ceil(stepCount / 2));
}

/**
 * Verifies that the final draft's timing traces to the source's stated
 * landmarks. Silence — not a warning — is the correct outcome when there is
 * nothing source-traceable to compare against: a recipe with no stated
 * total brew time and no step carrying duration_is_stated or elapsed_seconds
 * produces no findings at all, by construction (every branch below is
 * gated on a landmark actually being present).
 */
export function verifyTimingProvenance(
  args: VerifyTimingProvenanceArgs,
): VerifyTimingProvenanceResult {
  const findings: TimingProvenanceFinding[] = [];

  // 1. Total brew time.
  if (args.statedTotalBrewTimeSeconds !== null) {
    const brewSteps = args.renderedSteps.filter((step) => step.kind === "brew");
    const emittedTotalSeconds = brewSteps
      .reduce((sum, step) => sum + step.duration_seconds, 0);
    const tolerance = timingToleranceSeconds(brewSteps.length);

    if (
      Math.abs(emittedTotalSeconds - args.statedTotalBrewTimeSeconds) >
        tolerance
    ) {
      findings.push({
        code: "total_brew_time_mismatch",
        // Recipe-level, like a -1 amount record: no single step owns "the
        // total".
        step_index: -1,
        message:
          `The source states a total brew time of ${args.statedTotalBrewTimeSeconds}s, ` +
          `but the final brew steps sum to ${emittedTotalSeconds}s.`,
      });
    }
  }

  const renderedByIndex = new Map(
    args.renderedSteps.map((step) => [step.step_index, step]),
  );

  for (const landmark of args.landmarks) {
    const rendered = renderedByIndex.get(landmark.step_index);
    if (!rendered) {
      // Nothing in the final draft corresponds to this landmark's step
      // (e.g. it was folded away as pre-timer preparation content) — there
      // is nothing to compare, so this is silence, not a finding.
      continue;
    }

    // 2. Stated per-step duration.
    if (landmark.kind === "duration") {
      if (rendered.duration_seconds !== landmark.seconds) {
        findings.push({
          code: "stated_duration_changed",
          step_index: landmark.step_index,
          message:
            `Step ${
              landmark.step_index + 1
            } states a duration of ${landmark.seconds}s in the source, ` +
            `but the final draft emits ${rendered.duration_seconds}s.`,
        });
      }
      continue;
    }

    // 3. Elapsed landmark: the sum of every preceding BREW step's duration
    // must land on the stated elapsed timestamp.
    const precedingBrewSteps = args.renderedSteps.filter((step) =>
      step.step_index < landmark.step_index && step.kind === "brew"
    );
    const precedingSeconds = precedingBrewSteps
      .reduce((sum, step) => sum + step.duration_seconds, 0);
    const tolerance = timingToleranceSeconds(precedingBrewSteps.length);

    if (Math.abs(precedingSeconds - landmark.seconds) > tolerance) {
      findings.push({
        code: "elapsed_landmark_mismatch",
        step_index: landmark.step_index,
        message:
          `Step ${
            landmark.step_index + 1
          } should begin at ${landmark.seconds}s elapsed per the source, ` +
          `but the preceding brew steps sum to ${precedingSeconds}s.`,
      });
    }
  }

  return { findings };
}
