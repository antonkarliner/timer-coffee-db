// Plan 043 Phase 1: scores the deterministic converter
// (explainNumericValueConversion) against the plan-080 corpus labels.
//
// Privacy: corpus text is user data. Nothing here may put step text, or any
// snippet of it, into an error message, a metric or a log line. Errors are
// fixed strings; metrics are counts keyed by label, outcome, reason, step
// kind and locale.

import {
  type AmountConversionExplanation,
  explainNumericValueConversion,
} from "./parser.ts";

export type CorpusRow = {
  id: number;
  operator?: boolean | null;
  coffee: number | null;
  water: number | null;
  locale?: string | null;
  src: string[];
  cor?: string[] | null;
};

export const CORPUS_LABELS = [
  "coffee",
  "water",
  "fixed",
  "cumulative_target_water",
  "not_an_amount",
] as const;
export type CorpusLabelName = typeof CORPUS_LABELS[number];

export type CorpusLabel = {
  diagnostics_id: number;
  step_index: number;
  char_start: number;
  char_end: number;
  label: CorpusLabelName;
};

export const CORPUS_OUTCOMES = [
  "coffee",
  "water",
  "literal",
  "missed",
] as const;
export type CorpusOutcome = typeof CORPUS_OUTCOMES[number];

export type CorpusAccuracy = {
  scopes: Map<string, { labelled: number; correct: number }>;
  confusion: Map<string, number>;
  orphan: number;
};

type Explain = typeof explainNumericValueConversion;

// Raised for malformed input. Messages are fixed strings that never quote
// the input, so callers may surface them.
export class CorpusFormatError extends Error {}

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export function parseCorpusRows(input: unknown): CorpusRow[] {
  if (!Array.isArray(input)) {
    throw new CorpusFormatError("Malformed corpus: expected an array of rows.");
  }
  return input.map((row) => {
    if (
      typeof row !== "object" || row === null || !isInteger(row.id) ||
      !Array.isArray(row.src) ||
      !row.src.every((step: unknown) => typeof step === "string")
    ) {
      throw new CorpusFormatError("Malformed corpus row.");
    }
    return row as CorpusRow;
  });
}

export function parseCorpusLabels(input: unknown): CorpusLabel[] {
  if (!Array.isArray(input)) {
    throw new CorpusFormatError("Malformed labels: expected an array.");
  }
  return input.map((label) => {
    if (
      typeof label !== "object" || label === null ||
      !isInteger(label.diagnostics_id) || !isInteger(label.step_index) ||
      !isInteger(label.char_start) || !isInteger(label.char_end) ||
      label.char_start < 0 || label.char_end <= label.char_start ||
      !(CORPUS_LABELS as readonly unknown[]).includes(label.label)
    ) {
      throw new CorpusFormatError("Malformed label.");
    }
    return label as CorpusLabel;
  });
}

// Same rule as the app harness (timer-coffee test/tooling/
// recipe_corpus_sample.dart corpusRowEligible), so the two accuracy numbers
// cover the same rows.
export function isEligibleCorpusRow(row: CorpusRow): boolean {
  return row.operator !== true && isPositiveFinite(row.coffee) &&
    isPositiveFinite(row.water) &&
    (!Array.isArray(row.cor) || row.cor.length === row.src.length);
}

// Primary language subtag, or "und" (app harness corpusLanguage), so
// per-language keys match the app's.
export function corpusLanguage(row: CorpusRow): string {
  const primary = (typeof row.locale === "string" ? row.locale : "")
    .toLowerCase()
    .split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : "und";
}

export function expectedOutcome(label: CorpusLabelName): CorpusOutcome {
  switch (label) {
    case "coffee":
      return "coffee";
    case "water":
    case "cumulative_target_water":
      return "water";
    case "fixed":
    case "not_an_amount":
      return "literal";
  }
}

export function amountOutcome(
  amount: AmountConversionExplanation | null,
): CorpusOutcome {
  if (amount === null) return "missed";
  if (amount.placeholder === "<final_coffee_amount>") return "coffee";
  if (amount.placeholder === "<final_water_amount>") return "water";
  return "literal";
}

// Largest overlap with the label span wins; on a tie, the narrower amount
// (a range the single-amount pass re-scanned overlaps as much as the single
// amount inside it). No overlap means the converter missed the label.
export function matchLabelSpan(
  amounts: AmountConversionExplanation[],
  start: number,
  end: number,
): AmountConversionExplanation | null {
  let best: AmountConversionExplanation | null = null;
  let bestOverlap = 0;
  for (const amount of amounts) {
    const overlap = Math.min(amount.end, end) - Math.max(amount.start, start);
    if (overlap <= 0) continue;
    if (
      best === null || overlap > bestOverlap ||
      (overlap === bestOverlap &&
        amount.end - amount.start < best.end - best.start)
    ) {
      best = amount;
      bestOverlap = overlap;
    }
  }
  return best;
}

// The fallback-path conditions, deliberately: no LLM scalable/rate lists,
// step 0 is preparation, every later step is a brew step with no role.
export function explainCorpusStep(
  row: CorpusRow,
  stepIndex: number,
  explain: Explain = explainNumericValueConversion,
): AmountConversionExplanation[] {
  const isPreparation = stepIndex === 0;
  return explain({
    description: row.src[stepIndex],
    stepKind: isPreparation ? "preparation" : "brew",
    coffeeAmount: row.coffee,
    waterAmount: row.water,
    scalableAmounts: [],
    rateAmounts: [],
    ...(isPreparation ? { stepRole: "preparation" as const } : {}),
  });
}

export function scoreCorpusLabels(
  rows: CorpusRow[],
  labels: CorpusLabel[],
  explain: Explain = explainNumericValueConversion,
): CorpusAccuracy {
  const result: CorpusAccuracy = {
    scopes: new Map([["overall", { labelled: 0, correct: 0 }]]),
    confusion: new Map(),
    orphan: 0,
  };
  const eligible = new Map<number, CorpusRow>();
  for (const row of rows) {
    if (isEligibleCorpusRow(row)) eligible.set(row.id, row);
  }
  const explained = new Map<string, AmountConversionExplanation[]>();

  for (const label of labels) {
    const row = eligible.get(label.diagnostics_id);
    if (
      row === undefined || label.step_index < 0 ||
      label.step_index >= row.src.length
    ) {
      result.orphan++;
      continue;
    }
    if (label.char_end > row.src[label.step_index].length) {
      throw new CorpusFormatError(
        "Malformed label: span past the end of its step.",
      );
    }

    const cacheKey = `${row.id}:${label.step_index}`;
    let amounts = explained.get(cacheKey);
    if (amounts === undefined) {
      amounts = explainCorpusStep(row, label.step_index, explain);
      explained.set(cacheKey, amounts);
    }

    const matched = matchLabelSpan(amounts, label.char_start, label.char_end);
    const outcome = amountOutcome(matched);
    const correct = outcome === expectedOutcome(label.label);
    const confusionKey = `${label.label}:${outcome}`;
    result.confusion.set(
      confusionKey,
      (result.confusion.get(confusionKey) ?? 0) + 1,
    );
    for (
      const scope of [
        "overall",
        `lang:${corpusLanguage(row)}`,
        `kind:${label.step_index === 0 ? "preparation" : "brew"}`,
        `reason:${matched?.reason ?? "missed"}`,
      ]
    ) {
      const counts = result.scopes.get(scope) ?? { labelled: 0, correct: 0 };
      counts.labelled++;
      if (correct) counts.correct++;
      result.scopes.set(scope, counts);
    }
  }
  return result;
}

function metricLine(
  scope: string,
  name: string,
  value: number,
  key?: string,
): string {
  return `METRIC ${
    JSON.stringify({
      scope,
      kind: "all",
      name,
      ...(key === undefined ? {} : { key }),
      value,
    })
  }`;
}

// Same line format as the app harness (timer-coffee
// test/tooling/recipe_corpus_accuracy.dart), so the two can be compared.
export function formatCorpusAccuracy(result: CorpusAccuracy): string[] {
  const lines = [metricLine("overall", "orphan", result.orphan)];
  for (const label of CORPUS_LABELS) {
    for (const outcome of CORPUS_OUTCOMES) {
      const key = `${label}:${outcome}`;
      lines.push(
        metricLine("overall", "confusion", result.confusion.get(key) ?? 0, key),
      );
    }
  }
  for (const scope of [...result.scopes.keys()].sort()) {
    const { labelled, correct } = result.scopes.get(scope)!;
    lines.push(
      metricLine(scope, "labelled", labelled),
      metricLine(scope, "correct", correct),
      metricLine(scope, "accuracy", labelled === 0 ? 0 : correct / labelled),
    );
  }
  return lines;
}

// Without labels: corpus size and what the converter decided, by reason.
export function summarizeCorpus(
  rows: CorpusRow[],
  explain: Explain = explainNumericValueConversion,
): string[] {
  const eligible = rows.filter(isEligibleCorpusRow);
  const reasons = new Map<string, number>();
  let steps = 0;
  for (const row of eligible) {
    for (let index = 0; index < row.src.length; index++) {
      steps++;
      for (const amount of explainCorpusStep(row, index, explain)) {
        reasons.set(amount.reason, (reasons.get(amount.reason) ?? 0) + 1);
      }
    }
  }
  return [
    metricLine("overall", "rows", rows.length),
    metricLine("overall", "rows_eligible", eligible.length),
    metricLine("overall", "steps", steps),
    ...[...reasons.keys()].sort().map((reason) =>
      metricLine(`reason:${reason}`, "detected", reasons.get(reason)!)
    ),
  ];
}
