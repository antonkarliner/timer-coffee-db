// Synthetic rows only. Never copy or paraphrase corpus text into this file.

import type { AmountConversionExplanation } from "./parser.ts";
import {
  CorpusFormatError,
  type CorpusLabel,
  corpusLanguage,
  type CorpusRow,
  explainCorpusStep,
  formatCorpusAccuracy,
  isEligibleCorpusRow,
  matchLabelSpan,
  parseCorpusLabels,
  parseCorpusRows,
  scoreCorpusLabels,
  summarizeCorpus,
} from "./corpus_scoring.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function throwsFormatError(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof CorpusFormatError) return;
    throw error;
  }
  throw new Error("Expected a CorpusFormatError");
}

const ROWS: CorpusRow[] = [
  {
    id: 1,
    operator: false,
    coffee: 15,
    water: 250,
    locale: "en",
    src: [
      "Rinse filter with 300 ml",
      "Pour to 150 g",
      "Add 1-200 g now",
      "Wait 30 s",
    ],
  },
  {
    id: 2,
    operator: false,
    coffee: 15,
    water: 250,
    locale: "zh",
    src: ["称取15克", "注水100克，"],
  },
  { id: 3, operator: true, coffee: 15, water: 250, src: ["Pour 50 g"] },
  { id: 4, coffee: null, water: 250, src: ["Pour 50 g"] },
  { id: 5, coffee: 15, water: 250, src: ["Weigh 15 g", "Heat 1 l of water"] },
];

function label(
  diagnosticsId: number,
  stepIndex: number,
  text: string,
  needle: string,
  name: CorpusLabel["label"],
): CorpusLabel {
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
  // fixed amount the fallback scales on a water keyword: wrong.
  label(1, 0, ROWS[0].src[0], "300 ml", "fixed"),
  // running total: right.
  label(1, 1, ROWS[0].src[1], "150 g", "cumulative_target_water"),
  // tie-break: the rejected range and the re-scanned "200 g" overlap the
  // label equally; the narrower one (converted to water) must win.
  label(1, 2, ROWS[0].src[2], "200 g", "water"),
  // nothing detected: missed.
  label(1, 3, ROWS[0].src[3], "30", "not_an_amount"),
  // CJK amount at end of text: exact coffee total, right.
  label(2, 0, ROWS[1].src[0], "15克", "coffee"),
  // CJK unit glued to full-width punctuation: missed (plan 043 Phase 2).
  label(2, 1, ROWS[1].src[1], "100克", "water"),
  // below the 2% floor stays literal: right.
  label(5, 1, ROWS[4].src[1], "1 l", "not_an_amount"),
  // orphans: operator row, ineligible row, step out of range, unknown row.
  {
    diagnostics_id: 3,
    step_index: 0,
    char_start: 5,
    char_end: 9,
    label: "water",
  },
  {
    diagnostics_id: 4,
    step_index: 0,
    char_start: 5,
    char_end: 9,
    label: "water",
  },
  {
    diagnostics_id: 1,
    step_index: 9,
    char_start: 0,
    char_end: 1,
    label: "water",
  },
  {
    diagnostics_id: 99,
    step_index: 0,
    char_start: 0,
    char_end: 1,
    label: "coffee",
  },
];

function scope(result: ReturnType<typeof scoreCorpusLabels>, name: string) {
  return result.scopes.get(name) ?? null;
}

Deno.test("scoring: overall, orphan and per-scope counts", () => {
  const result = scoreCorpusLabels(ROWS, LABELS);
  equal(result.orphan, 4);
  equal(scope(result, "overall"), { labelled: 7, correct: 4 });
  equal(scope(result, "lang:en"), { labelled: 4, correct: 2 });
  equal(scope(result, "lang:zh"), { labelled: 2, correct: 1 });
  equal(scope(result, "lang:und"), { labelled: 1, correct: 1 });
  equal(scope(result, "kind:preparation"), { labelled: 2, correct: 1 });
  equal(scope(result, "kind:brew"), { labelled: 5, correct: 3 });
  equal(scope(result, "reason:missed"), { labelled: 2, correct: 0 });
  equal(scope(result, "reason:keyword_water"), { labelled: 2, correct: 1 });
  equal(scope(result, "reason:brew_default_water"), {
    labelled: 1,
    correct: 1,
  });
  equal(scope(result, "reason:exact_total_coffee"), {
    labelled: 1,
    correct: 1,
  });
  equal(scope(result, "reason:skipped_below_floor"), {
    labelled: 1,
    correct: 1,
  });
});

Deno.test("scoring: confusion covers every expected case", () => {
  const result = scoreCorpusLabels(ROWS, LABELS);
  equal(Object.fromEntries([...result.confusion].sort()), {
    "coffee:coffee": 1,
    "cumulative_target_water:water": 1,
    "fixed:water": 1,
    "not_an_amount:literal": 1,
    "not_an_amount:missed": 1,
    "water:missed": 1,
    "water:water": 1,
  });
});

Deno.test("scoring: fixed label converted to coffee or kept literal", () => {
  const rows: CorpusRow[] = [{
    id: 7,
    coffee: 15,
    water: 250,
    locale: "en",
    src: ["Weigh 15 g", "Add 2 g of salt"],
  }];
  const result = scoreCorpusLabels(rows, [
    label(7, 0, rows[0].src[0], "15 g", "fixed"),
    label(7, 1, rows[0].src[1], "2 g", "fixed"),
  ]);
  equal(Object.fromEntries([...result.confusion].sort()), {
    "fixed:coffee": 1,
    "fixed:literal": 1,
  });
});

Deno.test("matchLabelSpan: largest overlap, narrower on a tie, null on none", () => {
  const amount = (start: number, end: number): AmountConversionExplanation => ({
    start,
    end,
    value: 1,
    unit: "g",
    isRange: false,
    placeholder: null,
    reason: "brew_default_water",
  });
  const wide = amount(0, 12);
  const narrow = amount(4, 9);
  const partial = amount(8, 20);
  equal(matchLabelSpan([wide, narrow], 4, 9), narrow);
  equal(matchLabelSpan([narrow, wide], 4, 9), narrow);
  equal(matchLabelSpan([partial, narrow], 4, 9), narrow);
  equal(matchLabelSpan([wide, partial], 10, 20), partial);
  equal(matchLabelSpan([narrow], 9, 12), null);
  equal(matchLabelSpan([], 0, 1), null);
});

Deno.test("explainCorpusStep: fallback-path conditions", () => {
  const calls: unknown[] = [];
  const fake = ((args: unknown) => {
    calls.push(args);
    return [];
  }) as Parameters<typeof explainCorpusStep>[2];
  explainCorpusStep(ROWS[0], 0, fake);
  explainCorpusStep(ROWS[0], 1, fake);
  equal(calls, [
    {
      description: ROWS[0].src[0],
      stepKind: "preparation",
      coffeeAmount: 15,
      waterAmount: 250,
      scalableAmounts: [],
      rateAmounts: [],
      stepRole: "preparation",
    },
    {
      description: ROWS[0].src[1],
      stepKind: "brew",
      coffeeAmount: 15,
      waterAmount: 250,
      scalableAmounts: [],
      rateAmounts: [],
    },
  ]);
});

Deno.test("parsing: malformed labels and rows throw", () => {
  const good = {
    diagnostics_id: 1,
    step_index: 0,
    char_start: 0,
    char_end: 3,
    label: "water",
  };
  equal(parseCorpusLabels([good]).length, 1);
  for (
    const bad of [
      { ...good, label: "tea" },
      { ...good, char_end: 0 },
      { ...good, char_start: -1 },
      { ...good, char_start: 0.5 },
      { ...good, step_index: "0" },
      { ...good, diagnostics_id: null },
      null,
    ]
  ) {
    throwsFormatError(() => parseCorpusLabels([bad]));
  }
  throwsFormatError(() => parseCorpusLabels({}));
  throwsFormatError(() => parseCorpusRows([{ id: 1, src: "Pour 50 g" }]));
  throwsFormatError(() => parseCorpusRows([{ id: 1, src: [42] }]));
  throwsFormatError(() => parseCorpusRows([{ id: "1", src: [] }]));
  equal(parseCorpusRows(ROWS).length, ROWS.length);
});

Deno.test("scoring: a span past the end of its step throws without text", () => {
  try {
    scoreCorpusLabels(ROWS, [{
      diagnostics_id: 1,
      step_index: 1,
      char_start: 0,
      char_end: 500,
      label: "water",
    }]);
  } catch (error) {
    if (!(error instanceof CorpusFormatError)) throw error;
    for (const step of ROWS.flatMap((row) => row.src)) {
      if (error.message.includes(step)) throw new Error("message quotes text");
    }
    return;
  }
  throw new Error("Expected a CorpusFormatError");
});

Deno.test("formatting: METRIC aggregates only, no step text", () => {
  const lines = [
    ...summarizeCorpus(ROWS),
    ...formatCorpusAccuracy(scoreCorpusLabels(ROWS, LABELS)),
  ];
  const metrics = lines.map((line) => {
    if (!line.startsWith("METRIC ")) throw new Error("not a METRIC line");
    return JSON.parse(line.slice("METRIC ".length));
  });
  // Whole steps, plus words that appear in no metric name or key.
  const fragments = [
    ...ROWS.flatMap((row) => row.src),
    "Rinse",
    "filter",
    "Heat",
    "Weigh",
    "Wait",
    "称取",
    "注水",
  ];
  for (const line of lines) {
    for (const fragment of fragments) {
      if (line.includes(fragment)) throw new Error("metric line quotes text");
    }
  }
  for (const metric of metrics) {
    equal(metric.kind, "all");
    equal(typeof metric.value, "number");
  }
  const find = (scopeName: string, name: string, key?: string) =>
    metrics.find((metric) =>
      metric.scope === scopeName && metric.name === name && metric.key === key
    )?.value;
  equal(find("overall", "rows"), 5);
  equal(find("overall", "rows_eligible"), 3);
  equal(find("overall", "labelled"), 7);
  equal(find("overall", "correct"), 4);
  equal(find("overall", "orphan"), 4);
  equal(find("overall", "confusion", "water:missed"), 1);
  equal(find("overall", "confusion", "coffee:literal"), 0);
  equal(
    metrics.filter((metric) => metric.name === "confusion").length,
    5 * 4,
  );
  equal(find("lang:zh", "accuracy"), 0.5);
});

Deno.test("eligibility and language match the app harness", () => {
  const base = { id: 7, coffee: 15, water: 250, src: ["a", "b"] };
  equal(isEligibleCorpusRow({ ...base, cor: ["a", "b"] }), true);
  equal(isEligibleCorpusRow({ ...base, cor: ["a"] }), false);
  equal(isEligibleCorpusRow({ ...base, water: 0 }), false);
  equal(corpusLanguage({ ...base, locale: "pt-BR" }), "pt");
  equal(corpusLanguage({ ...base, locale: "zh_Hans" }), "zh");
  equal(corpusLanguage({ ...base, locale: "" }), "und");
  equal(corpusLanguage({ ...base, locale: null }), "und");
});
