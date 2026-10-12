// Plan 043 Phase 1: replays the plan-080 corpus through the deterministic
// converter only. Skipped unless RECIPE_CORPUS_JSON is set; scores only when
// RECIPE_CORPUS_LABELS is set too. Run WITHOUT --allow-net, so an accidental
// provider call fails instead of sending text:
//
//   deno test --no-lock --allow-read --allow-env \
//     supabase/functions/parse-user-recipe-draft/corpus_replay_test.ts
//
// Plan 043 Phase 4 what-if: with RECIPE_CORPUS_WHATIF=1 as well, also scores
// every candidate placeholder policy on the same labels (formatCorpusWhatIf):
//
//   RECIPE_CORPUS_WHATIF=1 deno test --no-lock --allow-read --allow-env \
//     supabase/functions/parse-user-recipe-draft/corpus_replay_test.ts
//
// Prints METRIC aggregate lines only. Never print, log or rethrow anything
// that could carry step text: every failure below is replaced with a fixed
// message.

import {
  CorpusFormatError,
  formatCorpusAccuracy,
  formatCorpusWhatIf,
  parseCorpusLabels,
  parseCorpusRows,
  scoreCorpusLabels,
  summarizeCorpus,
} from "./corpus_scoring.ts";

function readEnv(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const corpusPath = readEnv("RECIPE_CORPUS_JSON");
const labelsPath = readEnv("RECIPE_CORPUS_LABELS");
const whatIf = readEnv("RECIPE_CORPUS_WHATIF") === "1";

Deno.test({
  name: "corpus replay: deterministic converter vs plan-080 labels",
  ignore: corpusPath === undefined,
  fn() {
    let lines: string[];
    try {
      const rows = parseCorpusRows(
        JSON.parse(Deno.readTextFileSync(corpusPath!)),
      );
      lines = summarizeCorpus(rows);
      if (labelsPath !== undefined) {
        const labels = parseCorpusLabels(
          JSON.parse(Deno.readTextFileSync(labelsPath)),
        );
        lines.push(...formatCorpusAccuracy(scoreCorpusLabels(rows, labels)));
        if (whatIf) {
          lines.push(...formatCorpusWhatIf(rows, labels));
        }
      } else if (whatIf) {
        throw new CorpusFormatError(
          "RECIPE_CORPUS_WHATIF needs RECIPE_CORPUS_LABELS.",
        );
      }
    } catch (error) {
      // File, JSON and conversion errors can quote private input. Never
      // surface the caught error, its message or its stack; only our own
      // fixed format messages pass through.
      throw new Error(
        error instanceof CorpusFormatError
          ? error.message
          : "Corpus loading or processing failed.",
      );
    }
    console.log(lines.join("\n"));
  },
});
