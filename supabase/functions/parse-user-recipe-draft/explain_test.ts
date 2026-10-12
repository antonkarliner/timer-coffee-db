import {
  type AmountConversionExplanation,
  explainNumericValueConversion,
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

function only(
  description: string,
  overrides: Partial<ExplainArgs> = {},
): AmountConversionExplanation {
  const entries = explain(description, overrides);
  equal(entries.length, 1);
  return entries[0];
}

// Test strings avoid a unit right before a full stop: SCALABLE_UNITS lists
// "g." and "ml.", so the regex takes the stop into the unit and the span.
function span(description: string, needle: string) {
  const start = description.indexOf(needle);
  if (start < 0) throw new Error(`needle not found: ${needle}`);
  return { start, end: start + needle.length };
}

Deno.test("explain: exact coffee total wins before keywords", () => {
  const description = "Add 15 g and stir.";
  equal(only(description), {
    ...span(description, "15 g"),
    value: 15,
    unit: "g",
    isRange: false,
    placeholder: "<final_coffee_amount>",
    reason: "exact_total_coffee",
  });
});

Deno.test("explain: exact water total", () => {
  const entry = only("Top up to 250 g.");
  equal([entry.placeholder, entry.reason], [
    "<final_water_amount>",
    "exact_total_water",
  ]);
});

Deno.test("explain: keyword branches and tie", () => {
  equal(only("Pour 100 g of water.").reason, "keyword_water");
  equal(only("Grind 20 g of beans.").reason, "keyword_coffee");
  const tie = only("coffee 50 g water");
  equal([tie.placeholder, tie.reason], [null, "keyword_tie"]);
});

Deno.test("explain: brew default, step-role and preparation ratio", () => {
  equal(only("Add 60 g.").reason, "brew_default_water");
  const stir = only("Add 30 g.", { stepRole: "stir" });
  equal([stir.placeholder, stir.reason], [
    "<final_coffee_amount>",
    "cleanest_ratio_step_role",
  ]);
  const prep = only("Weigh 30 g.", { stepKind: "preparation" });
  equal([prep.placeholder, prep.reason], [
    "<final_coffee_amount>",
    "cleanest_ratio",
  ]);
  const none = only("Weigh 30 g.", {
    stepKind: "preparation",
    coffeeAmount: null,
    waterAmount: null,
  });
  equal([none.placeholder, none.reason], [null, "no_base_amounts"]);
});

Deno.test("explain: skips report placeholder null", () => {
  const floor = only("Add 2 g.");
  equal([floor.placeholder, floor.reason], [null, "skipped_below_floor"]);
  equal(
    only("Add 5 ml now", { rateAmounts: [{ value: 5, unit: "ml" }] }).reason,
    "skipped_rate",
  );
  equal(only("Pour 10 ml per second.").reason, "skipped_rate_context");
  equal(only("Add 0.05 g.").reason, "skipped_tiny_value");
  const noBase = only("Grind 20 g of beans.", { coffeeAmount: null });
  equal([noBase.placeholder, noBase.reason], [null, "skipped_no_base_amount"]);
  equal(
    only("Pour (0.4 x 250 g) now.").reason,
    "skipped_inside_expression",
  );
});

Deno.test("explain: allowlist", () => {
  const entries = explain("Pour 100 g, then 40 g.", {
    scalableAmounts: [{ value: 100, unit: "g" }],
  });
  equal(entries.map((entry) => [entry.value, entry.reason]), [
    [100, "keyword_water"],
    [40, "not_in_allowlist"],
  ]);
});

Deno.test("explain: amounts after a converted range map to input offsets", () => {
  const description = "🫖 Pour 100-150 g, then 40 g now";
  const entries = explain(description);
  equal(entries, [
    {
      ...span(description, "100-150 g"),
      value: 150,
      unit: "g",
      isRange: true,
      placeholder: "<final_water_amount>",
      reason: "keyword_water",
    },
    {
      ...span(description, "40 g"),
      value: 40,
      unit: "g",
      isRange: false,
      placeholder: "<final_water_amount>",
      reason: "keyword_water",
    },
  ]);
});

Deno.test("explain: a rejected range is re-scanned by the single pass", () => {
  const description = "Add 1-200 g now";
  const entries = explain(description);
  equal(entries.map((entry) => [entry.start, entry.end, entry.reason]), [
    [
      span(description, "1-200 g").start,
      span(description, "1-200 g").end,
      "skipped_below_floor",
    ],
    [
      span(description, "200 g").start,
      span(description, "200 g").end,
      "brew_default_water",
    ],
  ]);
});

Deno.test("explain: empty description has no entries", () => {
  equal(explain("   "), []);
});
