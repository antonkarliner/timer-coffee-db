// Plan 043 Phase 4: the coffee-vs-water rule. Stage A added it as candidate
// policies; since stage C the C3 shape at COFFEE_DOSE_BOUND_FACTOR is the
// default (no policy). Synthetic strings only. Coffee 15, water 250 unless
// stated, so the factor thresholds are 15 (x1.0), 15.75 (x1.05), 18.75
// (x1.25), 22.5 (x1.5) and 30 (x2.0).

import {
  type AmountConversionExplanation,
  COFFEE_DOSE_BOUND_FACTOR,
  explainNumericValueConversion,
  PLACEHOLDER_POLICY_IDS,
  type PlaceholderPolicyId,
} from "./parser.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

type ExplainArgs = Parameters<typeof explainNumericValueConversion>[0];

function explain(
  description: string,
  overrides: Partial<ExplainArgs> = {},
): AmountConversionExplanation[] {
  return explainNumericValueConversion({
    description,
    stepKind: "brew",
    coffeeAmount: 15,
    waterAmount: 250,
    scalableAmounts: [],
    rateAmounts: [],
    ...overrides,
  });
}

// [placeholder, reason] of the single amount in description.
function decide(
  description: string,
  policy: PlaceholderPolicyId | undefined,
  overrides: Partial<ExplainArgs> = {},
): [string | null, string] {
  const entries = explain(description, {
    ...overrides,
    ...(policy === undefined ? {} : { placeholderPolicy: policy }),
  });
  equal(entries.length, 1);
  return [entries[0].placeholder, entries[0].reason];
}

const COFFEE = "<final_coffee_amount>";
const WATER = "<final_water_amount>";

Deno.test("policy: candidate ids", () => {
  // plan 043 Ph 4: C0_current renamed C0_legacy; C3 at 1.25/1.5/2.0 added.
  equal([...PLACEHOLDER_POLICY_IDS], [
    "C0_legacy",
    "C1_coffee_bound@1.0",
    "C1_coffee_bound@1.05",
    "C1_coffee_bound@1.25",
    "C2_prep_dose@1.05",
    "C3_both@1.05",
    "C3_both@1.25",
    "C3_both@1.5",
    "C3_both@2.0",
  ]);
});

// The C3 candidate whose factor is COFFEE_DOSE_BOUND_FACTOR.
function defaultEquivalentPolicy(): PlaceholderPolicyId {
  const policy = PLACEHOLDER_POLICY_IDS.find((id) =>
    id.startsWith("C3_both@") &&
    Number(id.slice("C3_both@".length)) === COFFEE_DOSE_BOUND_FACTOR
  );
  if (policy === undefined) {
    throw new Error("no C3_both candidate at COFFEE_DOSE_BOUND_FACTOR");
  }
  return policy;
}

// plan 043 Ph 4: no policy used to equal C0; since stage C it equals C3 at
// COFFEE_DOSE_BOUND_FACTOR (the C0 side is pinned by the tests below).
Deno.test("policy: no policy equals C3_both at COFFEE_DOSE_BOUND_FACTOR", () => {
  const cases: Array<[string, Partial<ExplainArgs>]> = [
    ["Add 50 g onto the coffee bed", {}],
    ["Grind 16 g of beans", { stepKind: "preparation" }],
    ["Weigh 30 g", { stepKind: "preparation" }],
    ["Add 30 g now", { stepRole: "stir" }],
    ["Pour 40-60 g over the bed", {}],
    ["Add 15 g and stir", {}],
    ["Weigh 30 g", { stepKind: "preparation", waterAmount: null }],
  ];
  for (const [description, overrides] of cases) {
    equal(
      explain(description, {
        ...overrides,
        placeholderPolicy: defaultEquivalentPolicy(),
      }),
      explain(description, overrides),
    );
  }
});

Deno.test("policy C1: a keyword_coffee amount above the dose becomes water", () => {
  // Only a coffee word nearby, and 50 g is over three doses.
  const description = "Add 50 g onto the coffee bed";
  equal(decide(description, "C0_legacy"), [COFFEE, "keyword_coffee"]);
  // The stage-A ids apply the bound in every step, brew included.
  for (
    const policy of [
      "C1_coffee_bound@1.0",
      "C1_coffee_bound@1.05",
      "C1_coffee_bound@1.25",
      "C3_both@1.05",
    ] as const
  ) {
    equal(decide(description, policy), [WATER, "coffee_bound_water"]);
  }
  // plan 043 Ph 4: rule (a) is preparation-only for the default and the
  // stage-C C3 ids, so this brew-step amount stays coffee there.
  for (
    const policy of [
      undefined,
      "C3_both@1.25",
      "C3_both@1.5",
      "C3_both@2.0",
    ] as const
  ) {
    equal(decide(description, policy), [COFFEE, "keyword_coffee"]);
    equal(decide(description, policy, { stepKind: "preparation" }), [
      WATER,
      "coffee_bound_water",
    ]);
  }
  // C2 only replaces the cleanest-ratio branches.
  equal(decide(description, "C2_prep_dose@1.05"), [COFFEE, "keyword_coffee"]);
});

Deno.test("policy C1: factor boundaries", () => {
  // 15.5: over x1.0, within x1.05.
  const justOver = "Grind 15.5 g of beans";
  equal(decide(justOver, "C1_coffee_bound@1.0"), [WATER, "coffee_bound_water"]);
  equal(decide(justOver, "C1_coffee_bound@1.05"), [COFFEE, "keyword_coffee"]);
  // 15.75 is exactly x1.05: not strictly greater, so it stays coffee.
  equal(decide("Grind 15.75 g of beans", "C1_coffee_bound@1.05"), [
    COFFEE,
    "keyword_coffee",
  ]);
  // 16: over x1.05, within x1.25.
  const sixteen = "Grind 16 g of beans";
  equal(decide(sixteen, "C1_coffee_bound@1.05"), [WATER, "coffee_bound_water"]);
  equal(decide(sixteen, "C1_coffee_bound@1.25"), [COFFEE, "keyword_coffee"]);
  // 19: over x1.25.
  equal(decide("Grind 19 g of beans", "C1_coffee_bound@1.25"), [
    WATER,
    "coffee_bound_water",
  ]);
});

Deno.test("policy C1: overturns both cleanest-ratio branches", () => {
  // 30/15 = 2 is the cleaner ratio, so under C0_legacy these are coffee.
  // plan 043 Ph 4: was no policy, which now applies the dose rule; the
  // default's own outcome is pinned in the "default:" tests below.
  equal(decide("Add 30 g now", "C0_legacy", { stepRole: "stir" }), [
    COFFEE,
    "cleanest_ratio_step_role",
  ]);
  equal(
    decide("Add 30 g now", "C1_coffee_bound@1.25", { stepRole: "stir" }),
    [WATER, "coffee_bound_water"],
  );
  // plan 043 Ph 4: was no policy, as above.
  equal(decide("Weigh 30 g", "C0_legacy", { stepKind: "preparation" }), [
    COFFEE,
    "cleanest_ratio",
  ]);
  equal(
    decide("Weigh 30 g", "C1_coffee_bound@1.25", { stepKind: "preparation" }),
    [WATER, "coffee_bound_water"],
  );
});

Deno.test("policy C1: needs a water base to fall back to", () => {
  const overrides = { waterAmount: null };
  equal(
    decide("Add 50 g onto the coffee bed", "C1_coffee_bound@1.0", overrides),
    [COFFEE, "keyword_coffee"],
  );
  equal(
    decide("Weigh 30 g", "C1_coffee_bound@1.0", {
      ...overrides,
      stepKind: "preparation",
    }),
    [COFFEE, "cleanest_ratio"],
  );
});

Deno.test("policy C2: preparation dose rule, both sides of x1.05", () => {
  const prep = { stepKind: "preparation" as const };
  // 15.5 <= 15.75: coffee. Under C0_legacy the cleanest ratio picks water
  // here (15.5/250 = 0.062 reads "cleaner" than 15.5/15).
  // plan 043 Ph 4: was no policy, which now applies the dose rule (coffee).
  equal(decide("Weigh out 15.5 g", "C0_legacy", prep), [
    WATER,
    "cleanest_ratio",
  ]);
  equal(decide("Weigh out 15.5 g", "C2_prep_dose@1.05", prep), [
    COFFEE,
    "prep_dose_coffee",
  ]);
  // 15.75 is exactly the bound: coffee.
  equal(decide("Weigh out 15.75 g", "C2_prep_dose@1.05", prep), [
    COFFEE,
    "prep_dose_coffee",
  ]);
  // 16 > 15.75: water.
  equal(decide("Weigh out 16 g", "C2_prep_dose@1.05", prep), [
    WATER,
    "prep_dose_water",
  ]);
  // Today 30 g is coffee by the cleanest ratio (30/15 = 2); C2 says water.
  equal(decide("Weigh 30 g", "C2_prep_dose@1.05", prep), [
    WATER,
    "prep_dose_water",
  ]);
  // A preheat amount far above the dose.
  equal(decide("Preheat with 200 ml", "C2_prep_dose@1.05", prep), [
    WATER,
    "prep_dose_water",
  ]);
});

Deno.test("policy C2: stepRole preparation/stir on a brew step", () => {
  for (const stepRole of ["preparation", "stir"] as const) {
    equal(decide("Add 30 g now", "C2_prep_dose@1.05", { stepRole }), [
      WATER,
      "prep_dose_water",
    ]);
    equal(decide("Add 14 g now", "C2_prep_dose@1.05", { stepRole }), [
      COFFEE,
      "prep_dose_coffee",
    ]);
  }
  // Other roles keep the brew default.
  equal(decide("Add 14 g now", "C2_prep_dose@1.05", { stepRole: "pour" }), [
    WATER,
    "brew_default_water",
  ]);
});

Deno.test("policy C2: leaves keyword decisions and missing bases alone", () => {
  const prep = { stepKind: "preparation" as const };
  // "beans" decides by keyword before any ratio rule runs.
  equal(decide("Weigh 16 g of beans", "C2_prep_dose@1.05", prep), [
    COFFEE,
    "keyword_coffee",
  ]);
  equal(decide("Rinse with 100 g", "C2_prep_dose@1.05", prep), [
    WATER,
    "keyword_water",
  ]);
  // No water base: the cleanest-ratio fallback still decides.
  equal(
    decide("Weigh 30 g", "C2_prep_dose@1.05", { ...prep, waterAmount: null }),
    [COFFEE, "cleanest_ratio"],
  );
});

Deno.test("policy C3: dose rule in preparation, coffee bound elsewhere", () => {
  const prep = { stepKind: "preparation" as const };
  // Keyword coffee in preparation: C2 does not apply, C1 does.
  equal(decide("Weigh 16 g of beans", "C3_both@1.05", prep), [
    WATER,
    "coffee_bound_water",
  ]);
  equal(decide("Weigh out 15.5 g", "C3_both@1.05", prep), [
    COFFEE,
    "prep_dose_coffee",
  ]);
  equal(decide("Weigh 30 g", "C3_both@1.05", prep), [
    WATER,
    "prep_dose_water",
  ]);
});

Deno.test("policy: exact totals are untouched by every candidate", () => {
  for (const policy of [...PLACEHOLDER_POLICY_IDS, undefined]) {
    for (const stepKind of ["brew", "preparation"] as const) {
      equal(decide("Add 15 g and stir", policy, { stepKind }), [
        COFFEE,
        "exact_total_coffee",
      ]);
      // A coffee word nearby does not matter either.
      equal(decide("Grind 15 g of beans", policy, { stepKind }), [
        COFFEE,
        "exact_total_coffee",
      ]);
      equal(decide("Top up to 250 g", policy, { stepKind }), [
        WATER,
        "exact_total_water",
      ]);
    }
  }
});

Deno.test("policy: ranges apply the policy to both endpoints", () => {
  // Both endpoints over the bound: the whole range becomes water.
  const both = explain("Add 40-60 g onto the coffee bed", {
    placeholderPolicy: "C1_coffee_bound@1.05",
  });
  equal(both.map((entry) => [entry.isRange, entry.placeholder, entry.reason]), [
    [true, WATER, "coffee_bound_water"],
  ]);
  // Straddling the bound: the endpoints disagree, so the range is rejected
  // and the single-amount pass re-scans its upper endpoint, which is then
  // decided on its own.
  const straddle = explain("Grind 14-17 g of beans", {
    placeholderPolicy: "C1_coffee_bound@1.05",
  });
  equal(
    straddle.map((entry) => [entry.isRange, entry.placeholder, entry.reason]),
    [
      [true, null, "range_placeholder_mismatch"],
      [false, WATER, "coffee_bound_water"],
    ],
  );
  equal(
    explain("Grind 14-17 g of beans").map((entry) => [
      entry.isRange,
      entry.placeholder,
      entry.reason,
    ]),
    [[true, COFFEE, "keyword_coffee"]],
  );
});

// Plan 043 Phase 4, stage C: the default rule (no policy). Values sit well
// inside x1.25 or well beyond x2.0, so these hold for any factor stage B
// left open; the factor itself is pinned on its own.

Deno.test("default: COFFEE_DOSE_BOUND_FACTOR is 1.5", () => {
  equal(COFFEE_DOSE_BOUND_FACTOR, 1.5);
});

Deno.test("default: a coffee-worded amount at ~3x the dose is water in preparation", () => {
  // 45 g next to a coffee word, against a 15 g dose.
  const preparation: Array<Partial<ExplainArgs>> = [
    { stepKind: "preparation" },
    { stepRole: "preparation" },
    { stepRole: "stir" },
  ];
  for (const overrides of preparation) {
    equal(decide("Grind 45 g of beans", undefined, overrides), [
      WATER,
      "coffee_bound_water",
    ]);
    equal(decide("Grind 45 g of beans", "C0_legacy", overrides), [
      COFFEE,
      "keyword_coffee",
    ]);
  }
  // plan 043 Ph 4: rule (a) is preparation-only; this used to assert water
  // for a brew step too.
  for (const stepRole of [undefined, "bloom", "pour"] as const) {
    equal(
      decide("Grind 45 g of beans", undefined, stepRole ? { stepRole } : {}),
      [COFFEE, "keyword_coffee"],
    );
  }
  // Without a water base there is nothing to fall back to.
  equal(
    decide("Grind 45 g of beans", undefined, {
      stepKind: "preparation",
      waterAmount: null,
    }),
    [COFFEE, "keyword_coffee"],
  );
});

Deno.test("default: a brew pour phrased as a multiple of the dose stays coffee", () => {
  // 120 g is eight 15 g doses, and the text ties it to the dose, so it
  // scales with coffee (the Kalita fixture's shape).
  for (const stepRole of [undefined, "pour", "bloom"] as const) {
    equal(
      decide(
        "Keep going to eight times the dose, 120 g",
        undefined,
        stepRole ? { stepRole } : {},
      ),
      [COFFEE, "keyword_coffee"],
    );
  }
});

Deno.test("default: a preparation amount at 1.2x the dose is coffee", () => {
  // 18 g against a 15 g dose, with no coffee or water word.
  equal(decide("Weigh out 18 g", undefined, { stepKind: "preparation" }), [
    COFFEE,
    "prep_dose_coffee",
  ]);
  for (const stepRole of ["preparation", "stir"] as const) {
    equal(decide("Set aside 18 g", undefined, { stepRole }), [
      COFFEE,
      "prep_dose_coffee",
    ]);
  }
  // A coffee word within the bound keeps its keyword decision.
  equal(
    decide("Grind 18 g of beans", undefined, { stepKind: "preparation" }),
    [COFFEE, "keyword_coffee"],
  );
});

Deno.test("default: a preparation amount at 2.5x the dose is water", () => {
  // 37.5/15 = 2.5 is the "cleaner" ratio, so C0_legacy read it as coffee.
  const prep = { stepKind: "preparation" as const };
  equal(decide("Weigh out 37.5 g", undefined, prep), [
    WATER,
    "prep_dose_water",
  ]);
  equal(decide("Weigh out 37.5 g", "C0_legacy", prep), [
    COFFEE,
    "cleanest_ratio",
  ]);
  for (const stepRole of ["preparation", "stir"] as const) {
    equal(decide("Set aside 37.5 g", undefined, { stepRole }), [
      WATER,
      "prep_dose_water",
    ]);
  }
});

Deno.test("default: exact totals are unchanged", () => {
  for (const stepKind of ["brew", "preparation"] as const) {
    for (
      const stepRole of [undefined, "preparation", "stir", "pour"] as const
    ) {
      const overrides = { stepKind, ...(stepRole ? { stepRole } : {}) };
      equal(decide("Add 15 g and stir", undefined, overrides), [
        COFFEE,
        "exact_total_coffee",
      ]);
      equal(decide("Grind 15 g of beans", undefined, overrides), [
        COFFEE,
        "exact_total_coffee",
      ]);
      equal(decide("Top up to 250 g", undefined, overrides), [
        WATER,
        "exact_total_water",
      ]);
    }
  }
});

Deno.test("default: brew-step defaults are unchanged", () => {
  for (const stepRole of [undefined, "bloom", "pour", "drawdown"] as const) {
    const overrides = stepRole ? { stepRole } : {};
    // Amounts below and above the bound both keep the brew water default.
    for (const description of ["Add 12 g now", "Add 60 g now"]) {
      equal(decide(description, undefined, overrides), [
        WATER,
        "brew_default_water",
      ]);
      equal(
        decide(description, undefined, overrides),
        decide(description, "C0_legacy", overrides),
      );
    }
    equal(decide("Pour 100 g of water", undefined, overrides), [
      WATER,
      "keyword_water",
    ]);
    // A coffee word within the bound is still coffee.
    equal(decide("Grind 16 g of beans", undefined, overrides), [
      COFFEE,
      "keyword_coffee",
    ]);
  }
});

Deno.test("default: a range with both endpoints beyond the bound is water in preparation", () => {
  const ranges = (overrides: Partial<ExplainArgs>) =>
    explain("Add 40-60 g onto the coffee bed", overrides).map((entry) => [
      entry.isRange,
      entry.placeholder,
      entry.reason,
    ]);
  equal(ranges({ stepKind: "preparation" }), [
    [true, WATER, "coffee_bound_water"],
  ]);
  // plan 043 Ph 4: rule (a) is preparation-only; this used to assert water
  // for a brew step.
  equal(ranges({}), [[true, COFFEE, "keyword_coffee"]]);
});
