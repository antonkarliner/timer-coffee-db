// Plan 043 Phase 4, stage A: the what-if replay over candidate placeholder
// policies. Synthetic rows only. Never copy or paraphrase corpus text into
// this file.

import {
  type CorpusLabel,
  type CorpusRow,
  formatCorpusAccuracy,
  formatCorpusWhatIf,
  scoreCorpusLabels,
  valueToCoffeeBucket,
  valueToWaterBucket,
} from "./corpus_scoring.ts";
import { PLACEHOLDER_POLICY_IDS } from "./parser.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// Coffee 15, water 250: C1 thresholds 15 / 15.75 / 18.75, C2 at 15.75.
const ROWS: CorpusRow[] = [
  {
    id: 1,
    coffee: 15,
    water: 250,
    locale: "en",
    src: [
      // preparation, cleanest ratio says coffee (30/15 = 2)
      "Weigh 30 g",
      // brew, keyword says coffee
      "Add 50 g onto the coffee bed",
      // brew, keyword says coffee, just over x1.05
      "Grind 16 g of beans",
    ],
  },
  {
    id: 2,
    coffee: 15,
    water: 250,
    locale: "ja",
    // preparation, cleanest ratio says water (15.5/250 reads cleaner)
    src: ["Weigh out 15.5 g"],
  },
];

function label(
  diagnosticsId: number,
  stepIndex: number,
  needle: string,
  name: CorpusLabel["label"],
): CorpusLabel {
  const text = ROWS.find((row) => row.id === diagnosticsId)!.src[stepIndex];
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`needle not found: ${needle}`);
  return {
    diagnostics_id: diagnosticsId,
    step_index: stepIndex,
    char_start: start,
    char_end: start + needle.length,
    label: name,
  };
}

const LABELS: CorpusLabel[] = [
  label(1, 0, "30 g", "water"), // C0 wrong
  label(1, 1, "50 g", "water"), // C0 wrong
  label(1, 2, "16 g", "coffee"), // C0 right
  label(2, 0, "15.5 g", "coffee"), // C0 wrong
  // orphan: unknown row
  {
    diagnostics_id: 99,
    step_index: 0,
    char_start: 0,
    char_end: 1,
    label: "water",
  },
];

type Metric = { scope: string; name: string; key?: string; value: number };

function parse(lines: string[]): Metric[] {
  return lines.map((line) => {
    if (!line.startsWith("METRIC ")) throw new Error("not a METRIC line");
    return JSON.parse(line.slice("METRIC ".length));
  });
}

const METRICS = parse(formatCorpusWhatIf(ROWS, LABELS));

function find(scope: string, name: string, key?: string): number | undefined {
  return METRICS.find((metric) =>
    metric.scope === scope && metric.name === name && metric.key === key
  )?.value;
}

function flips(policy: string, scope: string): [number?, number?] {
  return [
    find(`${policy}/${scope}`, "flip", "right_to_wrong"),
    find(`${policy}/${scope}`, "flip", "wrong_to_right"),
  ];
}

Deno.test("what-if: every scope is prefixed by a candidate id", () => {
  for (const metric of METRICS) {
    const prefix = metric.scope.split("/")[0];
    if (!(PLACEHOLDER_POLICY_IDS as readonly string[]).includes(prefix)) {
      throw new Error(`unprefixed scope: ${metric.scope}`);
    }
  }
  for (const policy of PLACEHOLDER_POLICY_IDS) {
    equal(find(`${policy}/overall`, "labelled"), 4);
    equal(find(`${policy}/overall`, "orphan"), 1);
  }
});

Deno.test("what-if: overall correct per candidate", () => {
  equal(
    PLACEHOLDER_POLICY_IDS.map((policy) =>
      find(`${policy}/overall`, "correct")
    ),
    [1, 2, 2, 3, 3, 3],
  );
  equal(find("C1_coffee_bound@1.05/reason:coffee_bound_water", "labelled"), 3);
  equal(find("C1_coffee_bound@1.05/reason:coffee_bound_water", "correct"), 2);
  equal(find("C2_prep_dose@1.05/reason:prep_dose_water", "correct"), 1);
  equal(find("C2_prep_dose@1.05/reason:prep_dose_coffee", "correct"), 1);
  equal(find("C2_prep_dose@1.05/kind:preparation", "correct"), 2);
  equal(find("C2_prep_dose@1.05/lang:ja", "accuracy"), 1);
  equal(
    find("C3_both@1.05/overall", "confusion", "coffee:water"),
    1,
  );
});

Deno.test("what-if: flips against C0, overall and per step kind", () => {
  // [right_to_wrong, wrong_to_right]
  for (const policy of ["C1_coffee_bound@1.0", "C1_coffee_bound@1.05"]) {
    equal(flips(policy, "overall"), [1, 2]);
    equal(flips(policy, "kind:preparation"), [0, 1]);
    equal(flips(policy, "kind:brew"), [1, 1]);
  }
  equal(flips("C1_coffee_bound@1.25", "overall"), [0, 2]);
  equal(flips("C1_coffee_bound@1.25", "kind:brew"), [0, 1]);
  equal(flips("C2_prep_dose@1.05", "overall"), [0, 2]);
  equal(flips("C2_prep_dose@1.05", "kind:preparation"), [0, 2]);
  equal(flips("C2_prep_dose@1.05", "kind:brew"), [0, 0]);
  equal(flips("C3_both@1.05", "overall"), [1, 3]);
  equal(flips("C3_both@1.05", "kind:preparation"), [0, 2]);
  equal(flips("C3_both@1.05", "kind:brew"), [1, 1]);
  // No flips are reported for C0 against itself.
  equal(
    METRICS.filter((metric) =>
      metric.name === "flip" && metric.scope.startsWith("C0_current/")
    ),
    [],
  );
});

Deno.test("what-if: C0 feature breakdown by reason, label, outcome, buckets", () => {
  const features = METRICS.filter((metric) => metric.name === "feature");
  equal(
    features.map((metric) => [metric.scope, metric.key, metric.value]),
    [
      [
        "C0_current/overall",
        "cleanest_ratio|coffee|water|vc:le_1.05|vw:lt_0.1",
        1,
      ],
      [
        "C0_current/overall",
        "cleanest_ratio|water|coffee|vc:1.05_2|vw:0.1_0.5",
        1,
      ],
      [
        "C0_current/overall",
        "keyword_coffee|coffee|coffee|vc:1.05_2|vw:lt_0.1",
        1,
      ],
      [
        "C0_current/overall",
        "keyword_coffee|water|coffee|vc:gt_2|vw:0.1_0.5",
        1,
      ],
    ],
  );
});

Deno.test("what-if: C0 scores match the plain replay", () => {
  const plain = formatCorpusAccuracy(scoreCorpusLabels(ROWS, LABELS));
  const prefixed = METRICS.filter((metric) =>
    metric.scope.startsWith("C0_current/") && metric.name !== "feature"
  ).map((metric) => ({
    ...metric,
    scope: metric.scope.slice("C0_current/".length),
  }));
  equal(prefixed, parse(plain));
});

Deno.test("what-if: buckets", () => {
  equal(
    [1, 1.05, 1.06, 2, 2.01].map(valueToCoffeeBucket),
    ["le_1.05", "le_1.05", "1.05_2", "1.05_2", "gt_2"],
  );
  equal(
    [0.05, 0.1, 0.49, 0.5, 1, 1.01].map(valueToWaterBucket),
    ["lt_0.1", "0.1_0.5", "0.1_0.5", "0.5_1", "0.5_1", "gt_1"],
  );
});

Deno.test("what-if: lines carry no step text", () => {
  const lines = formatCorpusWhatIf(ROWS, LABELS);
  const fragments = [
    ...ROWS.flatMap((row) => row.src),
    "Weigh",
    "onto",
    "bed",
    "Grind",
    "beans",
  ];
  for (const line of lines) {
    for (const fragment of fragments) {
      if (line.includes(fragment)) throw new Error("metric line quotes text");
    }
  }
});
