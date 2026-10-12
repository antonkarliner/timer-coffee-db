// Plan 043 Phase 4: the what-if replay over candidate placeholder policies
// and the default rule. Synthetic rows only. Never copy or paraphrase corpus
// text into this file.

import {
  type CorpusLabel,
  type CorpusRow,
  formatCorpusAccuracy,
  formatCorpusWhatIf,
  scoreCorpusLabels,
  valueToCoffeeBucket,
  valueToWaterBucket,
  WHATIF_CANDIDATES,
} from "./corpus_scoring.ts";
import {
  COFFEE_DOSE_BOUND_FACTOR,
  explainNumericValueConversion,
} from "./parser.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// Coffee 15, water 250: C3 thresholds 18.75 (x1.25), 22.5 (x1.5), 30 (x2.0).
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
      // brew, keyword says coffee, within x1.25
      "Grind 16 g of beans",
      // brew, keyword says coffee, between x1.25 and x1.5
      "Grind 21 g of beans",
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
  label(1, 3, "21 g", "coffee"), // C0 right
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

// The candidate with the same factor as the default.
function defaultEquivalentCandidate(): string {
  const candidate = WHATIF_CANDIDATES.find((id) =>
    id.startsWith("C3_both@") &&
    Number(id.slice("C3_both@".length)) === COFFEE_DOSE_BOUND_FACTOR
  );
  if (candidate === undefined) {
    throw new Error("no C3_both candidate at COFFEE_DOSE_BOUND_FACTOR");
  }
  return candidate;
}

// Metrics under one prefix, with the prefix stripped.
function unprefixed(prefix: string, names: string[]): Metric[] {
  return METRICS.filter((metric) =>
    metric.scope.startsWith(`${prefix}/`) && names.includes(metric.name)
  ).map((metric) => ({
    ...metric,
    scope: metric.scope.slice(prefix.length + 1),
  }));
}

// plan 043 Ph 4: stage C replaced the stage-A candidate set (C0_current,
// C1 x3, C2, C3@1.05) with these.
Deno.test("what-if: candidate ids", () => {
  equal([...WHATIF_CANDIDATES], [
    "C0_legacy",
    "C3_both@1.25",
    "C3_both@1.5",
    "C3_both@2.0",
    "default",
  ]);
});

Deno.test("what-if: every scope is prefixed by a candidate id", () => {
  for (const metric of METRICS) {
    const prefix = metric.scope.split("/")[0];
    if (!(WHATIF_CANDIDATES as readonly string[]).includes(prefix)) {
      throw new Error(`unprefixed scope: ${metric.scope}`);
    }
  }
  for (const policy of WHATIF_CANDIDATES) {
    equal(find(`${policy}/overall`, "labelled"), 5);
    equal(find(`${policy}/overall`, "orphan"), 1);
  }
});

Deno.test("what-if: overall correct per candidate", () => {
  equal(
    WHATIF_CANDIDATES.map((policy) => find(`${policy}/overall`, "correct")),
    [2, 4, 5, 4, 5],
  );
  // x1.25 cuts the 21 g coffee amount; x1.5 keeps it.
  equal(find("C3_both@1.25/reason:coffee_bound_water", "labelled"), 2);
  equal(find("C3_both@1.25/reason:coffee_bound_water", "correct"), 1);
  equal(find("C3_both@1.25/overall", "confusion", "coffee:water"), 1);
  equal(find("C3_both@1.5/reason:coffee_bound_water", "labelled"), 1);
  equal(find("C3_both@1.5/reason:keyword_coffee", "correct"), 2);
  equal(find("C3_both@1.5/reason:prep_dose_water", "correct"), 1);
  equal(find("C3_both@1.5/reason:prep_dose_coffee", "correct"), 1);
  equal(find("C3_both@1.5/kind:preparation", "correct"), 2);
  // x2.0 reads the 30 g preparation amount (exactly 2x) as coffee.
  equal(find("C3_both@2.0/reason:prep_dose_coffee", "labelled"), 2);
  equal(find("C3_both@2.0/reason:prep_dose_coffee", "correct"), 1);
  equal(find("C3_both@2.0/overall", "confusion", "water:coffee"), 1);
  equal(find("C0_legacy/lang:ja", "accuracy"), 0);
  equal(find("default/lang:ja", "accuracy"), 1);
});

Deno.test("what-if: flips against C0_legacy, overall and per step kind", () => {
  // [right_to_wrong, wrong_to_right]
  equal(flips("C3_both@1.25", "overall"), [1, 3]);
  equal(flips("C3_both@1.25", "kind:preparation"), [0, 2]);
  equal(flips("C3_both@1.25", "kind:brew"), [1, 1]);
  for (const policy of ["C3_both@1.5", "default"]) {
    equal(flips(policy, "overall"), [0, 3]);
    equal(flips(policy, "kind:preparation"), [0, 2]);
    equal(flips(policy, "kind:brew"), [0, 1]);
  }
  equal(flips("C3_both@2.0", "overall"), [0, 2]);
  equal(flips("C3_both@2.0", "kind:preparation"), [0, 1]);
  equal(flips("C3_both@2.0", "kind:brew"), [0, 1]);
  // No flips are reported for C0_legacy against itself.
  equal(
    METRICS.filter((metric) =>
      metric.name === "flip" && metric.scope.startsWith("C0_legacy/")
    ),
    [],
  );
});

Deno.test("what-if: default scores equal C3_both at COFFEE_DOSE_BOUND_FACTOR", () => {
  const names = [
    "orphan",
    "confusion",
    "labelled",
    "correct",
    "accuracy",
    "flip",
  ];
  equal(
    unprefixed("default", names),
    unprefixed(defaultEquivalentCandidate(), names),
  );
});

Deno.test("what-if: C0_legacy feature breakdown by reason, label, outcome, buckets", () => {
  const features = METRICS.filter((metric) => metric.name === "feature");
  equal(
    features.map((metric) => [metric.scope, metric.key, metric.value]),
    [
      [
        "C0_legacy/overall",
        "cleanest_ratio|coffee|water|vc:le_1.05|vw:lt_0.1",
        1,
      ],
      [
        "C0_legacy/overall",
        "cleanest_ratio|water|coffee|vc:1.05_2|vw:0.1_0.5",
        1,
      ],
      [
        "C0_legacy/overall",
        "keyword_coffee|coffee|coffee|vc:1.05_2|vw:lt_0.1",
        2,
      ],
      [
        "C0_legacy/overall",
        "keyword_coffee|water|coffee|vc:gt_2|vw:0.1_0.5",
        1,
      ],
    ],
  );
});

// plan 043 Ph 4: the plain replay used to equal C0; since stage C it runs
// the default rule, so it equals the "default" candidate, and C0_legacy
// equals an explicit C0_legacy replay.
Deno.test("what-if: default and C0_legacy scores match the plain replays", () => {
  const plainNames = ["orphan", "confusion", "labelled", "correct", "accuracy"];
  equal(
    unprefixed("default", plainNames),
    parse(formatCorpusAccuracy(scoreCorpusLabels(ROWS, LABELS))),
  );
  equal(
    unprefixed("C0_legacy", plainNames),
    parse(
      formatCorpusAccuracy(
        scoreCorpusLabels(
          ROWS,
          LABELS,
          explainNumericValueConversion,
          "C0_legacy",
        ),
      ),
    ),
  );
});

Deno.test("what-if: an explicit candidate list is honoured", () => {
  const metrics = parse(
    formatCorpusWhatIf(ROWS, LABELS, explainNumericValueConversion, [
      "C0_legacy",
      "C1_coffee_bound@1.25",
    ]),
  );
  equal(
    [...new Set(metrics.map((metric) => metric.scope.split("/")[0]))],
    ["C0_legacy", "C1_coffee_bound@1.25"],
  );
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
