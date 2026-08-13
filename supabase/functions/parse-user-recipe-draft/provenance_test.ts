// Tests for provenance.ts (G22). Mirrors parser_test.ts's own style: plain
// Deno.test blocks with small local assert helpers, no std/assert import.
//
// Historically provenance.ts was treated as read-only here: its logic was
// already reviewed and this file's job was to characterize its ACTUAL
// behaviour against the eight production incidents it exists to catch, not
// to bend assertions to whatever the code happened to emit. That principle
// still governs every test below — an existing expectation is only ever
// changed with a physical/semantic justification, never "that is what the
// code emits now" (see HANDOFF-2026-08-12.md §7) — but it no longer means
// the file is frozen: plan 016 §4 Phase 1a deliberately extends
// provenance.ts's unit-comparison logic (Arabic/Persian lexicon coverage,
// an explicit empty-rendered-unit policy, and consuming the extraction
// stage's own `unit_kind` field), and the "Plan 016 §4 Phase 1a" section
// below tests that extension directly. Where the code's behaviour diverges
// from what its own docstring claims, that is called out explicitly in
// comments rather than worked around — see the "KNOWN GAP" tests further
// down.

import {
  type AmountProvenance,
  type RenderedAmount,
  type RenderedTimingStep,
  type TimingLandmark,
  verifyAmountProvenance,
  verifyTimingProvenance,
} from "./provenance.ts";

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

function findingCodes(
  result: ReturnType<typeof verifyAmountProvenance>,
): string[] {
  return result.findings.map((finding) => finding.code);
}

// ---------------------------------------------------------------------
// MUST produce findings — real production failures.
// ---------------------------------------------------------------------

Deno.test("literal: explicit 50 g pour emitted as 60 g is a mismatch (live incident)", () => {
  const requestText = "Pour 50 g of water over the grounds and let it bloom.";
  const provenance: AmountProvenance[] = [
    {
      value: 50,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      source_quote: "50 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 60, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assert(!result.unverified, "provenance was supplied; must not be unverified");
  assert(
    result.findings.length > 0,
    "an emitted 60 g with no matching 60 g provenance record must be a finding",
  );
  assertEquals(
    findingCodes(result),
    ["unverifiable_amount"],
    "the emitted value traces to no recorded source amount at all — the " +
      "recorded 50 g record is simply left unconsumed — so this is caught " +
      "by the presence check, not a literal-quote mismatch",
  );
});

Deno.test("literal: German '25g' bloom emitted as 60 g is unverifiable_amount (no record matches 60)", () => {
  const requestText = "25g Kaffee aufgießen und 30 Sekunden quellen lassen.";
  const provenance: AmountProvenance[] = [
    {
      value: 25,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      source_quote: "25g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 60, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["unverifiable_amount"],
    "60 g does not match the single recorded 25 g amount",
  );
  assertEquals(
    result.findings[0].step_index,
    0,
    "finding must point at the step the bad amount actually appears on",
  );
});

Deno.test("range: '60-90 g' recorded as the 90 g high endpoint, emitted as 100 g is a finding", () => {
  const requestText = "Use 60-90 g of coffee depending on strength.";
  const provenance: AmountProvenance[] = [
    {
      value: 90,
      unit: "g",
      step_index: -1,
      provenance: "derived",
      source_quote: null,
      rule: "range_endpoint",
      rule_source_quote: "60-90 g",
      rule_inputs: { low: 60, high: 90, endpoint: 1 },
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: -1, value: 100, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assert(
    result.findings.length > 0,
    "100 g does not match the recorded 90 g high-endpoint record",
  );
  assertEquals(findingCodes(result), ["unverifiable_amount"], "");
});

Deno.test("derived: rule outside DERIVED_RULES is unsupported_derivation_rule", () => {
  const requestText = "Bloom with 3x the dose of water.";
  const provenance: AmountProvenance[] = [
    {
      value: 75,
      unit: "g",
      step_index: 0,
      provenance: "derived",
      source_quote: null,
      rule: "triple_the_dose", // not a member of DERIVED_RULES
      rule_source_quote: "3x the dose",
      rule_inputs: { multiplier: 3, coffee_amount: 25 },
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 75, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["unsupported_derivation_rule"],
    "an out-of-set rule can never be recomputed, so it must always be a finding",
  );
});

Deno.test("derived: rule_source_quote absent from the request text is a mismatch", () => {
  const requestText = "Bloom with 75 g of water.";
  const provenance: AmountProvenance[] = [
    {
      value: 75,
      unit: "g",
      step_index: 0,
      provenance: "derived",
      source_quote: null,
      rule: "multiple_of_coffee",
      // Never appears in requestText above.
      rule_source_quote: "three times the dose",
      rule_inputs: { multiplier: 3, coffee_amount: 25 },
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 75, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["amount_provenance_mismatch"],
    "the rule itself must trace to a source span, or it is unverifiable",
  );
});

Deno.test("inferred amount is never permitted, even when it matches the emitted value", () => {
  const requestText = "Grind fine and pour water over the grounds.";
  const provenance: AmountProvenance[] = [
    {
      value: 36,
      unit: "g",
      step_index: 0,
      provenance: "inferred",
      source_quote: null,
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 36, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["inferred_amount_not_permitted"],
    "only water_temp and grind_size may be inferred — never an amount",
  );
});

// A one-step drift is tolerated (see the comment above the binding check in
// provenance.ts): a live pass found this exact shape on two real, CORRECT
// drafts — a Chemex bloom folded into the preparation step (recorded step 2,
// rendered on step 1) and a German V60 pour split out of a merged extraction
// step (recorded step 3, rendered on step 4). Both are the ordinary
// footprint of step folding/splitting between extraction and the final
// draft, not a data error, so a one-step-adjacent binding no longer blocks
// on its own — the value still has to pass the literal/derived checks below,
// which is what actually verifies it traces to the source.
Deno.test("a record bound to an ADJACENT step (one-step drift) is not a finding on its own", () => {
  const requestText = "Pour 50 g at 0:30, then pour 50 g more at 1:00.";
  const provenance: AmountProvenance[] = [
    {
      value: 50,
      unit: "g",
      // Recorded (0-indexed) for step index 1 — "step 2" in 1-indexed
      // human terms.
      step_index: 1,
      provenance: "literal",
      source_quote: "50 g more",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    // Rendered one step over, on step index 2 — "step 3". A single fold or
    // split is enough to produce exactly this drift.
    { step_index: 2, value: 50, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "the value 50 g cites \"50 g more\", which genuinely appears in the " +
      "source, and a one-step drift alone is not evidence of a mis-bound " +
      "amount — it is the expected footprint of step restructuring",
  );
});

// A drift of TWO OR MORE steps is still a hard block: nothing in the
// fold/split/merge passes moves a single record more than one step, so a
// bigger jump means the amount most likely belongs to different source
// content entirely — exactly the mis-binding this check exists to catch.
Deno.test("a record bound to a NON-adjacent step (two-step drift) is still amount_step_binding_mismatch", () => {
  const requestText = "Pour 50 g at 0:30, then pour 50 g more at 1:00.";
  const provenance: AmountProvenance[] = [
    {
      value: 50,
      unit: "g",
      // Recorded (0-indexed) for step index 0 — "step 1" in 1-indexed
      // human terms.
      step_index: 0,
      provenance: "literal",
      source_quote: "50 g more",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    // But it actually rendered on step index 3 — "step 4", a two-step drift
    // no single fold/split/merge can produce.
    { step_index: 3, value: 50, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["amount_step_binding_mismatch"],
    "per-step binding is not optional beyond a one-step drift — a value " +
      "can be textually correct yet bound to a step far from where it was " +
      "recorded",
  );
  assertEquals(
    result.findings[0].step_index,
    3,
    "the finding must report where the mismatch was RENDERED",
  );
});

// REGRESSION GUARD — false-positive pass, 2026-08-12 live capture
// 96e68d2f-2224-498e-be67-aaa515708a6c (Chemex). Extraction recorded the
// 60 g/90 g bloom range at its own step index 1 ("Bloom with 60g to 90g
// water"), but the final draft folded that entire bloom step into the
// preparation step (kind: "preparation", step_order 1) ahead of it, so the
// values rendered on step_index 0. The values were never wrong — the source
// really does say "60 to 90 grams of bloom water" — only the step they
// landed on shifted by one because folding removed a step boundary.
Deno.test("REGRESSION (live capture 96e68d2f, Chemex): bloom folded into preparation is not a binding finding", () => {
  const requestText =
    "Fold the filter, rinse it with hot water, and dose in your coffee. " +
    "In terms of the bloom, do exactly as the V60: 2 to 1 to 3 to 1 in " +
    "terms of bloom water to coffee dose, so 60 to 90 grams of bloom " +
    "water, and let that bloom for at least 45 seconds.";
  const provenance: AmountProvenance[] = [
    {
      value: 60,
      unit: "g",
      step_index: 1,
      provenance: "literal",
      source_quote: "60",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
    {
      value: 90,
      unit: "g",
      step_index: 1,
      provenance: "literal",
      source_quote: "90 grams",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    // Folded into the preparation step, step_index 0 — a one-step drift.
    { step_index: 0, value: 60, unit: "g", is_cumulative_water: false },
    { step_index: 0, value: 90, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "both values cite text genuinely present in the source, and folding the " +
      "bloom step into preparation is a one-step drift, not a mismatch",
  );
});

// REGRESSION GUARD — false-positive pass, 2026-08-12 live capture
// a48f947e-6ca7-4578-8917-e2c4b6369986 (German V60). Extraction recorded a
// single merged step ("Gieße bis zu 175g, nach einer weiteren Minute gieße
// auf 300g") whose 175 g and 300 g targets both carried the SAME extraction
// step_index. The final draft split that merged step into two separately
// timed pours, so 175 g rendered one step later than recorded and 300 g
// rendered two steps later — the normalization stage's own step_index
// correction bumped 300 g by one step but not the full two the split
// actually required. 175 g's one-step drift is tolerated; 300 g's two-step
// drift is still reported, because nothing about a single split explains a
// two-step jump.
Deno.test("REGRESSION (live capture a48f947e, German V60): a step split leaves a one-step drift untouched and a two-step drift still caught", () => {
  const requestText =
    "Gieße bis zu 175g, nach einer weiteren Minute gieße auf 300g.";
  const provenance: AmountProvenance[] = [
    {
      value: 175,
      unit: "g",
      step_index: 2,
      provenance: "literal",
      source_quote: "175g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
    {
      value: 300,
      unit: "g",
      // Carried through from extraction unchanged, still pointing at the
      // original merged step (2) — the normalization stage's step_index
      // correction for this record never caught up with the split.
      step_index: 2,
      provenance: "literal",
      source_quote: "300g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    // "Bei 1:30 auf 175g aufgießen." — one step later than recorded (2 -> 3).
    { step_index: 3, value: 175, unit: "g", is_cumulative_water: false },
    // "Auf 300g aufgießen." — two steps later than recorded (2 -> 4).
    { step_index: 4, value: 300, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["amount_step_binding_mismatch"],
    "175 g's one-step drift (2 -> 3) is tolerated; 300 g's two-step drift " +
      "(2 -> 4) is not — the normalization stage's step_index correction " +
      "for this record never caught up with the split",
  );
  assertEquals(
    result.findings[0].step_index,
    4,
    "the finding must report where the 300 g mismatch was RENDERED",
  );
});

// ---------------------------------------------------------------------
// Plan 020 D4 — nearest-step_index pairing (flash-chilled 150 g ice / 150 g
// water collision, confirmed on production capture
// 73d06a79-5e48-497f-bf71-ebd48426caa4 via
// scripts/recipe-draft-replay/gate-replay.ts). See the block comment above
// `stepDistance`/`matchRenderedAmountsToProvenance` in provenance.ts for the
// full mechanism and the Hario regression (127f391d) that decided the
// sentinel-distance-zero design over the initially-tried sentinel-distance-
// Infinity one.
// ---------------------------------------------------------------------

Deno.test("D4: a value rendered twice pairs each rendering to its OWN nearest record, not whichever is unconsumed first (flash-chilled shape)", () => {
  // Reproduces capture 73d06a79 exactly: ice is deliberately never
  // extracted (it is not brew water), so the ONLY 150 g record on file
  // belongs to a later cumulative pour target. The ice's rendered 150 g
  // comes first in array order; the old `unconsumed.find()` matcher let it
  // steal the pour's record, leaving the pour unmatched two steps later.
  const requestText =
    "Add 150 g ice to the server. Start the timer and bloom with 75 g " +
    "water. At 0:45 pour to a total of 150 g. At 1:15 pour to a total of " +
    "225 g.";
  const provenance: AmountProvenance[] = [
    {
      value: 150,
      unit: "g",
      // The pour target's own extraction step_index — matches step 2
      // exactly.
      step_index: 2,
      provenance: "literal",
      source_quote: "150 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    // The ice, rendered FIRST in array order but with no record of its own.
    { step_index: 0, value: 150, unit: "g", is_cumulative_water: false },
    // The pour target, rendered later, at the record's own step.
    { step_index: 2, value: 150, unit: "g", is_cumulative_water: true },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["unverifiable_amount"],
    "the pour target (distance 0 from the record) must claim the sole " +
      "150 g record; the ice is honestly left unmatched (it truly has no " +
      "provenance) rather than stealing the pour's record and reporting a " +
      "fabricated two-step binding mismatch",
  );
  assertEquals(
    result.findings[0].step_index,
    0,
    "the surviving finding must be on the ICE's step (0), not the pour's " +
      "step (2) — the pour matched cleanly and produced no finding at all",
  );
});

Deno.test("D4: nearest-step_index pairing prefers the closer of two candidate records over array order", () => {
  // A stronger version of the case above: now there are TWO 40 g records,
  // one near each rendering, deliberately listed in an order that would
  // trip up first-match-wins (the record for the LATER rendering is listed
  // FIRST in the provenance array).
  const requestText =
    "Add 40 g of coffee to the filter. Later, add another 40 g of coffee.";
  const provenance: AmountProvenance[] = [
    {
      value: 40,
      unit: "g",
      // Belongs to the SECOND rendering (step 3) but appears FIRST in the
      // array — array-order matching would wrongly grab this for step 0.
      step_index: 3,
      provenance: "literal",
      source_quote: "40 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
    {
      value: 40,
      unit: "g",
      // Belongs to the FIRST rendering (step 0).
      step_index: 0,
      provenance: "literal",
      source_quote: "40 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 40, unit: "g", is_cumulative_water: false },
    { step_index: 3, value: 40, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "each rendering must pair with the record at its OWN step (distance " +
      "0 both ways) regardless of which record appears first in the " +
      "provenance array — neither pairing should report a binding drift",
  );
});

Deno.test("D4 tie rule: two equidistant candidates resolve to the EARLIER record, deterministically", () => {
  // The rendered amount sits exactly between two compatible records, one
  // step before and one step after — both distance 1. The documented tie
  // rule (provenance.ts, above matchRenderedAmountsToProvenance) prefers
  // the earlier-appearing rendered amount, then the earlier-appearing
  // provenance record; with only one rendered amount here, that reduces to
  // "prefer the earlier record".
  const requestText = "Pour 30 g, then pour more, then pour 30 g again.";
  const provenance: AmountProvenance[] = [
    {
      value: 30,
      unit: "g",
      step_index: 0, // distance 1 from the rendering at step 1
      provenance: "literal",
      source_quote: "30 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
    {
      value: 30,
      unit: "g",
      step_index: 2, // also distance 1 from the rendering at step 1
      provenance: "derived",
      source_quote: null,
      // A rule outside DERIVED_RULES: if THIS record were picked instead,
      // the test would see unsupported_derivation_rule, not a clean pass —
      // making the tie-break's outcome observable, not just inferred.
      rule: "not_a_real_rule",
      rule_source_quote: "30 g again",
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 1, value: 30, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "the tie must resolve to the EARLIER record (step_index 0, a clean " +
      "literal quote) rather than the later one (step_index 2, an " +
      "unsupported derivation rule) — if the later record had won, this " +
      "would report unsupported_derivation_rule instead of passing clean",
  );
});

Deno.test("D4 sentinel: a step_index -1 recipe-level record is not treated as a fabricated large positional distance", () => {
  // Guards the literal failure mode named in the task brief: naively
  // computing Math.abs(-1 - rendered.step_index) would score a rendering on
  // step 3 as "distance 4" from a -1 record — as if the sentinel were one
  // step before step 0. A step_index of -1 is a marker, not a position, and
  // must never be fed into that arithmetic. This is checked here via a
  // record that would ONLY match if the sentinel is treated as compatible
  // (not excluded, not penalised into unreachability) with a rendering far
  // from step 0.
  const requestText = "Use a 60 g dose of coffee. ... (many steps later) ...";
  const provenance: AmountProvenance[] = [
    {
      value: 60,
      unit: "g",
      step_index: -1, // recipe-level sentinel: the recipe's overall dose.
      provenance: "literal",
      source_quote: "60 g dose",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    // Rendered far from step 0 — a naive |-1 - 3| = 4 formula would still
    // "match" this (the sentinel is the only candidate either way), but
    // must not ALSO trip the >1 binding-drift check the way a real
    // positional record with step_index 4 steps away would.
    { step_index: 3, value: 60, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "a recipe-level (-1) record must never be treated as a positionally " +
      "distant record — it is compatible with a rendering anywhere in the " +
      "recipe, so this must pass with no binding-mismatch finding",
  );
});

Deno.test("D4 sentinel vs positional: a rendering exactly at a record's own step is not displaced by an unrelated sentinel duplicate of the same value", () => {
  // REGRESSION GUARD — this is the shape that broke when the sentinel was
  // first tried at distance Infinity: live capture 127f391d ("Hario full
  // 4") carries the SAME value recorded BOTH as a step_index -1 sentinel
  // AND, redundantly, at an unrelated positional step_index that the value
  // is never actually re-stated at. The draft renders the value exactly
  // ONCE, in the preparation step. Distance-zero sentinel treatment means
  // the sentinel ties with an exact positional match rather than losing to
  // a same-value duplicate parked at some other, irrelevant step.
  const requestText = "Add 20 grams of beans and 260 grams of water.";
  const provenance: AmountProvenance[] = [
    {
      value: 20,
      unit: "g",
      step_index: -1, // the recipe-level dose.
      provenance: "literal",
      source_quote: "20 grams of beans",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
    {
      value: 20,
      unit: "g",
      // A redundant duplicate at an unrelated step, far from where the
      // value is actually rendered (step 0).
      step_index: 2,
      provenance: "literal",
      source_quote: "20 grams of beans",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 20, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "the rendering at step 0 must pair with the sentinel record (distance " +
      "0, tied with nothing closer) rather than the unrelated positional " +
      "duplicate at step 2 (distance 2), which would fabricate a " +
      "two-step amount_step_binding_mismatch — exactly what regressed " +
      "before the sentinel distance was corrected from Infinity to 0",
  );
});

Deno.test("D4 non-regression: a single matching record with no competing candidates behaves exactly as before this fix", () => {
  // The ordinary, overwhelmingly common case: one rendered amount, one
  // compatible record, nothing else in play. Nearest-step_index pairing
  // must not change this at all.
  const requestText = "Add 42 g of coffee to the filter.";
  const provenance: AmountProvenance[] = [
    {
      value: 42,
      unit: "g",
      step_index: 5, // far from where it renders — irrelevant here, since
      // it is the only candidate: this exercises that "only candidate"
      // still wins regardless of distance, then falls through to the
      // ordinary one-vs-two-step drift check exactly as before.
      provenance: "literal",
      source_quote: "42 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 5, value: 42, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "a lone compatible record at the exact same step as its rendering " +
      "must still pass cleanly",
  );
});

// ---------------------------------------------------------------------
// Japanese cumulative-pour incident: five ascending pours (60/120/180/
// 240/300 ml) all emitted as 60 ml. See provenance.ts's own file-header
// comment (lines 3-7) and the design doc's "non_monotonic_cumulative"
// rationale (plans/009 §G22 settled design, point 1).
//
// IMPORTANT — see the "KNOWN GAP" test at the bottom of this file. The
// literal historical incident (rendering AND extraction both collapse to
// a flat run of identical values) does NOT actually reach
// non_monotonic_cumulative: a flat sequence is never "< previous", only a
// genuine decrease is. The realistic reproduction below — correct
// per-step extraction, buggy flat rendering — is what the code's presence
// check (rule 1, "an emitted amount with NO provenance record is
// unexplained") actually catches, and it is what real deployments look
// like: normalization/repair carry `extracted_amounts` forward from
// extraction independently of what the deterministic/LLM rewrite passes
// later render.
// ---------------------------------------------------------------------

Deno.test("Japanese cumulative pours: correctly-recorded 60/120/180/240/300 ml but ALL rendered as 60 ml produces findings", () => {
  const requestText =
    "60mlを注ぎ、その後合計120ml、180ml、240ml、300mlになるまで注ぎます。";
  const provenance: AmountProvenance[] = [60, 120, 180, 240, 300].map(
    (value, index): AmountProvenance => ({
      value,
      unit: "ml",
      step_index: index,
      provenance: "literal",
      source_quote: `${value}ml`,
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    }),
  );
  const renderedAmounts: RenderedAmount[] = [0, 1, 2, 3, 4].map(
    (stepIndex): RenderedAmount => ({
      step_index: stepIndex,
      value: 60,
      unit: "ml",
      is_cumulative_water: true,
    }),
  );

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assert(!result.unverified, "provenance was supplied");
  assert(
    result.findings.length > 0,
    "flattening five ascending pours to 60 ml must produce at least one finding",
  );
  // Step 0's rendered 60 ml genuinely consumes the 60 ml record, so steps 1-4
  // are flagged twice over: once by presence (nothing left to match) and once
  // by monotonicity (the cumulative total never rises). Both are correct and
  // independent — presence catches it because the extraction was right, and
  // monotonicity would still catch it if the extraction had been flat too.
  assertEquals(
    [...new Set(result.findings.map((finding) => finding.step_index))].sort(),
    [1, 2, 3, 4],
    "steps 2-5 rendered 60 ml with no unconsumed matching record",
  );
  // Both defences fire here, independently, and that is the desired outcome:
  // presence catches it because the extraction recorded the correct ascending
  // values and four of them go unconsumed, while monotonicity catches it
  // because a cumulative total that never rises means four pours added no
  // water. Either alone would be enough; having both means the check survives
  // the extraction being wrong in the same way the rendering is.
  assertEquals(
    [...new Set(findingCodes(result))].sort(),
    ["non_monotonic_cumulative", "unverifiable_amount"],
    "flattened cumulative pours are caught by presence AND by monotonicity",
  );
});

Deno.test("non_monotonic_cumulative fires on a genuine cumulative decrease", () => {
  // A distinct failure shape from the flattened-Japanese case above: every
  // individual rendered value legitimately matches SOME provenance record
  // (so the presence/matching loop passes silently for all five), but a
  // step-reordering-style bug renders them out of sequence, so the third
  // pour (90) is LESS than the second (120) — a genuine decrease the
  // presence check cannot see, because presence matching is order-blind.
  const requestText =
    "Pour to 60 ml, then to 120 ml, then to 90 ml, then to 240 ml, then to 300 ml.";
  const values = [60, 120, 90, 240, 300];
  const provenance: AmountProvenance[] = values.map(
    (value, index): AmountProvenance => ({
      value,
      unit: "ml",
      step_index: index,
      provenance: "literal",
      source_quote: `to ${value} ml`,
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    }),
  );
  const renderedAmounts: RenderedAmount[] = values.map(
    (value, stepIndex): RenderedAmount => ({
      step_index: stepIndex,
      value,
      unit: "ml",
      is_cumulative_water: true,
    }),
  );

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["non_monotonic_cumulative"],
    "every value individually matches a record, so only the monotonic check can catch this",
  );
  assertEquals(result.findings[0].step_index, 2, "");
});

// ---------------------------------------------------------------------
// MUST NOT produce findings — legitimate cases.
// ---------------------------------------------------------------------

Deno.test("Kalita: derived multiple_of_coffee ('three times the dose') recomputes cleanly", () => {
  const requestText =
    "Bloom with three times the dose of water, about 75 g for a 25 g dose.";
  const provenance: AmountProvenance[] = [
    {
      value: 75,
      unit: "g",
      step_index: 0,
      provenance: "derived",
      source_quote: null,
      rule: "multiple_of_coffee",
      rule_source_quote: "three times the dose",
      rule_inputs: { multiplier: 3, coffee_amount: 25 },
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 75, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(result.findings, [], "");
});

// Chemex "60 g/L at 30 g coffee -> 500 g water" from the task brief: see
// recomputeDerivedValue's "concentration" branch. It computes
// (grams_per_litre / 1000) * millilitres — i.e. COFFEE mass from a
// concentration and a WATER volume, exactly the standard "X g/L ratio at Y
// mL water gives Z g coffee" formula. It has no inverse branch that solves
// for water volume given a concentration and a coffee mass. There is no
// physically honest rule_inputs that recomputes to 500 from "60 g/L at 30 g
// coffee" — see this file's report for the full explanation. The test
// below instead exercises the rule as it is actually specified: 60 g/L at
// 500 mL water legitimately derives the 30 g coffee dose.
Deno.test("Chemex-shaped: derived concentration recomputes coffee mass from g/L and water volume", () => {
  const requestText =
    "Use a ratio of 60 grams per liter: 30 g coffee to 500 g water.";
  const provenance: AmountProvenance[] = [
    {
      value: 30,
      unit: "g",
      step_index: -1,
      provenance: "derived",
      source_quote: null,
      rule: "concentration",
      rule_source_quote: "60 grams per liter",
      rule_inputs: { grams_per_litre: 60, millilitres: 500 },
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: -1, value: 30, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(result.findings, [], "");
});

Deno.test("range_endpoint taking the low end (endpoint: 0) is not a finding", () => {
  const requestText = "Grind coarse and use 60-90 g of coffee.";
  const provenance: AmountProvenance[] = [
    {
      value: 60,
      unit: "g",
      step_index: 0,
      provenance: "derived",
      source_quote: null,
      rule: "range_endpoint",
      rule_source_quote: "60-90 g",
      rule_inputs: { low: 60, high: 90, endpoint: 0 },
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 60, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(result.findings, [], "");
});

Deno.test("a literal quote that appears verbatim is not a finding", () => {
  const requestText = "Add 42 g of coffee to the filter.";
  const provenance: AmountProvenance[] = [
    {
      value: 42,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      source_quote: "42 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 42, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(result.findings, [], "");
});

Deno.test("empty provenance array with rendered amounts is unverified, not a finding", () => {
  const requestText = "Add 42 g of coffee to the filter.";
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 42, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance: [],
  });

  assertEquals(
    result.findings,
    [],
    "no provenance supplied must never itself be a finding",
  );
  assertEquals(
    result.unverified,
    true,
    "must degrade to the caller's single warning path",
  );
});

Deno.test("empty provenance array with no rendered amounts is not even unverified", () => {
  const result = verifyAmountProvenance({
    requestText: "Grind fine.",
    renderedAmounts: [],
    provenance: [],
  });

  assertEquals(result.findings, [], "");
  assertEquals(
    result.unverified,
    false,
    "nothing was rendered, so there is nothing to warn about either",
  );
});

// ---------------------------------------------------------------------
// Plan 016 §4 Phase 1a — unit comparison.
//
// D1 (Arabic/Persian lexicon gap): live captures recorded native-script
// units ("جرام", "گرم", "میلی‌لیتر") on the extraction record while the
// RENDERED side stayed plain ASCII "g"/"ml" (the model writes the
// scalable-unit token in Latin script even inside an otherwise-Arabic/
// Persian sentence). Every amount in those captures flagged untraceable.
//
// D1-German (empty rendered unit): a range's first expression, e.g. the
// "50" half of "50-70g", renders with NO unit — this is correct output,
// not a bug (see EXPRESSION_REGEX's comment in parser.ts and Fix E). An
// empty rendered unit must not become a wildcard, so it is accepted only
// against a record that resolves to mass_or_volume.
//
// unit_kind (Phase 1b contract, parser.ts): a nullable/defaulted field on
// each extraction record. Present+conclusive is preferred over the
// lexicon; absent or null falls back to the lexicon unchanged.
// ---------------------------------------------------------------------

Deno.test("D1: Arabic record unit 'جرام' (gram) vs ASCII rendered 'g' is not a finding", () => {
  const requestText = "أضف 40 جرام من القهوة إلى الفلتر.";
  const provenance: AmountProvenance[] = [
    {
      value: 40,
      unit: "جرام",
      step_index: 1,
      provenance: "literal",
      source_quote: "40 جرام",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 1, value: 40, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    result.findings,
    [],
    "جرام (Arabic 'gram') and ASCII 'g' must fold to the same mass_or_volume " +
      "bucket via the extended lexicon — this is the exact live-capture shape " +
      "that flagged every Arabic amount as untraceable before the fix",
  );
});

Deno.test("D1: reverse direction — ASCII record unit 'g' vs native-script Arabic rendered unit 'جرام' is not a finding", () => {
  const requestText = "Add 40 g of coffee to the filter.";
  const provenance: AmountProvenance[] = [
    {
      value: 40,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      source_quote: "40 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    // Unusual but the comparison must be symmetric: the lexicon is applied
    // to whichever side actually needs it, regardless of which side (record
    // or rendered) carries the native-script word.
    { step_index: 0, value: 40, unit: "جرام", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(result.findings, [], "the comparison is symmetric in which side is native-script");
});

Deno.test("D1: Persian record unit 'گرم' (gram) vs ASCII rendered 'g' is not a finding", () => {
  const requestText = "25 گرم قهوه اضافه کنید.";
  const provenance: AmountProvenance[] = [
    {
      value: 25,
      unit: "گرم",
      step_index: 0,
      provenance: "literal",
      source_quote: "25 گرم",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 25, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(result.findings, [], "گرم (Persian 'gram') must fold to mass_or_volume against ASCII 'g'");
});

Deno.test("D1: reverse direction — ASCII record unit 'g' vs native-script Persian rendered unit 'گرم' is not a finding", () => {
  const requestText = "Add 25 g of coffee.";
  const provenance: AmountProvenance[] = [
    {
      value: 25,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      source_quote: "25 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 25, unit: "گرم", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(result.findings, [], "the comparison is symmetric in which side is native-script");
});

Deno.test("D1: Persian record unit 'میلی‌لیتر' (millilitre, with ZWNJ) vs ASCII rendered 'g' is not a finding", () => {
  // Deliberately compares a Persian VOLUME word against an ASCII MASS unit:
  // both fold to mass_or_volume by the same density~1 precedent the loose
  // g/ml folding already applies for English/Russian, and this is also the
  // exact live-capture shape (Persian blocked captures recorded
  // "میلی‌لیتر"). The ZWNJ (U+200C) inside the word is the point of this
  // test — normalizeUnitForComparison must strip it defensively.
  const requestText = "300 میلی‌لیتر آب اضافه کنید.";
  const provenance: AmountProvenance[] = [
    {
      value: 300,
      unit: "میلی‌لیتر",
      step_index: 0,
      provenance: "literal",
      source_quote: "300 میلی‌لیتر",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 300, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    result.findings,
    [],
    "the ZWNJ-joined Persian word for millilitre must normalize the same as " +
      "its space-joined or unjoined spellings, and fold to mass_or_volume",
  );
});

Deno.test("D1-German: a unit-less rendered amount matches a mass record — 'value alone' policy for empty rendered unit", () => {
  // Reproduces the German live-capture shape exactly: a stated "50-70g"
  // range's first expression renders as a bare "50" with no trailing unit
  // (see EXPRESSION_REGEX's own comment in parser.ts — this is correct
  // rendering, not a bug), while the extraction record still carries its
  // real unit "g".
  const requestText = "Gieße 50-70g Wasser über den Kaffee.";
  const provenance: AmountProvenance[] = [
    {
      value: 50,
      unit: "g",
      step_index: 1,
      provenance: "literal",
      source_quote: "50",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 1, value: 50, unit: "", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    result.findings,
    [],
    "a legitimately unit-less rendering must not block against a record " +
      "that resolves to mass_or_volume — this was the German false block " +
      "('Step 3 states 50, which does not trace to any amount recorded')",
  );
});

Deno.test("D1-German: a unit-less rendered amount does NOT match a time record — this is the check's whole purpose", () => {
  // The empty-unit policy must not become a wildcard: it is only ever
  // compatible with a record that resolves to mass_or_volume. A record
  // that is conclusively 'time' (via unit_kind) must still fail against a
  // unit-less rendering, or the check could no longer catch a mass figure
  // being silently matched against a time or percent record — exactly what
  // this module's own docstring says normalizeUnitForComparison exists to
  // prevent.
  const requestText = "Let it steep for 50 seconds.";
  const provenance: AmountProvenance[] = [
    {
      value: 50,
      unit: "s",
      unit_kind: "time",
      step_index: 0,
      provenance: "literal",
      source_quote: "50 seconds",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 50, unit: "", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    findingCodes(result),
    ["unverifiable_amount"],
    "a time record must still fail against a unit-less rendering, even " +
      "though a mass record with the identical shape passes",
  );
});

Deno.test("D1-German: a unit-less rendered amount does NOT match a percent record, without any unit_kind at all", () => {
  // Same guarantee as above, but exercised via the LEXICON path (no
  // unit_kind at all) rather than unit_kind: the string '%' never appears
  // in MASS_UNIT_WORDS/VOLUME_UNIT_WORDS, so normalizeUnitForComparison
  // leaves it as '%', which is never mass_or_volume — the empty-unit
  // policy correctly rejects it with no unit_kind involved.
  const requestText = "Use a ratio of 2% by weight.";
  const provenance: AmountProvenance[] = [
    {
      value: 2,
      unit: "%",
      step_index: 0,
      provenance: "literal",
      source_quote: "2%",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 2, unit: "", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    findingCodes(result),
    ["unverifiable_amount"],
    "'%' never resolves to mass_or_volume through the lexicon, so a " +
      "unit-less rendering must still fail against it",
  );
});

Deno.test("unit_kind: present and conclusive overrides an unrecognized unit string the lexicon cannot classify", () => {
  // 'oz' is not in MASS_UNIT_WORDS/VOLUME_UNIT_WORDS, so the lexicon alone
  // would normalize it to the literal string 'oz' and never match ASCII
  // 'g' — exactly the kind of false block the durable unit_kind mechanism
  // exists to prevent for any unit the lexicon doesn't happen to list.
  const requestText = "Add 2 oz of coffee.";
  const provenance: AmountProvenance[] = [
    {
      value: 2,
      unit: "oz",
      unit_kind: "mass",
      step_index: 0,
      provenance: "literal",
      source_quote: "2 oz",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 2, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    result.findings,
    [],
    "unit_kind: 'mass' must be preferred over the lexicon outright, " +
      "classifying 'oz' as mass_or_volume even though the lexicon alone " +
      "would leave it as the unmatched literal string 'oz'",
  );
});

Deno.test("unit_kind: absent (field omitted entirely) falls back to the lexicon unchanged", () => {
  // No unit_kind property at all — every existing capture, fixture, and any
  // provider that ignores the field looks exactly like this. Must behave
  // identically to pre-Phase-1b: the lexicon alone resolves 'جرام' to
  // mass_or_volume.
  const requestText = "أضف 40 جرام من القهوة.";
  const provenance: AmountProvenance[] = [
    {
      value: 40,
      unit: "جرام",
      step_index: 0,
      provenance: "literal",
      source_quote: "40 جرام",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
      // unit_kind intentionally omitted.
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 40, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(result.findings, [], "an absent unit_kind must fall back to the lexicon, not fail open or closed");
});

Deno.test("unit_kind: explicitly null falls back to the lexicon exactly like absent", () => {
  const requestText = "أضف 40 جرام من القهوة.";
  const provenance: AmountProvenance[] = [
    {
      value: 40,
      unit: "جرام",
      unit_kind: null,
      step_index: 0,
      provenance: "literal",
      source_quote: "40 جرام",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 40, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    result.findings,
    [],
    "unit_kind: null must fall back to the lexicon exactly like an absent field",
  );
});

Deno.test("unit_kind: 'volume' is compatible with a mass-classified rendered unit (mass/volume remain mutually compatible)", () => {
  const requestText = "Pour 500 ml of water.";
  const provenance: AmountProvenance[] = [
    {
      value: 500,
      unit: "ml",
      unit_kind: "volume",
      step_index: 0,
      provenance: "literal",
      source_quote: "500 ml",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 500, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    result.findings,
    [],
    "unit_kind 'volume' folds to the same mass_or_volume bucket as 'mass', " +
      "preserving the existing density~1 precedent",
  );
});

Deno.test("REGRESSION — existing mass_or_volume behaviour is unchanged: an ASCII 'g' record still folds against an ASCII 'ml' rendered unit with no unit_kind at all", () => {
  const requestText = "Pour 300 g of water over the grounds.";
  const provenance: AmountProvenance[] = [
    {
      value: 300,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      source_quote: "300 g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 300, unit: "ml", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({ requestText, renderedAmounts, provenance });

  assertEquals(
    result.findings,
    [],
    "g vs ml folding (density~1 for water) must be unchanged by this fix",
  );
});

// ---------------------------------------------------------------------
// quoteAppearsInSource, exercised indirectly through the literal branch.
// ---------------------------------------------------------------------

Deno.test("quoteAppearsInSource: whitespace differences still match ('60  g' vs '60 g')", () => {
  const requestText = "Pour 60 g of water over the grounds.";
  const provenance: AmountProvenance[] = [
    {
      value: 60,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      // Double space where the source has a single space.
      source_quote: "60  g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 60, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    result.findings,
    [],
    "whitespace-only differences must not fail the quote check",
  );
});

Deno.test("quoteAppearsInSource: a quote absent from the text does not match", () => {
  const requestText = "Pour 60 g of water over the grounds.";
  const provenance: AmountProvenance[] = [
    {
      value: 60,
      unit: "g",
      step_index: 0,
      provenance: "literal",
      // Not present anywhere in requestText.
      source_quote: "60-90g",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];
  const renderedAmounts: RenderedAmount[] = [
    { step_index: 0, value: 60, unit: "g", is_cumulative_water: false },
  ];

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  assertEquals(
    findingCodes(result),
    ["amount_provenance_mismatch"],
    "a quote that does not literally occur in the source must be a mismatch",
  );
});

// ---------------------------------------------------------------------
// KNOWN GAP — documented, not fixed. See this file's task report.
//
// REGRESSION GUARD (was a KNOWN GAP, now closed).
//
// The monotonic-cumulative check originally compared each cumulative value
// against a running MAX using strict "<", so a run of IDENTICAL values was
// never "less than" its predecessor and never fired. That mattered because a
// single LLM call produces both the extraction and the rendering: when the
// model got stuck on one figure, provenance recorded five 60 ml entries whose
// quotes were all genuinely present in the source, every rendered 60 ml
// consumed its own matching record, presence passed all five silently, and
// monotonicity stayed quiet too. Zero findings for a recipe whose five
// ascending pours had collapsed into one -- exactly the Japanese incident.
//
// The comparison is now "<=": a pour that leaves the cumulative total
// unchanged added no water, which is wrong by construction. This test asserts
// the flat run IS reported.
// ---------------------------------------------------------------------

Deno.test("a flat run of identical cumulative amounts is reported even when its provenance is equally flat", () => {
  const requestText =
    "Pour to 60 ml, then continue pouring to 60 ml, five times.";
  const provenance: AmountProvenance[] = [0, 1, 2, 3, 4].map(
    (stepIndex): AmountProvenance => ({
      value: 60,
      unit: "ml",
      step_index: stepIndex,
      provenance: "literal",
      // Reused verbatim quote — genuinely present in requestText, so the
      // literal-quote check cannot distinguish "correct" from "stuck".
      source_quote: "60 ml",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    }),
  );
  const renderedAmounts: RenderedAmount[] = [0, 1, 2, 3, 4].map(
    (stepIndex): RenderedAmount => ({
      step_index: stepIndex,
      value: 60,
      unit: "ml",
      is_cumulative_water: true,
    }),
  );

  const result = verifyAmountProvenance({
    requestText,
    renderedAmounts,
    provenance,
  });

  // Physical justification for this expectation: each pour adds water, so a
  // cumulative target that does not rise means the pour added nothing. Steps
  // 2-5 each fail to exceed the running total of 60 ml.
  assertEquals(
    result.findings.map((finding) => finding.code),
    [
      "non_monotonic_cumulative",
      "non_monotonic_cumulative",
      "non_monotonic_cumulative",
      "non_monotonic_cumulative",
    ],
    "a stalled cumulative run must be reported, not passed silently",
  );
});

// ---------------------------------------------------------------------
// verifyTimingProvenance (G22 — timing landmark enforcement).
// ---------------------------------------------------------------------

function timingFindingCodes(
  result: ReturnType<typeof verifyTimingProvenance>,
): string[] {
  return result.findings.map((finding) => finding.code);
}

// ---- 1. Total brew time -----------------------------------------------

Deno.test("total brew time: French V60 'complete at 3:00' emitted as 3:10 is a mismatch (live incident shape)", () => {
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 100 },
    { step_index: 2, kind: "brew", duration_seconds: 90 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: 180,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(
    timingFindingCodes(result),
    ["total_brew_time_mismatch"],
    "190s emitted against a 180s stated total is a 10s drift; two brew steps " +
      "can only lose 1s to integer rounding, so tolerance is the 2s floor",
  );
  assertEquals(result.findings[0].step_index, -1, "total brew time is recipe-level, like a -1 amount record");
});

Deno.test("total brew time: integer-second rounding across five steps is within tolerance and passes", () => {
  // Physical justification: a stated 180s total split across five steps by
  // water share gives fractional durations, each rounded to a whole second.
  // Five roundings can move the sum by at most 2.5s, so a 3s overshoot is
  // exactly the divergence rounding is allowed to produce and nothing more.
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "brew", duration_seconds: 45 },
    { step_index: 1, kind: "brew", duration_seconds: 35 },
    { step_index: 2, kind: "brew", duration_seconds: 35 },
    { step_index: 3, kind: "brew", duration_seconds: 34 },
    { step_index: 4, kind: "brew", duration_seconds: 34 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: 180,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(
    result.findings,
    [],
    "183s across five steps is a 3s drift against a ceil(5/2) = 3s tolerance",
  );
});

Deno.test("total brew time: a 15s drift on a 180s target fails (the old percentage tolerance let this through)", () => {
  // Regression lock for the tolerance tightening. Under the previous
  // max(15s, 10% of target) rule this passed, which is what let the live
  // French V60 3:00 -> 3:10 incident report itself as clean. Fifteen seconds
  // is not integer-rounding noise on any step count this parser produces.
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "brew", duration_seconds: 195 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: 180,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(timingFindingCodes(result), ["total_brew_time_mismatch"], "");
});

Deno.test("total brew time: a 60s drift on a 180s target fails", () => {
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "brew", duration_seconds: 240 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: 180,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(
    timingFindingCodes(result),
    ["total_brew_time_mismatch"],
    "a 60s drift is nowhere near integer-rounding noise",
  );
});

Deno.test("total brew time: Spanish V60 'total 3:30-4:00' (210s midpoint) emitted as 2:55 (175s) is a mismatch", () => {
  // 3:30-4:00 midpoints to 210s (3:45) per the extraction stage's
  // midpoint-of-range rule; the emitted 175s is a 35s shortfall, which no
  // amount of integer rounding on one step can account for.
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "brew", duration_seconds: 175 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: 210,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(timingFindingCodes(result), ["total_brew_time_mismatch"], "");
});

Deno.test("total brew time: only kind 'brew' steps are summed, not preparation", () => {
  const renderedSteps: RenderedTimingStep[] = [
    // If the (untimed) preparation step's duration were mistakenly summed
    // in, this would still land close to 180s and mask a real mismatch.
    { step_index: 0, kind: "preparation", duration_seconds: 500 },
    { step_index: 1, kind: "brew", duration_seconds: 180 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: 180,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(
    result.findings,
    [],
    "the preparation step's duration must never count toward the brew total",
  );
});

Deno.test("total brew time: no stated total produces no finding, however the brew steps sum", () => {
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "brew", duration_seconds: 9999 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(
    result.findings,
    [],
    "with no source-traceable total there is nothing to compare against — silence, not a warning",
  );
});

// ---- 2. Stated per-step durations ---------------------------------------

Deno.test("stated duration: a 45s bloom rewritten to a different duration is a finding (catches the bloom-rewrite failure)", () => {
  const landmarks: TimingLandmark[] = [
    { step_index: 1, kind: "duration", seconds: 45 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 60 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  assertEquals(
    timingFindingCodes(result),
    ["stated_duration_changed"],
    "the source stated 45s for this step; the final draft emits 60s",
  );
  assertEquals(result.findings[0].step_index, 1, "");
});

Deno.test("stated duration: a 45s bloom that survives unchanged produces no finding", () => {
  const landmarks: TimingLandmark[] = [
    { step_index: 1, kind: "duration", seconds: 45 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 45 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  assertEquals(result.findings, [], "");
});

Deno.test("stated duration: a landmark whose step was folded away finds nothing to compare and is silent", () => {
  // e.g. a pre-timer preparation step with a stated fill time, folded into
  // step 0 by foldPreTimerStepsIntoPreparation before this check ever runs.
  const landmarks: TimingLandmark[] = [
    { step_index: 3, kind: "duration", seconds: 20 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 45 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  assertEquals(
    result.findings,
    [],
    "nothing in the final draft corresponds to step_index 3 — silence, not a finding",
  );
});

// ---- 3. Elapsed landmarks ------------------------------------------------

Deno.test("elapsed landmark: video captions 'bloom at 0:00, pour at 0:45, drawdown at 1:45' with the bloom double-counted is a mismatch", () => {
  // elapsed_seconds is a BEGINS-AT timestamp measured from timer start (see
  // parser.ts's extraction rule: "'At 1:30, pour to 180g' has elapsed_seconds
  // 90 for that step"), so a step's landmark must equal the sum of every
  // preceding brew step's duration.
  //
  // Source: the bloom begins at 0:00, the pour begins at 0:45, the drawdown
  // begins at 1:45. Differencing gives a 45s bloom and a 60s pour.
  const landmarks: TimingLandmark[] = [
    { step_index: 1, kind: "elapsed", seconds: 0 },
    { step_index: 2, kind: "elapsed", seconds: 45 },
    { step_index: 3, kind: "elapsed", seconds: 105 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    // Bloom: correct, 45s (0:45 - 0:00).
    { step_index: 1, kind: "brew", duration_seconds: 45 },
    // Pour: the failure. Its own begins-at timestamp of 1:45 was taken as a
    // duration instead of being differenced against 0:45, so the bloom's 45s
    // is counted a second time inside it — 105s where 60s is correct.
    { step_index: 2, kind: "brew", duration_seconds: 105 },
    { step_index: 3, kind: "brew", duration_seconds: 40 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  // Steps 1 and 2 still reconcile (0 = 0, and 45 = 45); only the drawdown
  // exposes the double count, its preceding steps summing to 45 + 105 = 150
  // against a stated 105.
  assertEquals(
    timingFindingCodes(result),
    ["elapsed_landmark_mismatch"],
    "the drawdown begins at 1:45 per the source, but the preceding brew steps sum to 2:30",
  );
  assertEquals(result.findings[0].step_index, 3, "");
});

Deno.test("elapsed landmark: integer-second rounding in the preceding steps is within tolerance and passes", () => {
  // Same physical justification as the total-brew-time rounding case: three
  // preceding steps can move their sum by at most 1.5s, and ceil(3/2) = 2
  // covers that.
  const landmarks: TimingLandmark[] = [
    { step_index: 4, kind: "elapsed", seconds: 180 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 61 },
    { step_index: 2, kind: "brew", duration_seconds: 61 },
    { step_index: 3, kind: "brew", duration_seconds: 60 },
    { step_index: 4, kind: "brew", duration_seconds: 30 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  assertEquals(
    result.findings,
    [],
    "182s of preceding steps against a 180s landmark is a 2s rounding drift",
  );
});

Deno.test("elapsed landmark: a 15s drift on a 180s landmark fails (the old percentage tolerance let this through)", () => {
  const landmarks: TimingLandmark[] = [
    { step_index: 2, kind: "elapsed", seconds: 180 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 195 },
    { step_index: 2, kind: "brew", duration_seconds: 30 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  assertEquals(timingFindingCodes(result), ["elapsed_landmark_mismatch"], "");
});

Deno.test("elapsed landmark: a 60s drift on a 180s landmark fails", () => {
  const landmarks: TimingLandmark[] = [
    { step_index: 2, kind: "elapsed", seconds: 180 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 240 },
    { step_index: 2, kind: "brew", duration_seconds: 30 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  assertEquals(
    timingFindingCodes(result),
    ["elapsed_landmark_mismatch"],
    "a 60s drift exceeds the 18s tolerance on a 180s landmark",
  );
});

Deno.test("elapsed landmark: only preceding BREW steps count toward the running sum, never preparation", () => {
  const landmarks: TimingLandmark[] = [
    { step_index: 1, kind: "elapsed", seconds: 0 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    // A large preparation duration must never leak into the elapsed sum —
    // preparation always renders at 0s in the app anyway, but the pipeline
    // stage feeding this check must not rely on that.
    { step_index: 0, kind: "preparation", duration_seconds: 999 },
    { step_index: 1, kind: "brew", duration_seconds: 10 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks,
  });

  assertEquals(
    result.findings,
    [],
    "step 1 is the very first brew step, so nothing should precede it regardless of the preparation step's duration",
  );
});

// ---- Combined / silence ---------------------------------------------------

Deno.test("a recipe with no stated total and no per-step landmarks produces no findings at all", () => {
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    { step_index: 1, kind: "brew", duration_seconds: 30 },
    { step_index: 2, kind: "brew", duration_seconds: 90 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: null,
    renderedSteps,
    landmarks: [],
  });

  assertEquals(
    result.findings,
    [],
    "nothing source-traceable was supplied, so this must be silence, not a warning",
  );
});

Deno.test("all three checks can fire together on the same draft", () => {
  const landmarks: TimingLandmark[] = [
    { step_index: 1, kind: "duration", seconds: 45 },
    { step_index: 2, kind: "elapsed", seconds: 105 },
  ];
  const renderedSteps: RenderedTimingStep[] = [
    { step_index: 0, kind: "preparation", duration_seconds: 0 },
    // Stated 45s bloom rewritten to 60s.
    { step_index: 1, kind: "brew", duration_seconds: 60 },
    // Preceding sum is now 60s against a stated elapsed landmark of 105s.
    { step_index: 2, kind: "brew", duration_seconds: 400 },
  ];

  const result = verifyTimingProvenance({
    statedTotalBrewTimeSeconds: 200,
    renderedSteps,
    landmarks,
  });

  assertEquals(
    [...new Set(timingFindingCodes(result))].sort(),
    [
      "elapsed_landmark_mismatch",
      "stated_duration_changed",
      "total_brew_time_mismatch",
    ],
    "the three checks are independent and can all fire on the same draft",
  );
});
