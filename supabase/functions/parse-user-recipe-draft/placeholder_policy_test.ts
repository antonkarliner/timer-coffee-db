// Plan 043 Phase 4, stage A: the off-by-default candidate coffee-vs-water
// policies. Synthetic strings only. Coffee 15, water 250 unless stated, so
// the factor thresholds are 15 (x1.0), 15.75 (x1.05) and 18.75 (x1.25).

import {
  type AmountConversionExplanation,
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
  equal([...PLACEHOLDER_POLICY_IDS], [
    "C0_current",
    "C1_coffee_bound@1.0",
    "C1_coffee_bound@1.05",
    "C1_coffee_bound@1.25",
    "C2_prep_dose@1.05",
    "C3_both@1.05",
  ]);
});

Deno.test("policy: C0 and no policy produce identical explanations", () => {
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
      explain(description, { ...overrides, placeholderPolicy: "C0_current" }),
      explain(description, overrides),
    );
  }
});

Deno.test("policy C1: a keyword_coffee amount above the dose becomes water", () => {
  // Only a coffee word nearby, and 50 g is over three doses.
  const description = "Add 50 g onto the coffee bed";
  equal(decide(description, undefined), [COFFEE, "keyword_coffee"]);
  equal(decide(description, "C0_current"), [COFFEE, "keyword_coffee"]);
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
  // 30/15 = 2 is the cleaner ratio, so today these are coffee.
  equal(decide("Add 30 g now", undefined, { stepRole: "stir" }), [
    COFFEE,
    "cleanest_ratio_step_role",
  ]);
  equal(
    decide("Add 30 g now", "C1_coffee_bound@1.25", { stepRole: "stir" }),
    [WATER, "coffee_bound_water"],
  );
  equal(decide("Weigh 30 g", undefined, { stepKind: "preparation" }), [
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
  // 15.5 <= 15.75: coffee. Today the cleanest ratio picks water here
  // (15.5/250 = 0.062 reads "cleaner" than 15.5/15).
  equal(decide("Weigh out 15.5 g", undefined, prep), [WATER, "cleanest_ratio"]);
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
  for (const policy of PLACEHOLDER_POLICY_IDS) {
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
