import { OPENAI_MODELS } from "../_shared/ai-models.ts";
import {
  createRecipeDraftParser,
  type CumulativeRewriteResult,
  type ExtractionResult,
  formatMultiplier,
  type NormalizedDraft,
  type RecipeDraftAiProvider,
  type StageCaptureEntry,
} from "./parser.ts";

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

function createMockProvider(args: {
  name: RecipeDraftAiProvider["name"];
  tag?: string;
  model?: string;
  extraction?: ExtractionResult;
  normalized?: NormalizedDraft;
  repair?: NormalizedDraft;
  cumulativeRewrite?: CumulativeRewriteResult;
  failExtraction?: boolean;
  failNormalization?: boolean;
  failRepair?: boolean;
  failCumulativeRewrite?: boolean;
  calls: Array<{ provider: string; stage: string }>;
  systemPrompts?: Array<
    { provider: string; stage: string; systemPrompt: string }
  >;
}): RecipeDraftAiProvider {
  return {
    name: args.name,
    model: args.model ?? args.tag ?? args.name,
    invokeJson<T>(
      input: {
        stage:
          | "extraction"
          | "normalization"
          | "repair"
          | "cumulative_rewrite";
        systemPrompt: string;
      },
    ) {
      args.calls.push({
        provider: args.tag ?? args.name,
        stage: input.stage,
      });
      args.systemPrompts?.push({
        provider: args.tag ?? args.name,
        stage: input.stage,
        systemPrompt: input.systemPrompt,
      });

      if (input.stage === "extraction") {
        if (args.failExtraction || !args.extraction) {
          return Promise.reject(new Error(`${args.name} extraction failed`));
        }
        return Promise.resolve({ result: args.extraction as T, tokensUsed: 0 });
      }

      if (input.stage === "repair") {
        if (args.failRepair || !args.repair) {
          return Promise.reject(new Error(`${args.name} repair failed`));
        }
        return Promise.resolve({ result: args.repair as T, tokensUsed: 0 });
      }

      if (input.stage === "cumulative_rewrite") {
        if (args.failCumulativeRewrite || !args.cumulativeRewrite) {
          return Promise.reject(
            new Error(`${args.name} cumulative rewrite failed`),
          );
        }
        return Promise.resolve({
          result: args.cumulativeRewrite as T,
          tokensUsed: 0,
        });
      }

      if (args.failNormalization || !args.normalized) {
        return Promise.reject(new Error(`${args.name} normalization failed`));
      }

      return Promise.resolve({ result: args.normalized as T, tokensUsed: 0 });
    },
  };
}

// Stage-capture (opt-in via capture_stages) test provider: unlike
// createMockProvider above (which has no concept of "raw text" — it hands
// back a canned parsed object directly), this one gives each test full,
// explicit control over what invokeJson's onAttempt callback sees for each
// scripted attempt, mirroring what the real OpenAI-compatible/Gemini
// providers do (raw_text/finish_reason captured regardless of success or
// failure). Each stage has its own queue; each invokeJson call for that
// stage pops the next scripted outcome.
type StageCaptureScriptedOutcome =
  | {
    ok: true;
    result: unknown;
    rawText?: string;
    finishReason?: string | null;
    tokensUsed?: number;
  }
  | {
    ok: false;
    error: string;
    rawText?: string;
    finishReason?: string | null;
  };

function createStageCaptureTestProvider(args: {
  name: RecipeDraftAiProvider["name"];
  model?: string;
  outcomes: Partial<
    Record<
      "extraction" | "normalization" | "repair" | "cumulative_rewrite",
      StageCaptureScriptedOutcome[]
    >
  >;
}): RecipeDraftAiProvider {
  const queues = new Map(
    Object.entries(args.outcomes).map((
      [stage, outcomes],
    ) => [stage, [...(outcomes ?? [])]]),
  );

  return {
    name: args.name,
    model: args.model ?? args.name,
    invokeJson<T>(
      input: {
        stage: string;
        onAttempt?: (info: {
          rawText: string;
          finishReason: string | null;
          parsed: T | null;
          error: string | null;
        }) => void;
      },
    ) {
      const queue = queues.get(input.stage);
      const outcome = queue?.shift();
      if (!outcome) {
        return Promise.reject(
          new Error(
            `createStageCaptureTestProvider: ${args.name} ran out of scripted outcomes for stage "${input.stage}"`,
          ),
        );
      }

      if (outcome.ok) {
        input.onAttempt?.({
          rawText: outcome.rawText ?? JSON.stringify(outcome.result),
          finishReason: outcome.finishReason ?? "stop",
          parsed: outcome.result as T,
          error: null,
        });
        return Promise.resolve({
          result: outcome.result as T,
          tokensUsed: outcome.tokensUsed ?? 0,
        });
      }

      input.onAttempt?.({
        rawText: outcome.rawText ?? "",
        finishReason: outcome.finishReason ?? null,
        parsed: null,
        error: outcome.error,
      });
      return Promise.reject(new Error(outcome.error));
    },
  };
}

function createExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "fr",
    likely_brewing_method: "Hario V60",
    name: "Recette V60",
    short_description: "Une tasse douce et propre",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 250,
    preparation: "Rinse the filter and add the coffee.",
    steps: [
      {
        title: null,
        raw_text: "Rinse the filter and add the coffee.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour 50g of water and bloom for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour to 250g total and wait 90 seconds.",
        duration_seconds: 90,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "fr",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "medium",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Recette V60",
      grind_size: "Medium",
      short_description: "Une tasse douce et propre",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add (15)g coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom for 30 seconds.",
        description_template: "Pour 50g of water and bloom.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour to 250g total and wait 90 seconds.",
        description_template: "Pour up to 250g total and wait.",
        duration_seconds: 90,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createAmbiguousWaterNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Ambiguous V60",
      grind_size: "Medium",
      short_description: "Tests water expression conversion",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add 15g coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 30g water for bloom.",
        description_template: "Pour 30g water for bloom.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createMissingRequiredNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: null,
      brewing_method_confidence: "none",
      coffee_amount: null,
      water_amount: null,
      water_temp: null,
    },
    localization: {
      name: null,
      grind_size: null,
      short_description: null,
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add 15g coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom for 30 seconds.",
        description_template: "Pour 50g of water and bloom.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createRepairNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Recovered V60",
      grind_size: "Fine",
      short_description: "Recovered from repair pass",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add 15g coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom for 30 seconds.",
        description_template: "Pour 50g of water and bloom.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createDisplayNameMethodNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "Hario V60",
      brewing_method_confidence: "medium",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Resolved V60",
      grind_size: "Medium",
      short_description: "Tests brewing method remapping",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add 15g coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 50g water for bloom.",
        description_template: "Pour 50g water for bloom.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createTemperatureMentionNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 96.1,
    },
    localization: {
      name: "Temperature Mention V60",
      grind_size: "Medium",
      short_description: "Tests Celsius normalization inside step descriptions",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Heat water to 205F and rinse the filter.",
        description_template: "Heat water to 205F and rinse the filter.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 50g water and bloom for 30 seconds.",
        description_template: "Pour 50g water and bloom for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createMalformedExpressionNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Malformed Expression V60",
      grind_size: "Medium",
      short_description: "Tests malformed scalable expression recovery",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add 15g coffee.",
        description_template: "Rinse the filter and add 15g coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 50g water for bloom.",
        description_template:
          "Pour (N x <final_water_amount>)g water for bloom.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createNestedExpressionMathExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Chemex",
    name: "Bloom-heavy Chemex",
    short_description: null,
    grind_size: "coarse",
    water_temp_celsius: 100,
    coffee_amount_grams: 40,
    water_amount: 700,
    preparation: "Rinse the filter and add 40g coffee.",
    steps: [
      {
        title: "Bloom",
        raw_text:
          "Start the timer and begin the first pour, adding about 140g of water.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: "Main pour",
        raw_text: "Pour up to 700g total.",
        duration_seconds: 120,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createNestedExpressionMathNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 40,
      water_amount: 700,
      water_temp: 100,
    },
    localization: {
      name: "Bloom-heavy Chemex",
      grind_size: "coarse",
      short_description: "Tests nested expression-like math cleanup",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add 40g coffee.",
        description_template: "Rinse the filter and add 40g coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Start the timer and begin the first pour, adding about 140g of water.",
        description_template:
          "Start the timer and begin the first pour, adding about (0.2 x (1 x <final_water_amount>)g of water.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour up to 700g total.",
        description_template: "Pour up to (1 x <final_water_amount>)g total.",
        duration_seconds: 120,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createTooShortBrewDurationsNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Short Timer V60",
      grind_size: "medium",
      short_description: "Tests short brew-step duration normalization",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add 15g coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom briefly.",
        description_template: "Pour 50g of water and bloom briefly.",
        duration_seconds: 3,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour up to 250g total and wait briefly.",
        description_template: "Pour up to 250g total and wait briefly.",
        duration_seconds: 4,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

// D7 (plan 020 §3 D7, §4b decision) fixtures. All three share the same
// recipe/localization shape as createTooShortBrewDurationsNormalized and
// differ only in per-step duration_is_stated/duration_seconds, to isolate
// enforceMinimumStepDurations's absorb-from-neighbour behaviour from
// everything else in the pipeline. None of these steps carry elapsed_seconds,
// so normalizeAbsoluteTimestampDurations's timestamp-differencing path never
// engages (timestamped.length < 2) — enforceMinimumStepDurations is the only
// pass that can touch these durations.
function createStatedSubMinimumAbsorbableNormalized(): NormalizedDraft {
  const base = createTooShortBrewDurationsNormalized();
  return {
    ...base,
    steps: [
      base.steps[0],
      {
        ...base.steps[1],
        description_source: "Bloom for 10 seconds.",
        description_template: "Bloom for 10 seconds.",
        duration_seconds: 10,
        duration_is_stated: true,
      },
      {
        ...base.steps[1],
        description_source: "Stir for 5 seconds.",
        description_template: "Stir for 5 seconds.",
        duration_seconds: 5,
        duration_is_stated: true,
      },
      {
        ...base.steps[2],
        description_source: "Wait for 20 seconds.",
        description_template: "Wait for 20 seconds.",
        duration_seconds: 20,
        duration_is_stated: true,
      },
    ],
  };
}

function createStatedSubMinimumUnabsorbableNormalized(): NormalizedDraft {
  const base = createTooShortBrewDurationsNormalized();
  return {
    ...base,
    steps: [
      base.steps[0],
      {
        ...base.steps[1],
        description_source: "Bloom for 10 seconds.",
        description_template: "Bloom for 10 seconds.",
        duration_seconds: 10,
        duration_is_stated: true,
      },
      {
        ...base.steps[1],
        description_source: "Stir for 4 seconds.",
        description_template: "Stir for 4 seconds.",
        duration_seconds: 4,
        duration_is_stated: true,
      },
      {
        ...base.steps[2],
        description_source: "Wait for 15 seconds.",
        description_template: "Wait for 15 seconds.",
        // Natural duration 15 can't pay a 6-second delta and stay at or
        // above the minimum (15 - 6 = 9 < 10), so this must NOT be treated
        // as an eligible payer.
        duration_seconds: 15,
        duration_is_stated: true,
      },
    ],
  };
}

function createStatedSubMinimumLastStepNormalized(): NormalizedDraft {
  const base = createTooShortBrewDurationsNormalized();
  return {
    ...base,
    steps: [
      base.steps[0],
      {
        ...base.steps[1],
        description_source: "Pour and wait 20 seconds.",
        description_template: "Pour and wait 20 seconds.",
        duration_seconds: 20,
        duration_is_stated: true,
      },
      {
        ...base.steps[2],
        description_source: "Swirl for 3 seconds.",
        description_template: "Swirl for 3 seconds.",
        // Last step in the recipe — there is no following step to absorb
        // the shortfall from.
        duration_seconds: 3,
        duration_is_stated: true,
      },
    ],
  };
}

// D7, elapsed-timestamp path: mirrors the AeroPress WAC shape (plan 019 §A,
// plan 020 §3 D7) where every step carries an explicit elapsed_seconds
// landmark, so the fix lives in normalizeAbsoluteTimestampDurations rather
// than enforceMinimumStepDurations. The stir's natural (diffed) duration is
// 15 - 10 = 5s; the following pour step's natural duration is 45 - 15 = 30s,
// which can afford the 5s delta and stay at or above the minimum.
function createTimestampedStatedSubMinimumNormalized(): NormalizedDraft {
  const base = createTooShortBrewDurationsNormalized();
  return {
    ...base,
    steps: [
      base.steps[0],
      {
        ...base.steps[1],
        description_source: "Start the timer and add 50g water.",
        description_template: "Start the timer and add 50g water.",
        duration_seconds: 10,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: true,
      },
      {
        ...base.steps[1],
        description_source: "Stir very gently.",
        description_template: "Stir very gently.",
        duration_seconds: 5,
        elapsed_seconds: 10,
        duration_is_stated: true,
      },
      {
        ...base.steps[2],
        description_source: "Pour up to 200g water.",
        description_template: "Pour up to 200g water.",
        duration_seconds: 30,
        elapsed_seconds: 15,
        duration_is_stated: true,
      },
      {
        ...base.steps[2],
        description_source: "Let it steep.",
        description_template: "Let it steep.",
        duration_seconds: 10,
        elapsed_seconds: 45,
        duration_is_stated: false,
      },
    ],
  };
}

function createTetsuTimestampExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60 pour-over",
    name: "Tetsu Kasuya 4:6 V60",
    short_description: null,
    grind_size: "Medium-coarse grind",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation:
      "Rinse the filter and preheat the brewer. Add coffee and level the bed.",
    steps: [
      {
        title: null,
        raw_text: "0:00 pour 50g",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "0:45 pour to 120g",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "1:30 pour to 180g",
        duration_seconds: 90,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "2:15 pour to 240g",
        duration_seconds: 135,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "3:00 pour to 300g",
        duration_seconds: 180,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Let draw down fully and serve.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createTetsuTimestampNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Tetsu Kasuya 4:6 V60",
      grind_size: "Medium-coarse grind",
      short_description: "Tests timestamp and expression recovery.",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Rinse the filter and preheat the brewer. Add coffee and level the bed.",
        description_template:
          "Rinse the filter and preheat the brewer. Add (1 x 20)g coffee and level the bed.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "0:00 pour 50g",
        description_template: "At 0:00, pour to 50g.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "0:45 pour to 120g",
        description_template: "At 0:45, pour to 120g.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "1:30 pour to 180g",
        description_template: "At 1:30, pour to 180g.",
        duration_seconds: 90,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "2:15 pour to 240g",
        description_template: "At 2:15, pour to 240g.",
        duration_seconds: 135,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "3:00 pour to 300g",
        description_template: "At 3:00, pour to 300g.",
        duration_seconds: 180,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Let draw down fully and serve.",
        description_template: "Let draw down fully and serve.",
        duration_seconds: 185,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createTimestampWithoutDrawdownNormalized(): NormalizedDraft {
  return {
    ...createTetsuTimestampNormalized(),
    localization: {
      ...createTetsuTimestampNormalized().localization,
      name: "Timestamp V60 without drawdown",
    },
    steps: createTetsuTimestampNormalized().steps.slice(0, 6),
  };
}

function createChemexNaturalElapsedExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Chemex",
    name: "ChemX",
    short_description:
      "The ChemX is the perfect combination of design and utility.",
    grind_size:
      "medium coarse, slightly finer than you would for a French press",
    water_temp_celsius: 96.1,
    coffee_amount_grams: 50,
    water_amount: 700,
    preparation:
      "A 6 cup Chemex, a Chemex filter, 50 grams of coffee, a scale with a timer, a kettle, and a grinder. Begin by heating about a full kettle of water to between 205 and 210 degrees. Place the filter in the chemex. Ensure the trifold portion of the filter is facing the pouring spout of the brewer. Rinse the filter thoroughly and pour out the excess water. Next, grind your coffee to a medium coarse level, slightly finer than you would for a French press. Place the grounds in the filter and gently shake to create a level coffee bed. Set the chemex on the scale and tear it.",
    steps: [
      {
        title: "Bloom pour",
        raw_text:
          "Start your timer and begin your first pour, known as the Bloom pour. Starting in the center, spiral your pour out and back until the coffee is completely saturated. Target adding around 100 grams of water.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Start the second pour at 45 seconds. Using the same pour pattern, spiral out towards the edge of the slurry before spiraling back. Unlike some other brewers, avoid pouring directly on the filter and bring the water weight up to 300 grams. The water should filter through the grounds almost completely before starting the next pour.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "At a minute and 50 seconds, start your third pour, still using the same pouring pattern. Bringing the water weight up to 500 grams. Pause again, allowing the water to filter through the grounds.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Begin the fourth and final pour at 3 minutes and 10 seconds. Still focusing on a consistent pour pattern, bring the water weight up to 700 grams.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [
      "Timed references like 45 seconds, a minute and 50 seconds, and 3 minutes and 10 seconds are elapsed brew times, not step durations.",
    ],
    // "Typically a chemex will finish brewing in around four minutes" in the
    // source is a statement about this recipe's own brew, so the extraction
    // stage reports it directly instead of leaving it for the deterministic
    // layer to mine out of raw text.
    total_brew_time_seconds: 240,
  };
}

function createChemexNaturalElapsedNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 50,
      water_amount: 700,
      water_temp: 96.1,
    },
    localization: {
      name: "ChemX",
      grind_size:
        "medium coarse, slightly finer than you would for a French press",
      short_description: "Tests natural elapsed time parsing.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: createChemexNaturalElapsedExtraction().preparation!,
        description_template:
          "Use a 6 cup Chemex with a Chemex filter, heat water to 96.1, place and rinse the filter with the trifold facing the spout, grind 50g of coffee medium coarse, add the grounds, level the bed, and set the Chemex on a scale and tare it.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[0].raw_text,
        description_template:
          "Start the timer and pour up to 100g, spiraling from the center out and back until the coffee is completely saturated.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[1].raw_text,
        description_template:
          "At 45 seconds, pour up to 300g using the same spiral pattern, avoiding the filter, and let the water drain almost completely before the next pour.",
        duration_seconds: 65,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[2].raw_text,
        description_template:
          "pour up to 500g using the same pouring pattern, then pause and let the water filter through.",
        duration_seconds: 80,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[3].raw_text,
        description_template: "pour up to 700g with a consistent pour pattern.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createVerboseChemexNaturalElapsedNormalized(): NormalizedDraft {
  return {
    ...createChemexNaturalElapsedNormalized(),
    steps: [
      {
        kind: "preparation",
        description_source: createChemexNaturalElapsedExtraction().preparation!,
        description_template:
          "So here's what you'll need. A 6 cup Chemex, a Chemex filter, 50 grams of coffee, a scale with a timer, a kettle, and a grinder. Begin by heating about a full kettle of water to between 96.1 and 96.1C. You want enough water to preheat the chemex and also to brew your coffee. Next, place the filter in the chemex. Ensure the trifold portion of the filter is facing the pouring spout of the brewer. This helps prevent the filter from clogging the spout. Now rinse the filter thoroughly and pour out the excess water. This preheats the carafe, creates a good seal between the filter and the brewer, and helps to remove any off-flavors. Next, grind your coffee to a medium coarse level, slightly finer than you would for a French press. It should resemble sea salt. Place the grounds in the filter and gently shake to create a level coffee bed. Set the chemex on the scale and tear it.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[0].raw_text,
        description_template:
          "Start your timer and begin your first pour, known as the Bloom pour. Starting in the center, spiral your pour out and back until the coffee is completely saturated. Target adding around 100 grams of water.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[1].raw_text,
        description_template:
          "Now start the second pour. Using the same pour pattern, spiral out towards the edge of the slurry before spiraling back. Unlike some other brewers, avoid pouring directly on the filter and bring the water weight up to 300 grams. The water should filter through the grounds almost completely before starting the next pour.",
        duration_seconds: 65,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[2].raw_text,
        description_template:
          "At a minute and 50 seconds, start your third pour, still using the same pouring pattern. Bringing the water weight up to 500 grams. Pause again, allowing the water to filter through the grounds.",
        duration_seconds: 80,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[3].raw_text,
        description_template:
          "Begin the fourth and final pour. Still focusing on a consistent pour pattern, bring the water weight up to 700 grams.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createChemexCoffeeMakerExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "English",
    likely_brewing_method: "Chemex",
    name: "Chemex Coffee Maker",
    short_description: "Technique guidance for brewing coffee with a Chemex.",
    grind_size: "just a little bit coarser",
    water_temp_celsius: 94,
    coffee_amount_grams: 30,
    water_amount: 500,
    preparation:
      "Rinse your papers for chemics papers. Make sure that the thick side is where the little channel is, where the air gap is, where the spout is.",
    steps: [
      {
        title: "Bloom",
        raw_text:
          "2 to 1 to 3 to 1 in terms of bloom water to coffee dose. So 60 grams of bloom to 90 grams of bloom if you're brewing 30 grams of coffee. and let that bloom for at least 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        // The source explicitly states "bloom for at least 45 seconds" —
        // this is a genuinely stated duration, not an inference.
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: "Pour",
        raw_text:
          "I would say a similar pouring technique in terms of phases to the V60 video",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: "Finish",
        raw_text:
          "At the end, you're going to do the same thing with a little stir and then a swirl to help the drawdown and have a flat bed.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [
      "The recipe states 60 grams per liter and also says brewing half a liter will use four to five minute brew times; water_amount is inferred as 500 from half a liter.",
    ],
    // "four to five minute brew times brewing half a liter" is a direct
    // statement about this recipe's own (500g) brew, so total_brew_time_seconds
    // is the midpoint of 4-5 minutes rounded to the nearest 5s: 270. The
    // earlier "three, three and a half minute brew time" mention is a
    // comparison ("you don't have to grind coarser... to get that... brew
    // time"), not a statement about this recipe, so it is ignored.
    total_brew_time_seconds: 270,
  };
}

function createChemexCoffeeMakerNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 30,
      water_amount: 500,
      water_temp: 94,
    },
    localization: {
      name: "Chemex Coffee Maker",
      grind_size: "just a little bit coarser",
      short_description: "Tests vague Chemex duration inference.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: createChemexCoffeeMakerExtraction().preparation!,
        description_template:
          "Rinse the Chemex filter and place it with the thick side toward the spout.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexCoffeeMakerExtraction().steps[0].raw_text,
        description_template: "Bloom with 60-90 grams water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexCoffeeMakerExtraction().steps[1].raw_text,
        description_template:
          "Continue pouring in phases until you reach 500g total water.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          createChemexCoffeeMakerExtraction().steps[2].raw_text,
        description_template:
          "Stir lightly, then swirl to level the bed and finish drawdown.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createHighConfidenceNormalized(): NormalizedDraft {
  return {
    ...createNormalized(),
    recipe: {
      ...createNormalized().recipe,
      brewing_method_confidence: "high",
    },
  };
}

function createPrepHeavyChemexExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Chemex",
    name: "Modified filter Chemex",
    short_description:
      "A coarse 40 g Chemex recipe for 650 g water using a modified filter, silicone chute cover, and staged pours.",
    grind_size: "coarse",
    water_temp_celsius: 96,
    coffee_amount_grams: 40,
    water_amount: 650,
    preparation:
      "Rinse the Chemex filter thoroughly and prepare the modified filter setup with the silicone chute cover.",
    steps: [
      {
        title: null,
        raw_text:
          "Rinse the Chemex filter thoroughly and prepare the modified filter setup with the silicone chute cover.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Begin the first staged pour and continue in pulses.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createPrepHeavyChemexNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 40,
      water_amount: 650,
      water_temp: 96,
    },
    localization: {
      name: "Modified filter Chemex",
      grind_size: "coarse",
      short_description:
        "A coarse 40 g Chemex recipe for 650 g water using a modified filter, silicone chute cover, and staged pours.",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Rinse the Chemex filter thoroughly and prepare the modified filter setup with the silicone chute cover.",
        description_template:
          "Rinse the Chemex filter thoroughly and prepare the modified filter setup with the silicone chute cover.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Begin the first staged pour and continue in pulses.",
        description_template:
          "Begin the first staged pour and continue in pulses.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createKimexExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "English",
    likely_brewing_method: "Chemex",
    name: "Kimex brew",
    short_description: null,
    grind_size: "coarse",
    water_temp_celsius: 100,
    coffee_amount_grams: 40,
    water_amount: 650,
    preparation:
      "Prepare the Chemex filter by cutting it into two flaps per side and fold as described. Cut a piece of food-safe silicone to cover the chute. Rinse the filter thoroughly and discard the rinse water. Place a glass stir stick in the Chemex, then add 40g of coarsely ground coffee and create a divot.",
    steps: [
      {
        title: "First bloom",
        raw_text:
          "Start timer and pour 100g of boiling water into the center, spiraling outward.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: "Second bloom",
        raw_text:
          "At 30 seconds, pour another 100g of water, then swirl until clumps disappear and gases are released.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: "Third pour",
        raw_text:
          "One minute later, pour 200g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: "Fourth pour",
        raw_text:
          "After another minute, pour 150g of water, maintaining a gentle swirl to avoid over-agitation.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: "Final pour",
        raw_text:
          "One minute after the previous pour, add the final 100g of water softly, finish with a light swirl and let the brew drain.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createKimexNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "English",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 40,
      water_amount: 650,
      water_temp: 100,
    },
    localization: {
      name: "Kimex brew",
      grind_size: "coarse",
      short_description: "A coarse Chemex recipe with a multi-pour bloom.",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Prepare the Chemex filter by cutting it into two flaps per side and fold as described. Cut a piece of food-safe silicone to cover the chute. Rinse the filter thoroughly and discard the rinse water. Place a glass stir stick in the Chemex, then add 40g of coarsely ground coffee and create a divot.",
        description_template:
          "Prepare the Chemex filter by cutting it into two flaps per side and fold as described. Cut a piece of food-safe silicone to cover the chute. Rinse the filter thoroughly and discard the rinse water. Place a glass stir stick in the Chemex, then add 40g of coarsely ground coffee and create a divot.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Start timer and pour 100g of boiling water into the center, spiraling outward.",
        description_template:
          "Start timer and pour 100g of boiling water into the center, spiraling outward.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "At 30 seconds, pour another 100g of water, then swirl until clumps disappear and gases are released.",
        description_template:
          "At 30 seconds, pour another 100g of water, then swirl until clumps disappear and gases are released.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "One minute later, pour 200g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
        description_template:
          "One minute later, pour 200g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "After another minute, pour 150g of water, maintaining a gentle swirl to avoid over-agitation.",
        description_template:
          "After another minute, pour 150g of water, maintaining a gentle swirl to avoid over-agitation.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "One minute after the previous pour, add the final 100g of water softly, finish with a light swirl and let the brew drain.",
        description_template:
          "One minute after the previous pour, add the final 100g of water softly, finish with a light swirl and let the brew drain.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createFrenchIncrementalExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "fr",
    likely_brewing_method: "Chemex",
    name: "Recette Chemex",
    short_description: null,
    grind_size: "coarse",
    water_temp_celsius: 96,
    coffee_amount_grams: 20,
    water_amount: 200,
    preparation:
      "Rincez le filtre et ajoutez 20 g de café moulu grossièrement.",
    steps: [
      {
        title: null,
        raw_text: "Démarrez le minuteur et versez 100 g d’eau.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createFrenchIncrementalNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "fr",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 200,
      water_temp: 96,
    },
    localization: {
      name: "Recette Chemex",
      grind_size: "coarse",
      short_description: "Recette Chemex en deux versements.",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Rincez le filtre et ajoutez 20 g de café moulu grossièrement.",
        description_template:
          "Rincez le filtre et ajoutez 20 g de café moulu grossièrement.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Démarrez le minuteur et versez 100 g d’eau.",
        description_template: "Démarrez le minuteur et versez 100 g d’eau.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        description_template:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function createFrenchCumulativeRewrite(): CumulativeRewriteResult {
  return {
    warnings: [
      "Later brew steps were rewritten to cumulative water totals in the source language.",
    ],
    steps: [
      {
        kind: "preparation",
        description_source:
          "Rincez le filtre et ajoutez 20 g de café moulu grossièrement.",
        description_template:
          "Rincez le filtre et ajoutez 20 g de café moulu grossièrement.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Démarrez le minuteur et versez 100 g d’eau.",
        description_template:
          "Démarrez le minuteur et versez (0.5 x <final_water_amount>)g d’eau.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        description_template:
          "À 30 secondes, versez jusqu’à (1 x <final_water_amount>)g d’eau puis remuez doucement.",
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

Deno.test("falls back from groq compound-mini extraction failure to groq gpt-oss-20b before openai", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        failExtraction: true,
        calls,
      }),
      createMockProvider({
        name: "groq",
        tag: "groq/openai/gpt-oss-20b",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
      createMockProvider({
        name: "openai",
        tag: "openai/gpt-5.6-terra",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
      createMockProvider({
        name: "gemini",
        tag: "gemini/gemini-3.1-flash-lite",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-1",
  });

  assertEquals(
    result.provider_used,
    "groq",
    "Expected the second Groq model to be the final provider.",
  );
  assertEquals(
    result.provider_model_used,
    "groq/openai/gpt-oss-20b",
    "Expected provider_model_used to identify the exact final model.",
  );
  assertEquals(
    calls,
    [
      // F10: a provider now gets one same-provider retry before the loop
      // falls through — groq/compound-mini's mock fails extraction
      // unconditionally, so both the initial attempt and the retry fail,
      // and only then does the loop advance to groq/openai/gpt-oss-20b,
      // which succeeds on its first attempt.
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/openai/gpt-oss-20b", stage: "extraction" },
      { provider: "groq/openai/gpt-oss-20b", stage: "normalization" },
    ],
    "Expected provider fallback order to match the plan.",
  );
});

Deno.test("reuses extraction and falls back only normalization from groq compound-mini to groq gpt-oss-20b", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        extraction: createExtraction(),
        failNormalization: true,
        calls,
      }),
      createMockProvider({
        name: "groq",
        tag: "groq/openai/gpt-oss-20b",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
      createMockProvider({
        name: "openai",
        tag: "openai/gpt-5.6-terra",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
      createMockProvider({
        name: "gemini",
        tag: "gemini/gemini-3.1-flash-lite",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2",
  });

  // Phase E (Task 3): provider_used/provider_model_used now report the
  // EXTRACTION-stage provider (groq/compound-mini), not whichever provider
  // a later stage happened to fall through to. This is the fix for the
  // "F12 telemetry lie" — production logs showed extraction served by one
  // model while normalization silently fell through to another, with the
  // response attributing everything to the latter. Before Phase E this
  // assertion expected "groq/openai/gpt-oss-20b" (the normalization
  // fallback); that was exactly the misattribution bug.
  assertEquals(
    result.provider_used,
    "groq",
    "Expected provider_used to still name groq (compound-mini is also a groq model).",
  );
  assertEquals(
    result.provider_model_used,
    "groq/compound-mini",
    "Expected provider_model_used to identify the EXTRACTION provider, not the normalization fallback.",
  );
  assertEquals(
    calls,
    [
      // F10: extraction succeeds on the first attempt (no retry needed).
      // normalization's mock fails unconditionally, so it gets its
      // same-provider retry (also failing) before falling through to
      // groq/openai/gpt-oss-20b.
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/compound-mini", stage: "normalization" },
      { provider: "groq/compound-mini", stage: "normalization" },
      { provider: "groq/openai/gpt-oss-20b", stage: "normalization" },
    ],
    "Expected pass 1 to be preserved when pass 2 falls back.",
  );
  assertEquals(
    result.provider_trail,
    [
      {
        stage: "extraction",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 1,
      },
      {
        stage: "normalization",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 2,
      },
      {
        stage: "normalization",
        provider: "groq",
        model: "groq/openai/gpt-oss-20b",
        attempts: 1,
      },
    ],
    "Expected provider_trail to record both the exhausted pinned provider and the fallback that actually served normalization.",
  );
});

Deno.test("Phase E: pins the extraction provider across normalization and cumulative_rewrite when it keeps succeeding", async () => {
  // Task 3: the provider that served extraction must be preferred for
  // every subsequent stage, and only replaced if IT exhausts its retry —
  // not chained forward from whichever provider happened to serve the
  // previous stage. This test proves the pinned provider (groq) is reused
  // for every stage while it keeps succeeding, and the second configured
  // provider (openai) is never called at all.
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        extraction: createFrenchIncrementalExtraction(),
        normalized: createFrenchIncrementalNormalized(),
        cumulativeRewrite: createFrenchCumulativeRewrite(),
        calls,
      }),
      createMockProvider({
        name: "openai",
        tag: "openai/gpt-5.6-terra",
        extraction: createFrenchIncrementalExtraction(),
        normalized: createFrenchIncrementalNormalized(),
        cumulativeRewrite: createFrenchCumulativeRewrite(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Recette Chemex en français",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "chemex", brewing_method: "Chemex" },
    ],
    requestId: "req-pin-success",
  });

  assertEquals(
    result.provider_used,
    "groq",
    "Expected provider_used to name the pinned extraction provider.",
  );
  assertEquals(
    result.provider_model_used,
    "groq/compound-mini",
    "Expected provider_model_used to name the pinned extraction model.",
  );
  assertEquals(
    calls,
    [
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/compound-mini", stage: "normalization" },
      { provider: "groq/compound-mini", stage: "cumulative_rewrite" },
    ],
    "Expected every stage to stay pinned on the extraction provider — openai/gpt-5.6-terra should never be called.",
  );
  assertEquals(
    result.provider_trail,
    [
      {
        stage: "extraction",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 1,
      },
      {
        stage: "normalization",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 1,
      },
      {
        stage: "cumulative_rewrite",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 1,
      },
    ],
    "Expected provider_trail to record exactly one attempt per stage, all on the pinned extraction provider.",
  );
});

Deno.test("Phase E: repair falls through to the next provider only after the pinned extraction provider exhausts its retry, and provider_trail records both", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        extraction: {
          ...createExtraction(),
          name: null,
          grind_size: null,
          short_description: null,
          likely_brewing_method: null,
          water_temp_celsius: null,
          coffee_amount_grams: null,
          water_amount: null,
        },
        normalized: createMissingRequiredNormalized(),
        // No repair fixture and failRepair unset: createMockProvider
        // rejects every repair call from this provider unconditionally,
        // so it exhausts REPAIR_MAX_ATTEMPTS_PER_PROVIDER (2) attempts.
        calls,
      }),
      createMockProvider({
        name: "openai",
        tag: "openai/gpt-5.6-terra",
        extraction: createExtraction(),
        normalized: createMissingRequiredNormalized(),
        repair: createRepairNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-pin-repair-fallback",
  });

  assertEquals(
    result.provider_used,
    "groq",
    "Expected provider_used to still reflect the EXTRACTION-stage provider even though repair fell through to openai.",
  );
  assertEquals(
    result.provider_model_used,
    "groq/compound-mini",
    "Expected provider_model_used to still name the extraction model, not the repair fallback.",
  );
  assertEquals(
    calls,
    [
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/compound-mini", stage: "normalization" },
      { provider: "groq/compound-mini", stage: "repair" },
      { provider: "groq/compound-mini", stage: "repair" },
      { provider: "openai/gpt-5.6-terra", stage: "repair" },
    ],
    "Expected repair to retry the pinned provider twice before falling through to the next provider.",
  );
  assertEquals(
    result.provider_trail,
    [
      {
        stage: "extraction",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 1,
      },
      {
        stage: "normalization",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 1,
      },
      {
        stage: "repair",
        provider: "groq",
        model: "groq/compound-mini",
        attempts: 2,
      },
      {
        stage: "repair",
        provider: "openai",
        model: "openai/gpt-5.6-terra",
        attempts: 1,
      },
    ],
    "Expected provider_trail to record both the exhausted pinned provider and the fallback that actually completed repair.",
  );
  assertEquals(
    result.draft.localization.name,
    "Recovered V60",
    "Expected the repair output from the fallback provider to still be used for the draft.",
  );
});

Deno.test("falls through to openai when both groq models fail", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        failExtraction: true,
        calls,
      }),
      createMockProvider({
        name: "groq",
        tag: "groq/openai/gpt-oss-20b",
        failExtraction: true,
        calls,
      }),
      createMockProvider({
        name: "openai",
        tag: "openai/gpt-5.6-terra",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
      createMockProvider({
        name: "cerebras",
        tag: "cerebras/qwen-3-235b-a22b-instruct-2507",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2b",
  });

  assertEquals(
    result.provider_used,
    "openai",
    "Expected OpenAI after both Groq model failures.",
  );
  assertEquals(
    result.provider_model_used,
    "openai/gpt-5.6-terra",
    "Expected provider_model_used to identify the exact final model.",
  );
  assertEquals(
    calls,
    [
      // F10: both Groq mocks fail extraction unconditionally, so each gets
      // its same-provider retry (also failing) before the loop advances;
      // openai succeeds on its first attempt at both stages.
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/openai/gpt-oss-20b", stage: "extraction" },
      { provider: "groq/openai/gpt-oss-20b", stage: "extraction" },
      { provider: "openai/gpt-5.6-terra", stage: "extraction" },
      { provider: "openai/gpt-5.6-terra", stage: "normalization" },
    ],
    "Expected fallback order groq compound-mini -> groq gpt-oss-20b -> openai mini.",
  );
});

Deno.test("falls through to cerebras when groq models and openai fail", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        failExtraction: true,
        calls,
      }),
      createMockProvider({
        name: "groq",
        tag: "groq/openai/gpt-oss-20b",
        failExtraction: true,
        calls,
      }),
      createMockProvider({
        name: "openai",
        tag: "openai/gpt-5.6-terra",
        failExtraction: true,
        calls,
      }),
      createMockProvider({
        name: "cerebras",
        tag: "cerebras/qwen-3-235b-a22b-instruct-2507",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2c",
  });

  assertEquals(
    result.provider_used,
    "cerebras",
    "Expected Cerebras after Groq and OpenAI failures.",
  );
  assertEquals(
    result.provider_model_used,
    "cerebras/qwen-3-235b-a22b-instruct-2507",
    "Expected provider_model_used to identify the exact final model.",
  );
  assertEquals(
    calls,
    [
      // F10: groq/compound-mini, groq/openai/gpt-oss-20b, and openai all
      // fail extraction unconditionally, so each gets its same-provider
      // retry (also failing) before the loop advances; cerebras succeeds
      // on its first attempt at both stages.
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/openai/gpt-oss-20b", stage: "extraction" },
      { provider: "groq/openai/gpt-oss-20b", stage: "extraction" },
      { provider: "openai/gpt-5.6-terra", stage: "extraction" },
      { provider: "openai/gpt-5.6-terra", stage: "extraction" },
      {
        provider: "cerebras/qwen-3-235b-a22b-instruct-2507",
        stage: "extraction",
      },
      {
        provider: "cerebras/qwen-3-235b-a22b-instruct-2507",
        stage: "normalization",
      },
    ],
    "Expected fallback order groq compound-mini -> groq gpt-oss-20b -> openai mini -> cerebras.",
  );
});

Deno.test("fills missing required fields from extraction before triggering repair", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
        },
        normalized: createMissingRequiredNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2d",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
    ],
    "Expected extraction fallbacks to avoid a repair pass when pass-1 data is sufficient.",
  );
  assertEquals(
    result.draft.localization.name,
    "Recette V60",
    "Expected missing name to be filled from extraction.",
  );
  assertEquals(
    result.draft.localization.grind_size,
    "Medium",
    "Expected missing grind size to be filled from extraction.",
  );
  assertEquals(
    result.draft.localization.short_description,
    "Une tasse douce et propre",
    "Expected missing short description to be filled from extraction.",
  );
  assertEquals(
    result.draft.recipe.brewing_method_id,
    "v60",
    "Expected missing brewing method to be resolved from extraction output.",
  );
});

Deno.test("repairs missing required fields by re-reading the original text", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          name: null,
          grind_size: null,
          short_description: null,
          likely_brewing_method: null,
          water_temp_celsius: null,
          coffee_amount_grams: null,
          water_amount: null,
        },
        normalized: createMissingRequiredNormalized(),
        repair: createRepairNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2e",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
      { provider: "groq", stage: "repair" },
    ],
    "Expected a repair pass when required fields remain unresolved after normalization.",
  );
  assert(
    result.validation.is_publishable,
    "Expected repair pass to make the recipe publishable.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("repaired after re-reading the original text")
    ),
    "Expected repair warning to be surfaced in the response.",
  );
  assertEquals(
    result.draft.localization.name,
    "Recovered V60",
    "Expected repair output to be used for missing required fields.",
  );
});

Deno.test("normalizes Fahrenheit water temperatures to Celsius", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          water_temp_celsius: 205,
        },
        normalized: {
          ...createNormalized(),
          recipe: {
            ...createNormalized().recipe,
            water_temp: 205,
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Use 205F water.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2f",
  });

  assertEquals(
    result.extraction.water_temp_celsius,
    96.1,
    "Expected extracted water temperature to be normalized to Celsius.",
  );
  assert(
    typeof result.extraction.water_temp_celsius === "number",
    "Expected extracted water temperature to remain a numeric JSON value.",
  );
  assertEquals(
    result.draft.recipe.water_temp,
    96.1,
    "Expected draft water temperature to be normalized to Celsius.",
  );
  assert(
    typeof result.draft.recipe.water_temp === "number",
    "Expected draft water temperature to remain a numeric JSON value.",
  );
  assertEquals(
    result.publish_projection?.user_recipe.water_temp,
    96.1,
    "Expected publish projection water temperature to be normalized to Celsius.",
  );
  assert(
    typeof result.publish_projection?.user_recipe.water_temp === "number",
    "Expected publish projection water temperature to remain numeric.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("normalized to Celsius")
    ),
    "Expected Celsius normalization warning to be surfaced in the response.",
  );
});

// Phase E (plan 020 D5). Each test below feeds a WRONG water_temp/warning
// pair shaped exactly like one of the four live captures `019` §4 found
// (see plan 020's task brief table), alongside a water_temp_stated_range
// carrying the LITERAL range those captures actually stated. The point is
// not just "the number is right" — it is that the model's own
// self-contradictory warning is replaced outright, never merged alongside
// the correct one, and the surviving warning is built from the SAME number
// the draft emits so the two can never disagree again.

Deno.test("D5: 195-205°F range (French press shape) resolves deterministically to its midpoint, replacing a self-contradictory 'midpoint' warning", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          // Live capture 37daf1ec: raw water_temp_celsius came back 96.1,
          // which is 205°F (the HIGH endpoint) converted, not a midpoint —
          // even though the accompanying warning already claimed "midpoint".
          water_temp_celsius: 96.1,
          water_temp_stated_range: { low: 195, high: 205, unit: "fahrenheit" },
        },
        normalized: {
          ...createNormalized(),
          warnings: [
            "Water temperature converted from the stated 195-205°F range; midpoint used.",
          ],
          recipe: {
            ...createNormalized().recipe,
            water_temp: 96.1,
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Use water between 195-205°F.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "frenchpress", brewing_method: "French Press" }],
    requestId: "req-d5-195-205",
  });

  // True midpoint of 195-205°F is 200°F = 93.3°C — NOT 96.1°C (that is the
  // HIGH endpoint, 205°F, which is what the model actually emitted while
  // mislabeling it "midpoint") and NOT 90.6°C (the low endpoint).
  assertEquals(
    result.draft.recipe.water_temp,
    93.3,
    "Expected the deterministic midpoint conversion of 195-205°F, not the model's own (wrong) arithmetic.",
  );
  assertEquals(
    result.extraction.water_temp_celsius,
    93.3,
    "Expected extraction.water_temp_celsius to also reflect the deterministic conversion.",
  );
  assert(
    result.warnings.includes(
      "Water temperature was normalized from the stated 195-205°F range to its midpoint, 93.3°C.",
    ),
    "Expected a warning built from the value actually emitted.",
  );
  assert(
    !result.warnings.includes(
      "Water temperature converted from the stated 195-205°F range; midpoint used.",
    ),
    "Expected the model's own self-contradictory warning (right label, wrong number) to be replaced, not kept alongside the correct one.",
  );
});

Deno.test("D5: 201-205°F range (flash-chilled shape) resolves deterministically to its midpoint, correcting a warning that already showed the arithmetic disagreeing with itself", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          // Live capture 2c6f58de: raw water_temp_celsius came back 95.6,
          // with a warning that spelled out BOTH converted endpoints
          // (93.9°C and 96.1°C) and claimed "midpoint used" — but the
          // actual midpoint of 93.9 and 96.1 is 95.0, not 95.6. The
          // warning's own numbers already disprove its own value.
          water_temp_celsius: 95.6,
          water_temp_stated_range: { low: 201, high: 205, unit: "fahrenheit" },
        },
        normalized: {
          ...createNormalized(),
          warnings: [
            "Water temperature range 201-205°F converted to 93.9-96.1°C; midpoint used.",
          ],
          recipe: {
            ...createNormalized().recipe,
            water_temp: 95.6,
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Use water between 201-205°F.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-d5-201-205",
  });

  // Midpoint of 201-205°F is 203°F = 95.0°C exactly; formatTemperatureNumber
  // drops the trailing zero (the existing convention, unchanged by this
  // phase), so both the numeric field and the warning read "95".
  assertEquals(
    result.draft.recipe.water_temp,
    95,
    "Expected the deterministic midpoint conversion of 201-205°F (203°F = 95.0°C), not the model's own 95.6°C.",
  );
  assert(
    result.warnings.includes(
      "Water temperature was normalized from the stated 201-205°F range to its midpoint, 95°C.",
    ),
    "Expected a warning built from the value actually emitted.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("95.6")),
    "Expected the model's wrong 95.6°C claim to be gone entirely.",
  );
});

Deno.test("D5: 205-210°F range (moka pot shape) resolves deterministically to its midpoint, correcting a warning that named the right policy and the wrong number", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          // Live capture ce4ad3b0: raw water_temp_celsius came back 96.1,
          // with a warning explicitly naming 96.1°C "the midpoint of
          // 207.5°F" — but 207.5°F actually converts to 97.5°C. 96.1°C
          // cannot be that midpoint under any policy (it is 205°F, the low
          // endpoint) — the exact self-contradiction plan 020 D5 exists to
          // remove.
          water_temp_celsius: 96.1,
          water_temp_stated_range: { low: 205, high: 210, unit: "fahrenheit" },
        },
        normalized: {
          ...createNormalized(),
          warnings: [
            "Water temperature converted from the stated 205-210°F range using its midpoint (207.5°F).",
          ],
          recipe: {
            ...createNormalized().recipe,
            water_temp: 96.1,
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Use water between 205-210°F.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "moka", brewing_method: "Moka Pot" }],
    requestId: "req-d5-205-210",
  });

  // True midpoint of 205-210°F is 207.5°F = 97.5°C, not 96.1°C (205°F, the
  // low endpoint — what the model actually emitted despite its own label).
  assertEquals(
    result.draft.recipe.water_temp,
    97.5,
    "Expected the deterministic midpoint conversion of 205-210°F (207.5°F = 97.5°C), correcting the model's arithmetic even though its stated policy (midpoint) was already the one this phase settled on.",
  );
  assert(
    result.warnings.includes(
      "Water temperature was normalized from the stated 205-210°F range to its midpoint, 97.5°C.",
    ),
    "Expected a warning built from the value actually emitted.",
  );
  assert(
    !result.warnings.includes(
      "Water temperature converted from the stated 205-210°F range using its midpoint (207.5°F).",
    ),
    "Expected the model's self-contradictory warning (96.1°C claimed as the midpoint of 207.5°F) to be gone entirely, not left alongside the correct 97.5°C warning.",
  );
});

Deno.test("D5: a stated Celsius range also resolves to its midpoint (policy is unit-agnostic)", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          water_temp_celsius: 92,
          water_temp_stated_range: { low: 92, high: 96, unit: "celsius" },
        },
        normalized: {
          ...createNormalized(),
          warnings: [],
          recipe: {
            ...createNormalized().recipe,
            water_temp: 92,
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Use water between 92-96°C.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-d5-92-96c",
  });

  // Midpoint of 92-96°C is 94°C. Note this is a deliberate DEPARTURE from
  // plan 015's incidental (never enforced in code) 92-96°C -> 92°C
  // behaviour — this phase's low-endpoint draft used that low-endpoint
  // precedent as its rationale, but the policy actually chosen (see
  // resolveWaterTempStatedRange's comment) is midpoint, matching
  // total_brew_time_seconds's already-established rule for a stated target
  // band instead.
  assertEquals(
    result.draft.recipe.water_temp,
    94,
    "Expected the midpoint of a Celsius-stated range.",
  );
  assert(
    result.warnings.includes(
      "Water temperature was normalized from the stated 92-96°C range to its midpoint, 94°C.",
    ),
    "Expected a warning built from the value actually emitted.",
  );
});

Deno.test("D5: without a structured water_temp_stated_range, an unverifiable range-conversion warning is stripped rather than trusted, and the emitted value is left alone", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          water_temp_celsius: 96.1,
          // No water_temp_stated_range — this is every capture recorded
          // before this phase, and any provider response that predates
          // the field.
        },
        normalized: {
          ...createNormalized(),
          warnings: [
            "Water temperature converted from the stated 195-205°F range; midpoint used.",
          ],
          recipe: {
            ...createNormalized().recipe,
            water_temp: 96.1,
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Use water between 195-205°F.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "frenchpress", brewing_method: "French Press" }],
    requestId: "req-d5-fallback",
  });

  // No structured range to verify against, so the value is left exactly as
  // the model produced it (96.1, not <= 120 so the >120 heuristic never
  // fires either) — this phase does not claim to fix the NUMBER without
  // live evidence that the model reliably fills the new field. Only the
  // untrustworthy WARNING is removed.
  assertEquals(
    result.draft.recipe.water_temp,
    96.1,
    "Expected the value to pass through unchanged in the fallback (no structured range) path.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("midpoint")),
    "Expected the model's unverifiable range-conversion claim to be stripped even without a structured range to correct it against — an open question beats a confidently wrong explanation.",
  );
});

Deno.test("normalizes temperature mentions inside step descriptions to Celsius", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          water_temp_celsius: 96.1,
        },
        normalized: createTemperatureMentionNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Heat water to 205F and rinse the filter.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2g",
  });

  assertEquals(
    result.draft.steps[0].description_source,
    "Heat water to 205F and rinse the filter.",
    "Expected description_source to preserve the original source phrasing.",
  );
  assertEquals(
    result.draft.steps[0].description_template,
    "Heat water to 96.1C and rinse the filter.",
    "Expected step description_template temperatures to be normalized to Celsius.",
  );
  assertEquals(
    result.publish_projection?.user_steps[0].description,
    "Heat water to 96.1C and rinse the filter.",
    "Expected published step descriptions to keep normalized Celsius mentions.",
  );
});

Deno.test("falls back to source text when the model emits malformed scalable expressions", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createMalformedExpressionNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Pour 50g water for bloom.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2h",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
    ],
    "Expected malformed scalable expressions to recover deterministically from description_source.",
  );
  assertEquals(
    result.draft.steps[1].description_template,
    "Pour (0.2 x <final_water_amount>)g water for bloom.",
    "Expected malformed scalable expressions to fall back to a correct numeric expression derived from description_source.",
  );
  assertEquals(
    result.draft.steps[1].preview_text,
    "Pour 50g water for bloom.",
    "Expected preview text to resolve to a concrete numeric amount.",
  );
  assert(
    !result.draft.steps[1].description_template.includes("(N x"),
    "Expected malformed N-based expressions to be removed from the returned draft.",
  );
  assert(
    result.validation.is_publishable,
    "Expected malformed scalable expressions to be recoverable without blocking publishability.",
  );
});

Deno.test("normalizes nested expression-like water math before rendering preview text", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createNestedExpressionMathExtraction(),
        normalized: createNestedExpressionMathNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock Chemex recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2ha",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
    ],
    "Expected nested expression-like math to be cleaned deterministically without a repair pass.",
  );
  assertEquals(
    result.draft.steps[1].description_template,
    "Start the timer and begin the first pour, adding about (0.2 x <final_water_amount>)g of water.",
    "Expected nested placeholder math to collapse into a single valid water expression.",
  );
  assertEquals(
    result.draft.steps[1].preview_text,
    "Start the timer and begin the first pour, adding about 140g of water.",
    "Expected preview text to render the cleaned expression as a concrete amount.",
  );
  assert(
    !result.draft.steps[1].description_template.includes(
      "(1 x <final_water_amount>)",
    ),
    "Expected nested placeholder expressions to be removed from the stored template.",
  );
  assert(
    !result.draft.steps[1].preview_text.includes("(0.2 x"),
    "Expected preview text not to leak unresolved expression syntax.",
  );
});

Deno.test("normalizes brew-step durations below 10 seconds and keeps brew time equal to the step sum", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createTooShortBrewDurationsNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Quick V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2hb",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 10, 10],
    "Expected all non-preparation steps to be normalized to at least 10 seconds.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    20,
    "Expected draft brew time to equal the sum of brew-step durations.",
  );
  assertEquals(
    result.publish_projection?.user_recipe.brew_time,
    20,
    "Expected published brew time to match the normalized brew-step duration sum.",
  );
  assertEquals(
    result.publish_projection?.user_steps.reduce(
      (sum, step) => sum + Number(step.time),
      0,
    ),
    20,
    "Expected publish projection step times to sum to the stored brew time.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("normalized to 10 seconds")
    ),
    "Expected duration normalization to be surfaced as a warning.",
  );
});

Deno.test("D7: a stated sub-minimum brew step absorbs the shortfall from the following step, conserving the total", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createStatedSubMinimumAbsorbableNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Quick V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d7-absorb",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 10, 10, 15],
    "Expected the 5s stir to be bumped to 10s and the following 20s step " +
      "to be shortened to 15s to pay for it, rather than the total growing.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    35,
    "Expected the brew total to equal the ORIGINAL stated total " +
      "(10 + 5 + 20 = 35), conserved rather than inflated by the minimum.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("shortening the following step by the same amount")
    ),
    "Expected the absorption to be surfaced as its own warning.",
  );
});

Deno.test("D7 fallback: a stated sub-minimum step whose only neighbour can't afford the delta bumps without absorbing", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createStatedSubMinimumUnabsorbableNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Quick V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d7-fallback",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 10, 10, 15],
    "Expected the 4s stir to be bumped to 10s and the following 15s step " +
      "to be left untouched, because paying 6s would drop it to 9s — " +
      "below the minimum itself.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    35,
    "Fallback is not conservative by design: 10 + 10 + 15 = 35, 6s more " +
      "than the original stated 10 + 4 + 15 = 29 — no worse than pre-D7.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("normalized to 10 seconds")
    ) &&
      !result.warnings.some((warning) =>
        warning.includes("shortening the following step")
      ),
    "Expected the plain (non-absorbing) minimum-duration warning, not the " +
      "absorption warning.",
  );
});

Deno.test("D7 fallback: a stated sub-minimum step that is last in the recipe has no neighbour to absorb from", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createStatedSubMinimumLastStepNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Quick V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d7-last-step",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 20, 10],
    "Expected the last step's 3s swirl to be bumped to 10s with no " +
      "attempt to absorb — there is no following step to pay for it.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    30,
    "20 + 10 = 30 seconds; the pre-existing (non-conservative) fallback " +
      "behavior, unchanged by this phase.",
  );
});

Deno.test("D7 (elapsed-timestamp path): an AeroPress-shaped stir absorbs from the following pour, keeping later landmarks aligned", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createTimestampedStatedSubMinimumNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Quick AeroPress recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "aeropress", brewing_method: "AeroPress" },
    ],
    requestId: "req-d7-timestamped",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 10, 10, 25, 10],
    "Expected the 5s (10->15) stir to bump to 10s absorbed from the " +
      "following 30s (15->45) pour, which becomes 25s.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    55,
    "10 + 10 + 25 + 10 = 55, exactly the natural (pre-enforcement) total " +
      "10 + 5 + 30 + 10 — nothing invented.",
  );
  assert(
    !result.warnings.some((warning) =>
      warning.includes("should begin at 45s elapsed")
    ),
    "Expected the final step's elapsed landmark (45s, preceded by " +
      "10+10+25=45) to land exactly on the source-stated timestamp instead " +
      "of being enumerated as shifted.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes(
        "A brew step's source-stated duration was below 10 seconds; it was normalized to 10 seconds by shortening the following step",
      )
    ),
    "Expected the elapsed-timestamp absorption to be surfaced as its own warning.",
  );
});

Deno.test("normalizes timestamped Tetsu 4:6 steps and repairs nested coffee expressions", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createTetsuTimestampExtraction(),
        normalized: createTetsuTimestampNormalized(),
        calls: [],
      }),
    ],
    now: () => 1777807054301,
  });

  const result = await parser.parseDraft({
    text:
      "Tetsu Kasuya 4:6 V60\n\n20g coffee, 300g water, 93C\nMedium-coarse grind\nRinse the filter and preheat the brewer. Add coffee and level the bed.\n\n0:00 pour 50g\n0:45 pour to 120g\n1:30 pour to 180g\n2:15 pour to 240g\n3:00 pour to 300g\nLet draw down fully and serve.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2hc",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 45, 45, 45, 10, 30],
    "Expected absolute timestamps to be converted to per-step durations.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    220,
    "Expected Tetsu brew time to equal the normalized step-duration sum.",
  );
  assertEquals(
    result.publish_projection?.user_recipe.brew_time,
    220,
    "Expected publish projection brew time to use normalized durations.",
  );
  assertEquals(
    result.draft.steps[0].description_template,
    "Rinse the filter and preheat the brewer. Add (1 x <final_coffee_amount>)g coffee and level the bed.",
    "Expected nested coffee expression-like math to collapse to one expression.",
  );
  assert(
    !result.draft.steps[0].description_template.includes("(1 x (1 x"),
    "Expected nested expression syntax not to leak into draft output.",
  );
  assertEquals(
    result.draft.steps.slice(1, 6).map((step) =>
      step.expressions.find((expression) =>
        expression.placeholder === "<final_water_amount>"
      )?.preview_value
    ),
    [50, 120, 180, 240, 300],
    "Expected timestamped pour-to steps to remain cumulative water totals.",
  );
  assertEquals(
    result.publish_projection?.user_steps.map((step) => step.time),
    ["0", "45", "45", "45", "45", "10", "30"],
    "Expected published step times to match normalized durations.",
  );
});

Deno.test("normalizes timestamped pour sequence without trailing drawdown", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createTetsuTimestampExtraction(),
          steps: createTetsuTimestampExtraction().steps.slice(0, 5),
        },
        normalized: createTimestampWithoutDrawdownNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "0:00 pour 50g\n0:45 pour to 120g\n1:30 pour to 180g\n2:15 pour to 240g\n3:00 pour to 300g",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2hd",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 45, 45, 45, 10],
    "Expected final timestamped step to receive the terminal pour fallback.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    190,
    "Expected brew time to include the terminal pour fallback.",
  );
});

Deno.test("normalizes natural-language elapsed times and infers Chemex drawdown", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createChemexNaturalElapsedExtraction(),
        normalized: createChemexNaturalElapsedNormalized(),
        calls: [],
      }),
    ],
    now: () => 1777808888503,
  });

  const result = await parser.parseDraft({
    text:
      "Start your timer and begin your first pour. Target adding around 100 grams of water. Now start the second pour at 45 seconds and bring the water weight up to 300 grams. At a minute and 50 seconds, start your third pour, bringing the water weight up to 500 grams. Begin the fourth and final pour at 3 minutes and 10 seconds and bring the water weight up to 700 grams. Typically a chemex will finish brewing in around four minutes. Once the water finishes dripping through the filter, discard the filter and enjoy.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2he",
  });

  // defect-1: the fourth pour (elapsed 190s) is the LAST timestamped step,
  // so its duration was never actually known from the source — only its
  // start time was (see isAnchoredBrewStep). Before the fix it was locked
  // to a nominal 10s guess regardless of how much water it poured; now it
  // is correctly treated as DERIVED and estimated from the 200g it itself
  // adds (500 -> 700g) at the same ~8 g/s pour-rate model used for every
  // other derived pour in this codebase (200 / 8 = 25s), and the
  // synthetic "Wait for the complete drawdown" step absorbs the rest of
  // the resolved 240s target (240 - 45 - 65 - 80 - 25 = 25) instead of a
  // flat 40s. Both numbers change; the total (240) does not.
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 65, 80, 25, 25],
    "Expected prose elapsed times and finish target to become step durations.",
  );
  assertEquals(
    result.draft.steps.at(-1)?.description_template,
    "Wait for the complete drawdown.",
    "Expected a drawdown step to be synthesized from the finish target.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    240,
    "Expected Chemex brew time to include inferred drawdown.",
  );
  assertEquals(
    result.publish_projection?.user_recipe.brew_time,
    240,
    "Expected publish projection brew time to include inferred drawdown.",
  );
  assertEquals(
    result.publish_projection?.user_steps.map((step) => step.time),
    ["0", "45", "65", "80", "25", "25"],
    "Expected published step times to match normalized natural elapsed durations.",
  );
  assertEquals(
    result.draft.steps[0].description_template.includes("heat water to 96.1C"),
    true,
    "Expected bare temperature numbers in preparation text to include Celsius.",
  );
  assertEquals(
    result.draft.steps[3].description_template.startsWith("Pour up to"),
    true,
    "Expected final text polish to capitalize step starts.",
  );
  assertEquals(
    result.draft.steps[1].expressions[0].unit,
    "g",
    "Expected punctuation after expression units not to become part of the unit.",
  );
});

// F2 regression test: simplifyVerboseChemexPreparation and
// simplifyVerboseBrewTemplate (and their simplifyVerboseStepTemplate
// dispatcher) used to fire on ANY step containing a trigger phrase (e.g.
// "6 cup chemex"+"trifold"+"level coffee bed", or "final pour") plus a
// water/coffee expression, and replace the ENTIRE step with one of five
// canned sentences — discarding real detail (temperature, pour pattern,
// technique) that happened to sit in the same step. This test's fixture is
// the exact transcript those canned rules were tuned on; it now asserts
// the opposite of what the deleted functions used to produce: every
// distinguishing word from the source survives verbatim, and the discarded
// canned sentences ("Prepare a 6 cup Chemex with a Chemex filter...",
// "Pour up to X with a consistent pour pattern.", etc.) never appear.
Deno.test("does not replace verbose Chemex steps with canned sentences after removing the overfit simplifiers", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createChemexNaturalElapsedExtraction(),
        normalized: createVerboseChemexNaturalElapsedNormalized(),
        calls: [],
      }),
    ],
    now: () => 1777811146363,
  });

  const result = await parser.parseDraft({
    text:
      "Start your timer and begin your first pour. Target adding around 100 grams of water. Now start the second pour at 45 seconds and bring the water weight up to 300 grams. At a minute and 50 seconds, start your third pour, bringing the water weight up to 500 grams. Begin the fourth and final pour at 3 minutes and 10 seconds and bring the water weight up to 700 grams. Typically a chemex will finish brewing in around four minutes.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2hf",
  });

  const templates = result.draft.steps.map((step) => step.description_template);

  assert(
    !templates.some((template) =>
      /Prepare a 6 cup Chemex with a Chemex filter|spiraling from the center out and back\.|using the same spiral pattern, avoiding the filter, and let it drain almost completely\.|using the same pouring pattern, then pause and let it drain\.|with a consistent pour pattern\.$/
        .test(template)
    ),
    "Expected the deleted canned-rewrite sentences to never appear in the output.",
  );
  assert(
    templates.some((template) => template.includes("known as the Bloom pour")),
    "Expected the first pour step's real technique detail to survive verbatim.",
  );
  assert(
    templates.some((template) => /between 96\.1 and 96\.1C/.test(template)),
    "Expected the preparation step's real temperature detail to survive verbatim.",
  );
  assert(
    templates.some((template) =>
      /unlike some other brewers, avoid pouring directly on the filter/i.test(
        template,
      )
    ),
    "Expected the second pour step's real technique detail to survive verbatim.",
  );
  assert(
    templates.some((template) =>
      /still focusing on a consistent pour pattern/i.test(template)
    ),
    "Expected the final pour step's real wording to survive instead of being replaced by the canned 'with a consistent pour pattern.' sentence.",
  );
});

Deno.test("infers vague Chemex pour and drawdown durations from stated total brew time", async () => {
  // F7 / Phase B2 regression test: this transcript used to make
  // normalization dump the entire timing deficit on the last (drawdown)
  // step — a real production recipe produced a 150s "stir gently, then
  // swirl and let it draw down" step this way. total_brew_time_seconds
  // (270 = midpoint of the recipe's own "four to five minute" statement)
  // comes from extraction directly. Neither the vague pour nor the
  // drawdown step states its own duration, so both are DERIVED and get
  // split by the deterministic seconds-based model instead of by whatever
  // duration the model happened to guess. The stated bloom ("60 to 90
  // grams... bloom for at least 45 seconds") is ANCHORED and untouched;
  // its lower-bound water expression (60g) still seeds the running water
  // total, so the pour's own wording ("reach 500g total water", the
  // recipe's exact final amount) is read as adding 500 - 60 = 440g, which
  // at the ~8 g/s pour-rate estimate is ~55s. The drawdown step has no
  // water or duration signal of its own, so it gets whatever is left over
  // (170s) rather than competing for a proportional share — a real Chemex
  // drawdown taking several times longer than its pour is the physically
  // correct shape, not a regression. 45 (anchored bloom) + 55 (estimated
  // pour) + 170 (drawdown remainder) = 270, landing exactly on target.
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createChemexCoffeeMakerExtraction(),
        normalized: createChemexCoffeeMakerNormalized(),
        calls: [],
      }),
    ],
    now: () => 1777815384071,
  });

  const result = await parser.parseDraft({
    text:
      "We're gonna keep our dose at 60 grams per liter. You don't have to grind much coarser for the Chemex to get that three, three and a half minute brew time. You're gonna have four to five minute brew times brewing half a liter with the Chemex and you're gonna have great tasting coffee. In terms of the bloom, do exactly as the V60: 2 to 1 to 3 to 1 in terms of bloom water to coffee dose, so 60 grams of bloom to 90 grams of bloom if you're brewing 30 grams of coffee, and let that bloom for at least 45 seconds. I would say a similar pouring technique in terms of phases to the V60 video. At the end, do the same thing with a little stir and then a swirl to help the drawdown and have a flat bed.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2hm",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 55, 170],
    "Expected the derived pour to be estimated from the water it adds and the derived drawdown to absorb the remainder, instead of dumping the deficit arbitrarily.",
  );
  // The regression guard for this whole class of bug: a Chemex (or V60)
  // drawdown is physically the long tail of the brew, not a quick action —
  // it must come out longer than the pour that precedes it, never shorter.
  assert(
    result.draft.steps[3].duration_seconds >
      result.draft.steps[2].duration_seconds,
    "Expected the drawdown step to take longer than the pour step, not shorter.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    270,
    "Expected brew time to land exactly on the stated 270s target.",
  );
  assertEquals(
    result.publish_projection?.user_steps.map((step) => step.time),
    ["0", "45", "55", "170"],
    "Expected publish projection step times to match the deterministic split.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes(
        "split deterministically from the stated total brew time",
      )
    ),
    "Expected the deterministic split to be surfaced as a warning.",
  );
});

Deno.test("prefers a step's elapsed_seconds over regex text parsing when they disagree", async () => {
  // Phase B: elapsed_seconds is reported explicitly by the extraction/
  // normalization stages now, and must win over parseStepElapsedTimestampSeconds
  // scanning the step's own text. Step 2 below states "about 45 seconds" in
  // its own text (which the regex fallback would read as elapsed 45s), but
  // elapsed_seconds explicitly says 90 — the recomputed durations must
  // reflect 90, not 45.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Elapsed Preference V60",
    short_description: "Tests elapsed_seconds precedence over text parsing",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 300,
    preparation: "Rinse the filter and add the coffee.",
    steps: [
      {
        title: null,
        raw_text: "Start the timer and pour to 100g.",
        duration_seconds: null,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Pour to 200g and wait about 45 seconds before the next pour.",
        duration_seconds: null,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour to 300g to finish.",
        duration_seconds: null,
        elapsed_seconds: 150,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Elapsed Preference V60",
      grind_size: "Medium",
      short_description: "Tests elapsed_seconds precedence over text parsing",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add the coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Start the timer and pour to 100g.",
        description_template: "Start the timer and pour to 100g.",
        duration_seconds: 10,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Pour to 200g and wait about 45 seconds before the next pour.",
        description_template:
          "Pour to 200g and wait about 45 seconds before the next pour.",
        duration_seconds: 20,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour to 300g to finish.",
        description_template: "Pour to 300g to finish.",
        duration_seconds: 20,
        elapsed_seconds: 150,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-elapsed-pref",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 90, 60, 10],
    "Expected durations to be recomputed from elapsed_seconds (0, 90, 150), not from the '45 seconds' text on step 2.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    160,
    "Expected total brew time to follow the elapsed_seconds-derived durations.",
  );
});

Deno.test("resolves the total brew time target from extraction and narrowed step text, ignoring commentary outside it", async () => {
  // Phase B / F-regex-scope: total_brew_time_seconds and its regex fallback
  // must only ever see extraction.preparation + step raw_text, never the
  // full raw transcript. The raw `text` below contains a sentence with a
  // "done"-triggering keyword and a much larger number (ten minutes) that
  // the OLD full-text-scanning regexes would have picked up — it must be
  // ignored because it isn't part of the extraction. The 200-second target
  // stated inside a step's own raw_text must still be used.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Narrowed Target V60",
    short_description:
      "Tests the regex fallback stays scoped to extraction text",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 150,
    preparation: "Rinse the filter and add the coffee.",
    steps: [
      {
        title: null,
        raw_text:
          "Continue pouring in phases until you reach 150g total water.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Finish the brew, total brew time about 200 seconds.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    // Simulates a provider that omitted this optional field — the schema
    // default (null) must not fail the stage, and the deterministic layer
    // must fall back to the narrowed-text regex below.
    total_brew_time_seconds: null,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 150,
      water_temp: 93,
    },
    localization: {
      name: "Narrowed Target V60",
      grind_size: "Medium",
      short_description:
        "Tests the regex fallback stays scoped to extraction text",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add the coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Continue pouring in phases until you reach 150g total water.",
        description_template:
          "Continue pouring in phases until you reach 150g total water.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Finish the brew, total brew time about 200 seconds.",
        description_template: "Finish the brew.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Continue pouring in phases until you reach 150g total water. Finish the brew, total brew time about 200 seconds. Someone in the comments joked that this brew is done in ten minutes if you're slow.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-narrowed-target",
  });

  // Phase B2: both brew steps are DERIVED (neither states its own
  // duration), so the 200s target is split deterministically rather than
  // dumped onto the vague pour. Neither step reads as a drawdown by
  // wording, so the LAST derived step ("Finish the brew.") is treated as
  // the drawdown and absorbs whatever time is left over — physically
  // reasonable, since a generic "finish the brew" beat is exactly the kind
  // of open-ended tail (drawdown/dripping-out) that has no fixed length of
  // its own. That leaves "Continue pouring... 150g total water" as the
  // recipe's only other (and therefore first) water-adding step, so it
  // gets the fixed 45s bloom-equivalent pause rather than a water-rate
  // estimate — a byproduct of this being a single-pour-then-finish recipe
  // with no separate bloom step, not a flaw in the split itself. 45 + 155
  // = 200, landing exactly on the resolved target.
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 155],
    "Expected the 200s target to be split deterministically between the two derived steps, unaffected by the 'ten minutes' commentary outside the extraction.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    200,
    "Expected brew time to equal the 200s target actually present in the extraction, not the 600s the raw commentary would have produced under the old full-text scan.",
  );
});

Deno.test("distributes a brew-time deficit deterministically instead of dumping it on the last eligible step", async () => {
  // F7 / Phase B2: the bloom step states its own duration ("Bloom with 30g
  // water for 30 seconds.") and is ANCHORED, so it survives untouched —
  // and because it states a water amount, it also correctly claims the
  // recipe's "first water-adding step" role, so the pour that follows is
  // read as a genuine pour rather than mistaken for a second bloom.
  // Neither pour step states its own duration, so both are DERIVED and now
  // get split by the deterministic seconds-based model rather than by
  // whatever duration the model happened to guess (previously this test
  // asserted a split proportional to the *model's own guessed durations*,
  // which is exactly the non-determinism Phase B2 removes). "Continue
  // pouring... 150g total water" adds 150 - 30 = 120g on top of the bloom,
  // which at the ~8 g/s pour-rate estimate is 15s. Neither pour reads as a
  // drawdown by wording, so "Pour up to 200g total, then let the coffee
  // finish" — the last derived step — is treated as the drawdown and
  // absorbs whatever time is left over (165s), matching how a brew
  // actually finishes: the last stretch is dictated by how long the bed
  // takes to drain, not by how many grams were in the final pour.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Proportional Deficit V60",
    short_description: "Tests proportional deficit distribution",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 200,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with 30g water for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        // Explicitly stated in raw_text, so this step is ANCHORED and must
        // survive the deterministic split untouched.
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Continue pouring in phases until you reach 150g total water.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour up to 200g total, then let the coffee finish.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 210,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 200,
      water_temp: 93,
    },
    localization: {
      name: "Proportional Deficit V60",
      grind_size: "Medium",
      short_description: "Tests proportional deficit distribution",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom with 30g water for 30 seconds.",
        description_template:
          "Bloom with (0.15 x <final_water_amount>)g water for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Continue pouring in phases until you reach 150g total water.",
        description_template:
          "Continue pouring in phases until you reach 150g total water.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Pour up to 200g total, then let the coffee finish.",
        description_template:
          "Pour up to 200g total, then let the coffee finish.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-proportional",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 30, 15, 165],
    "Expected the anchored bloom to survive untouched, the pour to be estimated from the water it adds, and the drawdown to absorb the remainder — not the model's own guessed 10s/20s durations.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    210,
    "Expected brew time to equal the stated total brew time target.",
  );
});

Deno.test("caps inferred brew step durations at 300 seconds but leaves an explicit 18-hour cold brew steep untouched", async () => {
  // F7 cap: only durations this function itself infers may be clamped. An
  // explicit 64800s (18 hour) steep the source stated outright must survive
  // untouched even though it's a huge number, while the vague "swirl and
  // serve" step (which would need ~1800s to hit the stated target) must be
  // capped at 300s instead of being inflated to 1800s.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Cold Brew",
    name: "Overnight Cold Brew",
    short_description: "Tests the inferred-duration cap",
    grind_size: "Coarse",
    water_temp_celsius: 20,
    coffee_amount_grams: 50,
    water_amount: 800,
    preparation: "Combine coarse coffee and cold water in the steeping vessel.",
    steps: [
      {
        title: null,
        raw_text:
          "Add coarse coffee and water, then stir to saturate all the grounds, and steep for 18 hours.",
        duration_seconds: 64800,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Swirl gently, then strain and serve.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 66600,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "medium",
      coffee_amount: 50,
      water_amount: 800,
      water_temp: 20,
    },
    localization: {
      name: "Overnight Cold Brew",
      grind_size: "Coarse",
      short_description: "Tests the inferred-duration cap",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Combine coarse coffee and cold water in the steeping vessel.",
        description_template:
          "Combine coarse coffee and cold water in the steeping vessel.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Add coarse coffee and water, then stir to saturate all the grounds, and steep for 18 hours.",
        description_template:
          "Add coarse coffee and water, then stir to saturate all the grounds, and steep for 18 hours.",
        duration_seconds: 64800,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Swirl gently, then strain and serve.",
        description_template: "Swirl gently, then strain and serve.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-cap",
  });

  assertEquals(
    result.draft.steps[1].duration_seconds,
    64800,
    "Expected the explicit 18-hour steep to survive untouched by the cap.",
  );
  assertEquals(
    result.draft.steps[2].duration_seconds,
    300,
    "Expected the inferred 'swirl and serve' step to be clamped to the 300s cap instead of inflating to ~1800s.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    65100,
    "Expected total brew time to be the explicit steep plus the capped inferred step.",
  );
});

// F8 / plan 010 §3: a Hario Switch recipe fills the dripper and adds coffee
// BEFORE starting the timer, so the `starts_timer` brew step lands at
// index > 1 and foldPreTimerStepsIntoPreparation fires. Shared by the
// extract-mode fold test below and the verify-mode step-count-preservation
// tests, so both modes exercise the exact same source shape.
function createHarioSwitchPreTimerExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Hario Switch",
    name: "Hario Switch",
    short_description: "Tests folding pre-timer actions into preparation",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 18,
    water_amount: 250,
    preparation: "Place the dripper on the Switch in closed position.",
    steps: [
      {
        title: null,
        raw_text: "Fill the dripper with water.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Add coffee and stir to saturate the grounds.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Wait for the grounds to settle.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Start the timer, open the switch, and stir gently until 0:40.",
        duration_seconds: 40,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Then add water, close the switch, and let steep until 1:25.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createHarioSwitchPreTimerNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "medium",
      coffee_amount: 18,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Hario Switch",
      grind_size: "Medium",
      short_description: "Tests folding pre-timer actions into preparation",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Place the dripper on the Switch in closed position.",
        description_template:
          "Place the dripper on the Switch in closed position.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Fill the dripper with water.",
        description_template: "Fill the dripper with 200g water.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Add coffee and stir to saturate the grounds.",
        description_template:
          "Add 18g coffee and stir to saturate the grounds.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Wait for the grounds to settle.",
        description_template: "Wait 10 seconds for the grounds to settle.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Start the timer, open the switch, and stir gently until 0:40.",
        description_template:
          "Start the timer, open the switch, and stir gently until 0:40.",
        duration_seconds: 40,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Then add water, close the switch, and let steep until 1:25.",
        description_template:
          "Then add 50g water, close the switch, and let steep until 1:25.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

Deno.test("folds pre-timer actions into preparation for a Hario-Switch-shaped recipe and keeps the water running total correct", async () => {
  // F8: a Hario Switch recipe fills the dripper and adds coffee BEFORE
  // starting the timer. Those actions must fold into the untimed
  // preparation step (steps[0]) instead of becoming timed brew steps, the
  // post-fold total brew time must match the source's own "1:25", and the
  // water poured during the folded preparation step must still count
  // towards the running water total for later cumulative pours.
  const extraction = createHarioSwitchPreTimerExtraction();
  const normalized = createHarioSwitchPreTimerNormalized();
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-fold",
  });

  assertEquals(
    result.draft.steps.length,
    3,
    "Expected the 3 pre-timer actions to fold into a single preparation step.",
  );
  assertEquals(
    result.draft.steps[0].description_template,
    "Place the dripper on the Switch in closed position. Fill the dripper with (0.8 x <final_water_amount>)g water. Add (1 x <final_coffee_amount>)g coffee and stir to saturate the grounds. Wait 10 seconds for the grounds to settle.",
    "Expected the pre-timer actions' text to be appended onto the preparation step.",
  );
  assertEquals(
    result.draft.steps[0].duration_seconds,
    0,
    "Expected the merged preparation step to keep duration 0 (the pre-timer actions' time must not be counted).",
  );
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 40, 45],
    "Expected correct post-fold elapsed timings: 40s to start the switch, then 45s more to 1:25.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    85,
    "Expected total brew time to match the source's own '1:25' (85s), not include the folded pre-timer actions.",
  );
  assertEquals(
    result.draft.steps[2].description_template,
    "Then pour up to (1 x <final_water_amount>)g water, close the switch, and let steep until 1:25.",
    "Expected the post-fold pour to resolve as a cumulative 250g total, proving the running water total was seeded from the folded preparation step's 200g rather than starting from 0.",
  );
});

// Plan 016 §4 Phase 4 (D2): the Hario-Switch-shaped fold above collapses
// pre-timer steps 1..3 into step 0 and renumbers the rest. extracted_amounts
// records still carry the PRE-fold step_index the LLM stages assigned
// (before this deterministic pass ever ran), so an amount recorded on
// pre-fold step 2 ("Add coffee...") lands, unremapped, 2 steps away from
// where it is actually rendered (post-fold step 0) — tripping
// provenance.ts's >1-step block even though the draft is correct. Three
// real Hario full-transcript captures were blocked by exactly this shape.
// This fixture reuses createHarioSwitchPreTimerExtraction/Normalized (same
// fold: startsTimerIndex 4, steps 1-3 fold into 0, steps 4-5 shift to 1-2)
// with extracted_amounts added for every amount the fold test above already
// proved gets rendered: 200g (pre-fold step 1, folds to 0), 18g (pre-fold
// step 2, folds to 0 — the 2-step-drift case), and 250g (pre-fold step 5,
// shifts to 2).
Deno.test("D2 (plan 016 §4 Phase 4): a pre-timer amount record folded 2 steps away from its extraction-time index is remapped, not falsely blocked (Hario Switch shape)", async () => {
  const extractedAmounts = [
    {
      value: 200,
      unit: "g",
      step_index: 1,
      provenance: "literal" as const,
      source_quote: "200 grams of water",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
    {
      value: 18,
      unit: "g",
      step_index: 2,
      provenance: "literal" as const,
      source_quote: "18 grams of coffee",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
    {
      value: 250,
      unit: "g",
      step_index: 5,
      provenance: "literal" as const,
      source_quote: "250 grams total",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];

  const extraction = {
    ...createHarioSwitchPreTimerExtraction(),
    extracted_amounts: extractedAmounts,
  };
  const normalized = {
    ...createHarioSwitchPreTimerNormalized(),
    extracted_amounts: extractedAmounts,
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Fill the dripper with 200 grams of water. Add 18 grams of coffee. " +
      "Pour up to 250 grams total water.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
      { brewing_method_id: "switch", brewing_method: "Hario Switch" },
    ],
    requestId: "req-fold-remap",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "amount_step_binding_mismatch"
    ),
    `Expected the fold remap to close the step-index drift; got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected the Hario-Switch-shaped draft to be publishable once the fold remap closes the false step-drift block.",
  );
});

// Mirror of the test above: verify mode skips the fold entirely
// (preserveStepCount), so the remap must be an identity there too — a
// record's pre-fold step_index is also its post-fold step_index, and this
// must stay unblocked for the same reason (drift 0, not drift 2).
Deno.test("D2 (plan 016 §4 Phase 4): the fold remap is inert in verify mode, where no fold ever runs", async () => {
  const extractedAmounts = [
    {
      value: 18,
      unit: "g",
      step_index: 2,
      provenance: "literal" as const,
      source_quote: "18 grams of coffee",
      rule: null,
      rule_source_quote: null,
      rule_inputs: null,
    },
  ];

  const extraction = {
    ...createHarioSwitchPreTimerExtraction(),
    extracted_amounts: extractedAmounts,
  };
  const normalized = {
    ...createHarioSwitchPreTimerNormalized(),
    extracted_amounts: extractedAmounts,
    // Verify mode's normalization stage receives (and must echo back) the
    // submitted step descriptions verbatim; reuse the same six-step shape
    // the extraction fixture already declares so preserveStepCount has
    // nothing to reject.
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Add 18 grams of coffee.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-fold-remap-verify",
    mode: "verify",
  });

  assertEquals(
    result.draft.steps.length,
    normalized.steps.length,
    "Expected verify mode to preserve the submitted step count instead of folding.",
  );
  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "amount_step_binding_mismatch"
    ),
    `Expected no step-drift finding in verify mode, where the record's step_index already equals its rendered step_index (no fold ran); got: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
});

Deno.test("filters generic extraction notes out of response warnings", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          notes: [
            "Longer brew times are not unusual, especially for lighter roasts.",
            "Brewing method was inferred from source text.",
          ],
        },
        normalized: createHighConfidenceNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-2i",
  });

  assert(
    !result.warnings.some((warning) => warning.includes("Longer brew times")),
    "Expected generic brewing advice in extraction notes to be dropped from response warnings.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("inferred from source text")
    ),
    "Expected diagnostic extraction notes to remain visible in response warnings.",
  );
});

Deno.test("rebalances short description to keep setup details in preparation", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createPrepHeavyChemexExtraction(),
        normalized: createPrepHeavyChemexNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "A coarse 40 g Chemex recipe for 650 g water using a modified filter, silicone chute cover, and staged pours.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2j",
  });

  assertEquals(
    result.draft.localization.short_description,
    "Coarse Chemex recipe using 40g coffee and 650g water with modified filter, silicone chute cover, and staged pours.",
    "Expected setup-heavy short descriptions to be rebalanced by promoting non-action setup context into the recipe summary.",
  );
  assertEquals(
    result.publish_projection?.user_recipe_localization.short_description,
    "Coarse Chemex recipe using 40g coffee and 650g water with modified filter, silicone chute cover, and staged pours.",
    "Expected persisted localization short description to use the rebalanced summary.",
  );
});

Deno.test("rewrites later pour steps to cumulative water totals", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createKimexExtraction(),
        normalized: createKimexNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock Kimex recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2k",
  });

  assertEquals(
    result.draft.steps.slice(1).map((step) => step.description_template),
    [
      "Start timer and pour (0.153846 x <final_water_amount>)g of boiling water into the center, spiraling outward.",
      "At 30 seconds, pour up to (0.307692 x <final_water_amount>)g of water, then swirl until clumps disappear and gases are released.",
      "One minute later, pour up to (0.615385 x <final_water_amount>)g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
      "After another minute, pour up to (0.846154 x <final_water_amount>)g of water, maintaining a gentle swirl to avoid over-agitation.",
      "One minute after the previous pour, pour up to (1 x <final_water_amount>)g of water softly, finish with a light swirl and let the brew drain.",
    ],
    "Expected later pour steps to be rewritten to cumulative water totals.",
  );
  assertEquals(
    result.draft.steps.slice(1).map((step) => step.preview_text),
    [
      "Start timer and pour 100g of boiling water into the center, spiraling outward.",
      "At 30 seconds, pour up to 200g of water, then swirl until clumps disappear and gases are released.",
      "One minute later, pour up to 400g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
      "After another minute, pour up to 550g of water, maintaining a gentle swirl to avoid over-agitation.",
      "One minute after the previous pour, pour up to 650g of water softly, finish with a light swirl and let the brew drain.",
    ],
    "Expected preview text to resolve cumulative water totals correctly.",
  );
});

Deno.test("uses the cumulative rewrite LLM pass for non-English multi-pour recipes", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createFrenchIncrementalExtraction(),
        normalized: createFrenchIncrementalNormalized(),
        cumulativeRewrite: createFrenchCumulativeRewrite(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Recette Chemex en français",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2l",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
      { provider: "groq", stage: "cumulative_rewrite" },
    ],
    "Expected non-English multi-pour recipes to use the narrow cumulative rewrite pass.",
  );
  assertEquals(
    result.draft.steps[2].description_template,
    "À 30 secondes, versez jusqu’à (1 x <final_water_amount>)g d’eau puis remuez doucement.",
    "Expected cumulative rewrite output to be preserved for non-English recipes.",
  );
  assertEquals(
    result.draft.steps[2].preview_text,
    "À 30 secondes, versez jusqu’à 200g d’eau puis remuez doucement.",
    "Expected non-English preview text to resolve the cumulative total correctly.",
  );
});

Deno.test("does not use the cumulative rewrite LLM pass for already-English multi-pour recipes", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createKimexExtraction(),
        normalized: createKimexNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  await parser.parseDraft({
    text: "Mock Kimex recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-2m",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
    ],
    "Expected already-English recipes to stay on deterministic cumulative rewriting only.",
  );
});

Deno.test("builds canonical user-recipe publish projection with numeric step times", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-3",
  });

  assert(
    result.validation.is_publishable,
    "Expected the draft to be publishable.",
  );
  assert(
    result.publish_projection !== undefined,
    "Expected publish projection to be present.",
  );
  assertEquals(
    result.provider_model_used,
    "groq",
    "Expected mock provider_model_used passthrough for single-provider tests.",
  );
  assertEquals(
    result.draft.localization.locale,
    "en",
    "Expected canonical locale to be en.",
  );
  assertEquals(
    result.draft.steps[0].duration_seconds,
    0,
    "Expected preparation step duration to be 0.",
  );
  assertEquals(
    result.publish_projection?.user_steps.map((step) => step.time),
    ["0", "30", "90"],
    "Expected DB step times to be numeric strings.",
  );
  assertEquals(
    result.publish_projection?.user_steps.map((step) => step.description),
    [
      "Rinse the filter and add (1 x <final_coffee_amount>)g coffee.",
      "Pour (0.2 x <final_water_amount>)g of water and bloom.",
      "Pour up to (1 x <final_water_amount>)g total and wait.",
    ],
    "Expected numeric step amounts to be normalized into expressions.",
  );
  assert(
    !result.publish_projection?.user_steps.some((step) =>
      step.description.includes("<t")
    ),
    "Expected no timer placeholders in user recipe steps.",
  );
});

Deno.test("prefers water expressions for brew-step amounts even when coffee ratios are cleaner", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createAmbiguousWaterNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-4",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Pour (0.12 x <final_water_amount>)g water for bloom.",
    "Expected brew amounts to prefer water placeholders over coffee placeholders.",
  );
  assertEquals(
    result.draft.steps[1].expressions,
    [
      {
        placeholder: "<final_water_amount>",
        multiplier: 0.12,
        unit: "g",
        preview_value: 30,
      },
    ],
    "Expected expressions metadata to be extracted from normalized templates.",
  );
});

Deno.test("converts scalable water amount ranges into expression ranges", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: {
          ...createAmbiguousWaterNormalized(),
          recipe: {
            ...createAmbiguousWaterNormalized().recipe,
            water_amount: 500,
          },
          steps: [
            createAmbiguousWaterNormalized().steps[0],
            {
              kind: "brew",
              description_source:
                "Bloom with 60-90 grams water for 45 seconds.",
              description_template:
                "Bloom with 60-90 grams water for 45 seconds.",
              duration_seconds: 45,
              elapsed_seconds: null,
              starts_timer: false,
              duration_is_stated: false,
              scalable_amounts: [],
              step_role: null,
            },
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Bloom with 60-90 grams water for 45 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-4a",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Bloom with (0.12 x <final_water_amount>)-(0.18 x <final_water_amount>)g water for 45 seconds.",
    "Expected both sides of amount ranges to become scalable expressions.",
  );
  assertEquals(
    result.draft.steps[1].preview_text,
    "Bloom with 60-90g water for 45 seconds.",
    "Expected preview text to render both sides of the expression range.",
  );
  assertEquals(
    result.draft.steps[1].expressions.map((expression) => ({
      placeholder: expression.placeholder,
      multiplier: expression.multiplier,
      unit: expression.unit,
      preview_value: expression.preview_value,
    })),
    [
      {
        placeholder: "<final_water_amount>",
        multiplier: 0.12,
        unit: "",
        preview_value: 60,
      },
      {
        placeholder: "<final_water_amount>",
        multiplier: 0.18,
        unit: "g",
        preview_value: 90,
      },
    ],
    "Expected both range expressions to be captured in metadata.",
  );
});

Deno.test("remaps brewing method labels to supported brewing_method_id values", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "Hario V60",
        },
        normalized: createDisplayNameMethodNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "V60",
      },
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-5",
  });

  assertEquals(
    result.draft.recipe.brewing_method_id,
    "v60",
    "Expected brewing method labels to be normalized to supported ids.",
  );
  assertEquals(
    result.provider_model_used,
    "groq",
    "Expected provider_model_used passthrough for single-provider tests.",
  );
  assert(
    result.validation.is_publishable,
    "Expected resolved brewing method ids to remain publishable.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("normalized to supported id 'v60'")
    ),
    "Expected a warning when a display label is remapped to a supported id.",
  );
});

Deno.test("rejects loosely-matched brewing method labels instead of coercing them", async () => {
  // F24 regression test: a "pour over" recipe was previously coerced to the
  // unrelated branded id "wilfa" because resolveBrewingMethodId picked the
  // nearest-scoring candidate (substring containment) even at low
  // confidence. It must now return null and warn instead of guessing.
  const displayNameNormalized = createDisplayNameMethodNormalized();
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "Pour Over",
        },
        normalized: {
          ...displayNameNormalized,
          recipe: {
            ...displayNameNormalized.recipe,
            brewing_method_id: "Pour Over",
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "wilfa",
        brewing_method: "Wilfa Pour Over",
      },
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-5b",
  });

  assertEquals(
    result.draft.recipe.brewing_method_id,
    null,
    "Expected a loose substring match to be rejected instead of coerced to 'wilfa'.",
  );
  assert(
    !result.validation.is_publishable,
    "Expected an unresolved brewing method to block publishing.",
  );
  assert(
    result.validation.issues.some((issue) =>
      issue.code === "missing_brewing_method"
    ),
    "Expected a missing_brewing_method validation issue.",
  );
  assert(
    result.warnings.some((warning) =>
      warning ===
        "Brewing method 'Pour Over' is not among the supported methods and was left unset."
    ),
    "Expected a warning naming the rejected candidate without contradicting the null id.",
  );
});

Deno.test("resolves a more specific candidate label that contains a supported method token", async () => {
  // F24: asymmetric containment. "Kalita Wave pour over" is a legitimate,
  // more specific label for the supported "kalita" method — the candidate
  // contains the method token, not the other way around — so it must
  // resolve, unlike the "wilfa" rejection case above.
  const displayNameNormalized = createDisplayNameMethodNormalized();
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "Kalita Wave pour over",
        },
        normalized: {
          ...displayNameNormalized,
          recipe: {
            ...displayNameNormalized.recipe,
            brewing_method_id: "Kalita Wave pour over",
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "kalita",
        brewing_method: "Kalita Wave",
      },
      {
        brewing_method_id: "chemex",
        brewing_method: "Chemex",
      },
    ],
    requestId: "req-5c",
  });

  assertEquals(
    result.draft.recipe.brewing_method_id,
    "kalita",
    "Expected a candidate that contains the method token to resolve to that method.",
  );
  assert(
    result.validation.is_publishable,
    "Expected a resolved brewing method to remain publishable.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("normalized to supported id 'kalita'")
    ),
    "Expected a warning describing the remap from the specific label to the supported id.",
  );
});

Deno.test("rejects a normalized brewing_method_id that contradicts an unsupported extracted label", async () => {
  // F24 contradiction guard: the LLM extracted "Cold Brew" from the source
  // (a real method mention, unsupported by this method list) but then the
  // normalization stage emitted brewing_method_id "french_press" anyway —
  // an exact id match that would otherwise be accepted at face value. Since
  // the extracted label doesn't match any supported method, the normalized
  // id must not be trusted either.
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "Cold Brew",
        },
        normalized: {
          ...createNormalized(),
          recipe: {
            ...createNormalized().recipe,
            brewing_method_id: "french_press",
          },
          warnings: [
            "Cold brew is not among the allowed brewing methods; brewing_method_id was set to null.",
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "french_press",
        brewing_method: "French Press",
      },
      {
        brewing_method_id: "v60",
        brewing_method: "V60",
      },
    ],
    requestId: "req-5d",
  });

  assertEquals(
    result.draft.recipe.brewing_method_id,
    null,
    "Expected the contradicted normalized id to be rejected instead of trusted.",
  );
  assert(
    !result.validation.is_publishable,
    "Expected an unresolved brewing method to block publishing.",
  );
  assert(
    result.validation.issues.some((issue) =>
      issue.code === "missing_brewing_method"
    ),
    "Expected a missing_brewing_method validation issue.",
  );
  assert(
    result.warnings.some((warning) =>
      warning ===
        "Brewing method 'Cold Brew' is not among the supported methods and was left unset."
    ),
    "Expected a warning naming the unsupported extracted label, not the contradicted id.",
  );
});

Deno.test("leaves coffee amount and water amount null when the source states neither, without fabricating them", async () => {
  // F21 regression test: a source that never mentions coffee or water
  // amounts (e.g. "I never really measure anything") must not have those
  // numbers invented by the repair stage. They should stay null, block
  // publishing, and explain themselves via warnings.
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "V60",
          coffee_amount_grams: null,
          water_amount: null,
        },
        normalized: {
          ...createNormalized(),
          recipe: {
            ...createNormalized().recipe,
            coffee_amount: null,
            water_amount: null,
          },
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "I never really measure anything, I just eyeball it every time.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "V60",
      },
    ],
    requestId: "req-6",
  });

  assertEquals(
    result.draft.recipe.coffee_amount,
    null,
    "Expected coffee_amount to stay null instead of being fabricated.",
  );
  assertEquals(
    result.draft.recipe.water_amount,
    null,
    "Expected water_amount to stay null instead of being fabricated.",
  );
  assert(
    !result.validation.is_publishable,
    "Expected a draft with fabricated-free missing amounts to be unpublishable.",
  );
  assertEquals(
    result.publish_projection,
    undefined,
    "Expected no publish_projection when required amounts are missing.",
  );
  assert(
    result.validation.issues.some((issue) =>
      issue.code === "missing_coffee_amount"
    ),
    "Expected a missing_coffee_amount validation issue.",
  );
  assert(
    result.validation.issues.some((issue) =>
      issue.code === "missing_water_amount"
    ),
    "Expected a missing_water_amount validation issue.",
  );
  assert(
    result.warnings.includes(
      "Coffee amount is not stated in the source and was left empty.",
    ),
    "Expected an explanatory warning for the missing coffee amount.",
  );
  assert(
    result.warnings.includes(
      "Water amount is not stated in the source and was left empty.",
    ),
    "Expected an explanatory warning for the missing water amount.",
  );
  assert(
    !calls.some((call) => call.stage === "repair"),
    "Expected the repair stage to be skipped when only source-only fields are missing.",
  );
});

Deno.test("does not invoke the repair stage when only source-only fields are missing", async () => {
  // F21: coffee_amount/water_amount/brewing_method_id are source-only and
  // must never gate the repair stage — repairing them would mean inviting
  // the model to invent numbers the source never gave.
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "V60",
          coffee_amount_grams: null,
          water_amount: null,
        },
        normalized: {
          ...createNormalized(),
          recipe: {
            ...createNormalized().recipe,
            coffee_amount: null,
            water_amount: null,
          },
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  await parser.parseDraft({
    text: "Mock recipe with no stated amounts",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "V60",
      },
    ],
    requestId: "req-7",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
    ],
    "Expected no repair call when only source-only fields (coffee/water amount) are missing.",
  );
});

Deno.test("still invokes the repair stage when an inferable field like water_temp is missing", async () => {
  // F21: localization.name/grind_size/short_description and
  // recipe.water_temp remain INFERABLE — repair must still run for them.
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "V60",
          water_temp_celsius: null,
        },
        normalized: {
          ...createNormalized(),
          recipe: {
            ...createNormalized().recipe,
            water_temp: null,
          },
        },
        repair: createRepairNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe missing only a water temperature",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "V60",
      },
    ],
    requestId: "req-8",
  });

  assertEquals(
    calls,
    [
      { provider: "groq", stage: "extraction" },
      { provider: "groq", stage: "normalization" },
      { provider: "groq", stage: "repair" },
    ],
    "Expected a repair pass when an inferable field (water_temp) is still missing.",
  );
  assertEquals(
    result.draft.recipe.water_temp,
    93,
    "Expected the repaired water_temp to be used.",
  );
});

Deno.test("verify mode uses conservative system prompts at every stage", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const systemPrompts: Array<
    { provider: string; stage: string; systemPrompt: string }
  > = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        extraction: createExtraction(),
        normalized: createNormalized(),
        cumulativeRewrite: {
          warnings: [],
          steps: createNormalized().steps,
        },
        calls,
        systemPrompts,
      }),
    ],
    now: () => 1776000000000,
  });

  await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-verify-mode",
    mode: "verify",
  });

  const normalizationPrompt = systemPrompts.find((p) =>
    p.stage === "normalization"
  );
  assert(
    normalizationPrompt !== undefined,
    "Expected normalization stage to run.",
  );
  assert(
    normalizationPrompt!.systemPrompt.includes(
      "description_template must equal description_source verbatim",
    ),
    "Expected verify-mode normalization prompt to demand verbatim preservation.",
  );
  assert(
    normalizationPrompt!.systemPrompt.includes(
      "Preparation step (order 1) is sacred",
    ),
    "Expected verify-mode normalization prompt to protect the preparation step.",
  );
  assert(
    !normalizationPrompt!.systemPrompt.includes(
      "concise timer-ready brewing instructions",
    ),
    "Expected verify-mode normalization prompt to drop the aggressive rewrite rule.",
  );

  const cumulativePrompt = systemPrompts.find((p) =>
    p.stage === "cumulative_rewrite"
  );
  if (cumulativePrompt) {
    assert(
      cumulativePrompt.systemPrompt.includes(
        "Only rewrite a later water-addition brew step when its description_source is unambiguously incremental",
      ),
      "Expected verify-mode cumulative prompt to restrict rewrites to unambiguous incremental wording.",
    );
  }
});

Deno.test("extract mode (default) keeps the original aggressive prompts", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const systemPrompts: Array<
    { provider: string; stage: string; systemPrompt: string }
  > = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        tag: "groq/compound-mini",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
        systemPrompts,
      }),
    ],
    now: () => 1776000000000,
  });

  await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-extract-mode",
  });

  const normalizationPrompt = systemPrompts.find((p) =>
    p.stage === "normalization"
  );
  assert(
    normalizationPrompt !== undefined,
    "Expected normalization stage to run.",
  );
  assert(
    normalizationPrompt!.systemPrompt.includes(
      "concise timer-ready brewing instructions",
    ),
    "Expected extract-mode normalization prompt to keep the aggressive rewrite rule.",
  );
  assert(
    !normalizationPrompt!.systemPrompt.includes(
      "description_template must equal description_source verbatim",
    ),
    "Expected extract-mode normalization prompt NOT to demand verbatim preservation.",
  );
});

// Plan 010 §3: verify-user-recipe-draft's handler hard-502s the app the
// moment the parser's step count diverges from the request's, and
// foldPreTimerStepsIntoPreparation removes steps. verify mode must
// therefore skip the fold entirely, AND must not claim in `warnings` that a
// fold happened when it didn't (plan §4c).
Deno.test("verify mode preserves step count for a Hario-Switch-style pre-timer fixture and emits no fold warning", async () => {
  const extraction = createHarioSwitchPreTimerExtraction();
  const normalized = createHarioSwitchPreTimerNormalized();
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-verify-fold-guard",
    mode: "verify",
  });

  assertEquals(
    result.draft.steps.length,
    normalized.steps.length,
    "Expected verify mode to preserve the supplied step count instead of folding pre-timer actions away.",
  );
  assert(
    !result.warnings.includes(
      "Pre-timer actions were folded into the preparation step.",
    ),
    "Expected no fold warning in verify mode, since no fold happened.",
  );
});

// Mirror image of the guard test above: the SAME pre-timer fixture, with no
// `mode` (defaulting to "extract"), must still fold — this is what proves
// the verify-mode guard is scoped to verify mode and not accidentally
// disabling the fold everywhere.
Deno.test("extract mode still folds the same Hario-Switch-style pre-timer fixture (mirror image of the verify-mode guard)", async () => {
  const extraction = createHarioSwitchPreTimerExtraction();
  const normalized = createHarioSwitchPreTimerNormalized();
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-extract-fold-guard",
  });

  assert(
    result.draft.steps.length < normalized.steps.length,
    "Expected extract mode to still fold pre-timer actions, shrinking the step count.",
  );
  assert(
    result.warnings.includes(
      "Pre-timer actions were folded into the preparation step.",
    ),
    "Expected the fold warning to still fire in extract mode.",
  );
});

// Plan 010 §3: the synthetic drawdown append inside
// normalizeAbsoluteTimestampDurations adds a step and is not gated on mode
// in the pre-fix code. verify mode must skip that append while leaving the
// in-place elapsed-time-to-duration normalization above it untouched.
Deno.test("verify mode preserves step count for a timestamped fixture that would otherwise gain a synthetic drawdown step", async () => {
  const extraction = createChemexNaturalElapsedExtraction();
  const normalized = createChemexNaturalElapsedNormalized();
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1777808888503,
  });

  const result = await parser.parseDraft({
    text:
      "Start your timer and begin your first pour. Target adding around 100 grams of water. Now start the second pour at 45 seconds and bring the water weight up to 300 grams. At a minute and 50 seconds, start your third pour, bringing the water weight up to 500 grams. Begin the fourth and final pour at 3 minutes and 10 seconds and bring the water weight up to 700 grams. Typically a chemex will finish brewing in around four minutes. Once the water finishes dripping through the filter, discard the filter and enjoy.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "chemex", brewing_method: "Chemex" },
    ],
    requestId: "req-verify-drawdown-guard",
    mode: "verify",
  });

  assertEquals(
    result.draft.steps.length,
    normalized.steps.length,
    "Expected verify mode to preserve the supplied step count instead of appending a synthetic drawdown step.",
  );
  assert(
    result.draft.steps.every((step) =>
      step.description_template !== "Wait for the complete drawdown."
    ),
    "Expected no synthetic drawdown step to be appended in verify mode.",
  );
});

// General invariant behind plan 010 §3: whatever shape the source recipe
// takes, verify mode must never change the number of steps it was handed —
// that is exactly what makes verify-user-recipe-draft's handler 502.
Deno.test("verify mode step-count invariant holds across pre-timer, drawdown-synthesis, and plain fixture shapes", async () => {
  const fixtures: Array<
    { label: string; extraction: ExtractionResult; normalized: NormalizedDraft }
  > = [
    {
      label: "Hario-Switch-style pre-timer recipe",
      extraction: createHarioSwitchPreTimerExtraction(),
      normalized: createHarioSwitchPreTimerNormalized(),
    },
    {
      label:
        "timestamped recipe that would otherwise gain a synthetic drawdown",
      extraction: createChemexNaturalElapsedExtraction(),
      normalized: createChemexNaturalElapsedNormalized(),
    },
    {
      label: "plain 3-step V60",
      extraction: createExtraction(),
      normalized: createNormalized(),
    },
  ];

  for (const fixture of fixtures) {
    const parser = createRecipeDraftParser({
      providers: [
        createMockProvider({
          name: "groq",
          extraction: fixture.extraction,
          normalized: fixture.normalized,
          calls: [],
        }),
      ],
      now: () => 1776000000000,
    });

    const result = await parser.parseDraft({
      text: "Mock recipe",
      userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
      brewingMethods: [
        { brewing_method_id: "v60", brewing_method: "Hario V60" },
      ],
      requestId: `req-verify-invariant-${fixture.label}`,
      mode: "verify",
    });

    assertEquals(
      result.draft.steps.length,
      fixture.normalized.steps.length,
      `Expected verify mode to preserve the step count for: ${fixture.label}.`,
    );
  }
});

// F30: two consecutive runs of the same German source recipe produced
// different output languages (one preserved German, one silently
// translated everything to English), even though the old rule already
// said "do not translate source text." The old phrasing bundled that
// instruction with "Storage locale is always 'en'" in the same sentence,
// which reads as if 'en' were a target-language instruction rather than
// unrelated row metadata. This hardens the rule in the extraction,
// normalization, and repair system prompts: state plainly which fields
// must match the source language, separate the storage-locale metadata
// from any language instruction, and give a worked German example.
Deno.test("hardens language-preservation rules (F30) across extraction, normalization, and repair prompts", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const systemPrompts: Array<
    { provider: string; stage: string; systemPrompt: string }
  > = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          water_temp_celsius: null,
        },
        normalized: {
          ...createNormalized(),
          recipe: {
            ...createNormalized().recipe,
            water_temp: null,
          },
        },
        repair: createRepairNormalized(),
        calls,
        systemPrompts,
      }),
    ],
    now: () => 1776000000000,
  });

  await parser.parseDraft({
    text: "Mock recipe missing a water temperature",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f30",
  });

  const extractionPrompt = systemPrompts.find((p) => p.stage === "extraction");
  const normalizationPrompt = systemPrompts.find((p) =>
    p.stage === "normalization"
  );
  const repairPrompt = systemPrompts.find((p) => p.stage === "repair");

  assert(extractionPrompt !== undefined, "Expected extraction stage to run.");
  assert(
    normalizationPrompt !== undefined,
    "Expected normalization stage to run.",
  );
  assert(repairPrompt !== undefined, "Expected repair stage to run.");

  assert(
    extractionPrompt!.systemPrompt.includes(
      "name, short_description, grind_size, preparation, and every step's raw_text must be written in the SAME LANGUAGE as the source recipe text",
    ),
    "Expected the extraction prompt to plainly require source-language output for the relevant fields.",
  );
  assert(
    extractionPrompt!.systemPrompt.includes("V60 auf die Waage stellen"),
    "Expected the extraction prompt to include a worked German example.",
  );
  assert(
    extractionPrompt!.systemPrompt.includes(
      "notes is diagnostic parser commentary",
    ),
    "Expected the extraction prompt to say notes may be English regardless of source language.",
  );

  for (const prompt of [normalizationPrompt!, repairPrompt!]) {
    assert(
      prompt.systemPrompt.includes(
        "description_source, description_template, localization.name, localization.grind_size, and localization.short_description must be written in the SAME LANGUAGE as the source recipe text",
      ),
      `Expected the ${prompt.stage} prompt to plainly require source-language output for the relevant fields.`,
    );
    assert(
      prompt.systemPrompt.includes(
        "NOT an instruction to write English",
      ),
      `Expected the ${prompt.stage} prompt to separate storage locale metadata from a language instruction.`,
    );
    assert(
      prompt.systemPrompt.includes("V60 auf die Waage stellen"),
      `Expected the ${prompt.stage} prompt to include a worked German example.`,
    );
    assert(
      prompt.systemPrompt.includes(
        "warnings is diagnostic parser commentary",
      ),
      `Expected the ${prompt.stage} prompt to say warnings may be English regardless of source language.`,
    );
  }
});

function createMixedContextNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Mixed Context",
      grind_size: "Medium",
      short_description: "Tests nearest-keyword amount resolution",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Prepare the brewer.",
        description_template: "Prepare the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Pour 50gr of hot water. Then add 15g coffee and stir.",
        description_template:
          "Pour 50gr of hot water. Then add 15g coffee and stir.",
        duration_seconds: 90,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Add coffee 30g water",
        description_template: "Add coffee 30g water",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

Deno.test("assigns mixed-context amounts by nearest keyword and keeps exact ties unconverted", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createMixedContextNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-nearest",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Pour (0.2 x <final_water_amount>)gr of hot water. Then add (1 x <final_coffee_amount>)g coffee and stir.",
    "Expected a coffee dose surrounded by water and coffee wording to scale with coffee, not water, and gr to be a scalable unit.",
  );
  assertEquals(
    result.draft.steps[2].description_template,
    "Add coffee 30g water",
    "Expected an amount exactly equidistant from coffee and water wording to stay unconverted.",
  );
});

// Phase B2: builds one V60-shaped fixture (prep + bloom + two pours +
// drawdown) whose brew steps are all DERIVED — none of them states its own
// duration, has an elapsed_seconds timestamp, or exceeds the inferred-
// duration cap — with a stated 210s total_brew_time_seconds. The only thing
// that varies between calls is `stepDurations`, standing in for what three
// different model runs guessed for the same transcript.
function createDeterministicSplitFixtures(
  stepDurations: [number, number, number, number],
): { extraction: ExtractionResult; normalized: NormalizedDraft } {
  const rawTexts = [
    "Bloom with 50g water for a short while.",
    "Continue pouring to 150g total water.",
    "Pour up to 250g total water.",
    "Stir gently, then let it drawdown.",
  ];

  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Deterministic Split V60",
    short_description: "Tests deterministic derived-step splitting",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 250,
    preparation: "Add coffee to the brewer.",
    steps: rawTexts.map((raw_text, index) => ({
      title: null,
      raw_text,
      duration_seconds: stepDurations[index],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    })),
    notes: [],
    total_brew_time_seconds: 210,
  };

  const templates = [
    "Bloom with (0.2 x <final_water_amount>)g water for a short while.",
    "Continue pouring to (0.6 x <final_water_amount>)g total water.",
    "Pour up to (1 x <final_water_amount>)g total water.",
    "Stir gently, then let it drawdown.",
  ];

  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Deterministic Split V60",
      grind_size: "Medium",
      short_description: "Tests deterministic derived-step splitting",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      ...rawTexts.map((raw_text, index) => ({
        kind: "brew" as const,
        description_source: raw_text,
        description_template: templates[index],
        duration_seconds: stepDurations[index],
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      })),
    ],
  };

  return { extraction, normalized };
}

async function parseDeterministicSplitFixture(
  stepDurations: [number, number, number, number],
  requestId: string,
) {
  const { extraction, normalized } = createDeterministicSplitFixtures(
    stepDurations,
  );
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  return await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId,
  });
}

Deno.test("splits derived brew-step durations identically regardless of the model's own guessed split (Phase B2 acceptance test)", async () => {
  // This is the test that proves the Phase B2 fix. Phase B pinned the
  // recipe *total* (three identical transcript runs all returned exactly
  // 210s), but the *split* between steps still varied wildly across those
  // same three runs in production:
  //   run 1   0 / 67 / 10 / 67 / 66
  //   run 2   0 / 45 / 45 / 90 / 30
  //   run 3   0 / 10 / 10 / 180 / 10
  // All three summed to 210, but none of the individual step durations
  // agreed. None of these four brew steps states its own duration in the
  // source, so all four are DERIVED — under the Phase B2 split, the final
  // per-step durations must be a pure function of the target total, the
  // water amounts, and each step's role, and must NOT depend on whatever
  // duration number a given model run guessed for that step.
  //
  // The physical shape: bloom (the first water-adding step, 50g) gets the
  // fixed 45s bloom pause; the two 100g pours each get an ~8 g/s pour-rate
  // estimate (13s); and the drawdown — matched by wording ("let it
  // drawdown") — absorbs whatever is left over (139s) rather than
  // competing for a share, since drawdown time isn't determined by how
  // much water was in the last pour.
  const modelGuessedSplits: Array<[number, number, number, number]> = [
    [67, 10, 67, 66],
    [45, 45, 90, 30],
    [10, 10, 180, 10],
  ];

  const results = await Promise.all(
    modelGuessedSplits.map((split, index) =>
      parseDeterministicSplitFixture(split, `req-deterministic-${index}`)
    ),
  );

  const expectedDurations = [0, 45, 13, 13, 139];

  results.forEach((result, index) => {
    assertEquals(
      result.draft.steps.map((step) => step.duration_seconds),
      expectedDurations,
      `Expected run ${index} (model guessed ${
        JSON.stringify(modelGuessedSplits[index])
      }) to produce the same deterministic split regardless of the model's own guessed durations.`,
    );
    assertEquals(
      result.draft.recipe.brew_time_seconds,
      210,
      `Expected run ${index} brew time to equal the stated 210s target.`,
    );
  });

  assertEquals(
    results[0].draft.steps.map((step) => step.duration_seconds),
    results[1].draft.steps.map((step) => step.duration_seconds),
    "Expected run 0 and run 1 to produce byte-identical step durations.",
  );
  assertEquals(
    results[1].draft.steps.map((step) => step.duration_seconds),
    results[2].draft.steps.map((step) => step.duration_seconds),
    "Expected run 1 and run 2 to produce byte-identical step durations.",
  );
});

// ---------------------------------------------------------------------
// defect-1 (2026-08-12 live pass): a known START time was being treated as
// a known DURATION. isAnchoredBrewStep used to anchor ANY step carrying a
// non-null elapsed_seconds, but elapsed_seconds only records when a step
// BEGAN, never how long it lasted. Four live runs of the same Hario Switch
// transcript produced totals of 70 / 70 / 80 / 95 seconds against a
// stated 90-100s target: the three short runs each had every brew step
// carrying an elapsed_seconds (including the final drawdown), so under the
// old logic every step looked anchored, derivedIndexes came back empty,
// and splitDerivedBrewStepDurationsFromTarget bailed out entirely --
// leaving the model's own inconsistent per-step guesses with no total
// enforced at all. The fix: only a step whose duration was computed by
// differencing two KNOWN elapsed timestamps (or one that states its own
// duration) is anchored; a step whose elapsed_seconds has no successor to
// difference against -- the common shape for a final drawdown that merely
// records when it began -- is correctly left DERIVED so it can absorb
// whatever the deterministic split leaves over.
// ---------------------------------------------------------------------

Deno.test("defect-1: enforces the stated total even when every brew step carries an elapsed_seconds (Hario Switch live-incident shape)", async () => {
  // Mirrors the exact live-capture shape (captures e3dfca7d/abd725f2, both
  // 70s totals against a 95s stated target): a stated-duration stir that
  // starts the timer, a second stir whose start time is known but whose
  // OWN duration was never stated, and a drawdown whose start time is
  // known but whose duration is likewise never stated. Under the pre-fix
  // logic, all three steps carried a non-null elapsed_seconds and were
  // therefore all anchored, so the split bailed out and the total stayed
  // at whatever the model happened to guess (40 + 20 + 10 = 70) instead of
  // the stated 95.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Hario Switch",
    name: "Elapsed-Everywhere Hario Switch",
    short_description: "Tests defect-1's start-time-vs-duration fix.",
    grind_size: "Medium",
    water_temp_celsius: 94,
    coffee_amount_grams: 20,
    water_amount: 260,
    preparation: "Close the switch, add water and coffee.",
    steps: [
      {
        title: null,
        raw_text: "Start the timer and give it a good stir for 40 seconds.",
        duration_seconds: 40,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "stir",
      },
      {
        title: null,
        raw_text: "At 40 seconds, open the switch.",
        duration_seconds: 20,
        elapsed_seconds: 40,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "At a minute, let it fully drain and finish.",
        duration_seconds: 10,
        elapsed_seconds: 60,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 95,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 260,
      water_temp: 94,
    },
    localization: {
      name: "Elapsed-Everywhere Hario Switch",
      grind_size: "Medium",
      short_description: "Tests defect-1's start-time-vs-duration fix.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Close the switch, add water and coffee.",
        description_template: "Close the switch, add water and coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Start the timer and give it a good stir for 40 seconds.",
        description_template:
          "Start the timer and give it a good stir for 40 seconds.",
        duration_seconds: 40,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "stir",
      },
      {
        kind: "brew",
        description_source: "At 40 seconds, open the switch.",
        description_template: "At 40 seconds, open the switch.",
        duration_seconds: 20,
        elapsed_seconds: 40,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "At a minute, let it fully drain and finish.",
        description_template: "At a minute, let it fully drain and finish.",
        duration_seconds: 10,
        elapsed_seconds: 60,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock Hario Switch recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-defect1-elapsed-everywhere",
  });

  // The stated stir (duration_is_stated: true) stays anchored at 40s. The
  // second stir and the drawdown both carry an elapsed_seconds but neither
  // has a known successor to difference against (the drawdown is the
  // last brew step; the second stir's only "successor" is the drawdown,
  // whose OWN duration is unknown, not a differenceable timestamp pair),
  // so both must be treated as derived and the 95s target must be enforced
  // -- not silently left at the model's own guessed 70s.
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    95,
    "Expected the stated 95s total to be enforced even though every brew step carries an elapsed_seconds.",
  );
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds).reduce(
      (sum, value) => sum + value,
      0,
    ),
    95,
    "Expected step durations to sum to exactly the stated 95s target.",
  );
  assertEquals(
    result.draft.steps[1].duration_seconds,
    40,
    "Expected the duration_is_stated stir to survive the split untouched.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes(
        "split deterministically from the stated total brew time",
      )
    ),
    "Expected the deterministic split to actually run (proving derivedIndexes was non-empty), not bail out silently.",
  );
});

Deno.test("defect-1: a lone elapsed_seconds with no successor to difference against does not anchor a step's duration", async () => {
  // Isolates the core distinction directly: a step whose ONLY timing
  // signal is elapsed_seconds (a begins-at timestamp), with nothing to
  // difference it against, must be treated exactly like a step with no
  // elapsed_seconds at all for anchoring purposes -- its duration is
  // unknown, not "known because it has a timestamp". Here the single brew
  // step both starts AND (per the old bug) would appear to know its own
  // duration merely by carrying elapsed_seconds: 0; the deterministic
  // split must still recompute it from the resolved target rather than
  // trust the model's arbitrary 5s guess.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Cold Brew",
    name: "Lone Timestamp Cold Brew",
    short_description: "Tests that a lone elapsed_seconds never anchors.",
    grind_size: "Coarse",
    water_temp_celsius: 20,
    coffee_amount_grams: 50,
    water_amount: 800,
    preparation: "Combine coffee and cold water.",
    steps: [
      {
        title: null,
        raw_text: "Start the timer and let it steep.",
        duration_seconds: 5,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 120,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 50,
      water_amount: 800,
      water_temp: 20,
    },
    localization: {
      name: "Lone Timestamp Cold Brew",
      grind_size: "Coarse",
      short_description: "Tests that a lone elapsed_seconds never anchors.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Combine coffee and cold water.",
        description_template: "Combine coffee and cold water.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Start the timer and let it steep.",
        description_template: "Start the timer and let it steep.",
        duration_seconds: 5,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock cold brew recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-defect1-lone-timestamp",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 120],
    "Expected the lone step's elapsed_seconds:0 to NOT anchor its 5s guessed duration, so the deterministic split recomputes it to the full 120s target.",
  );
});

Deno.test("treats a duration_is_stated step as anchored and excludes it from the derived split (cold brew)", async () => {
  // A step with duration_is_stated: true must survive the deterministic
  // split completely untouched, and must not be counted among the derived
  // steps competing for a share of the available time — even when its
  // duration (64800s / 18 hours) is nowhere near the target.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Cold Brew",
    name: "Anchored Steep Cold Brew",
    short_description: "Tests duration_is_stated anchoring",
    grind_size: "Coarse",
    water_temp_celsius: 20,
    coffee_amount_grams: 50,
    water_amount: 800,
    preparation: "Combine coarse coffee and cold water in the steeping vessel.",
    steps: [
      {
        title: null,
        raw_text: "Steep for 18 hours.",
        duration_seconds: 64800,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Swirl gently, then strain and serve.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    // 64800 (the stated steep) + 15 left over for the derived swirl step.
    total_brew_time_seconds: 64815,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "medium",
      coffee_amount: 50,
      water_amount: 800,
      water_temp: 20,
    },
    localization: {
      name: "Anchored Steep Cold Brew",
      grind_size: "Coarse",
      short_description: "Tests duration_is_stated anchoring",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Combine coarse coffee and cold water in the steeping vessel.",
        description_template:
          "Combine coarse coffee and cold water in the steeping vessel.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Steep for 18 hours.",
        description_template: "Steep for 18 hours.",
        duration_seconds: 64800,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Swirl gently, then strain and serve.",
        description_template: "Swirl gently, then strain and serve.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-anchored-steep",
  });

  assertEquals(
    result.draft.steps[1].duration_seconds,
    64800,
    "Expected the duration_is_stated steep step to survive the split completely untouched.",
  );
  assertEquals(
    result.draft.steps[2].duration_seconds,
    15,
    "Expected the derived swirl step to receive exactly the 15s left over after excluding the anchored steep from the split.",
  );
});

Deno.test("leaves brew step durations unchanged when no total brew time target resolves", async () => {
  // No total_brew_time_seconds and no regex-resolvable target text: the
  // deterministic split must not run at all, and every step must keep the
  // duration the model itself produced.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "No Target V60",
    short_description: "Tests the no-resolvable-target early exit",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 200,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Bloom the coffee.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour the rest of the water.",
        duration_seconds: 25,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 200,
      water_temp: 93,
    },
    localization: {
      name: "No Target V60",
      grind_size: "Medium",
      short_description: "Tests the no-resolvable-target early exit",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom the coffee.",
        description_template: "Bloom the coffee.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour the rest of the water.",
        description_template: "Pour the rest of the water.",
        duration_seconds: 25,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-no-target",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 15, 25],
    "Expected step durations to be left completely unchanged when no total brew time target resolves.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    40,
    "Expected brew time to be the plain sum of the model's own durations, with no target to reconcile against.",
  );
});

Deno.test("leaves derived brew steps unchanged when the available time cannot fit them above the minimum", async () => {
  // The anchored step alone leaves only 5s of "available" time for a
  // single derived step, which is below MIN_BREW_STEP_DURATION_SECONDS
  // (10s). Producing a split here would mean squeezing the derived step
  // below the minimum, so the pass must change nothing and leave the
  // model's own (arbitrary) duration in place instead.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Too Tight V60",
    short_description: "Tests the cannot-fit early exit",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 200,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Bloom for 95 seconds.",
        duration_seconds: 95,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Finish the pour.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 100,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 200,
      water_temp: 93,
    },
    localization: {
      name: "Too Tight V60",
      grind_size: "Medium",
      short_description: "Tests the cannot-fit early exit",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom for 95 seconds.",
        description_template: "Bloom for 95 seconds.",
        duration_seconds: 95,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Finish the pour.",
        description_template: "Finish the pour.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-too-tight",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 95, 20],
    "Expected the derived step to keep its own (unadjusted) duration when the available time cannot fit it above the minimum.",
  );
  assert(
    !result.warnings.some((warning) =>
      warning.includes("split deterministically")
    ),
    "Expected no deterministic-split warning when the pass could not fit the derived steps and changed nothing.",
  );
});

Deno.test("weights derived water-adding steps proportionally to the water each one adds", async () => {
  // Bloom (anchored, duration_is_stated: true, adds 40g) is followed by two
  // DERIVED pours — pour A adds 80g (cumulative 40 -> 120), pour B adds
  // 160g (cumulative 120 -> 280, exactly twice pour A's addition) — and a
  // third DERIVED drawdown step ("Let it fully drawdown.") so neither pour
  // itself has to play the drawdown's "absorb the remainder" role. Under
  // the seconds-based model, a pour's estimate is ceil(gramsAdded / 8), so
  // pour B (160g -> 20s) must come out to exactly twice pour A (80g ->
  // 10s); the drawdown gets whatever is left over.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Water Proportional V60",
    short_description: "Tests water-proportional derived weighting",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 280,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with 40g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour up to 120g total.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour up to 280g total.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Let it fully drawdown.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 135,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 280,
      water_temp: 93,
    },
    localization: {
      name: "Water Proportional V60",
      grind_size: "Medium",
      short_description: "Tests water-proportional derived weighting",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom with 40g water for 45 seconds.",
        description_template:
          "Bloom with (0.142857 x <final_water_amount>)g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour up to 120g total.",
        description_template:
          "Pour up to (0.428571 x <final_water_amount>)g total.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour up to 280g total.",
        description_template: "Pour up to (1 x <final_water_amount>)g total.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Let it fully drawdown.",
        description_template: "Let it fully drawdown.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-water-proportional",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 10, 20, 60],
    "Expected pour B (adds 160g) to get exactly twice pour A's estimate (adds 80g), and the drawdown to absorb what's left after the anchored bloom and both pour estimates.",
  );
  assertEquals(
    result.draft.steps[3].duration_seconds,
    result.draft.steps[2].duration_seconds * 2,
    "Expected the 160g pour's duration to be exactly twice the 80g pour's duration.",
  );
});

Deno.test("sums anchored and derived brew step durations to exactly the resolved target when the remainder fits", async () => {
  // Regression guard: whenever the drawdown's remainder is within
  // [MIN_BREW_STEP_DURATION_SECONDS, INFERRED_BREW_STEP_DURATION_CAP_SECONDS],
  // splitDerivedBrewStepDurationsFromTarget must make the anchored total
  // plus every derived step's duration land EXACTLY on the resolved
  // target — never a second over or under, unlike the case where the cap
  // has to sacrifice the exact sum (see the cold-brew cap test).
  const { extraction, normalized } = createDeterministicSplitFixtures([
    67,
    10,
    67,
    66,
  ]);
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      {
        brewing_method_id: "v60",
        brewing_method: "Hario V60",
      },
    ],
    requestId: "req-exact-sum",
  });

  const summedDuration = result.draft.steps.reduce(
    (sum, step) => sum + step.duration_seconds,
    0,
  );
  assertEquals(
    summedDuration,
    210,
    "Expected the sum of every step's duration (anchored + derived) to equal the resolved 210s target exactly.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    210,
    "Expected recipe.brew_time_seconds to equal the same exact target.",
  );
});

// ---------------------------------------------------------------------
// F1: multipliers under 1% used to collapse to zero (silent data loss).
// ---------------------------------------------------------------------

Deno.test("never collapses small multipliers to zero and leaves negligible amounts as literals (F1)", async () => {
  // Each case below is a production example from the F1 bug report: an
  // amount under 2% of its base must stay a literal number in the
  // template rather than becoming a vanishing "(0 x ...)" expression,
  // while a normal-sized amount in the same step must still convert.
  const cases: Array<{
    label: string;
    waterAmount: number;
    template: string;
    expectedTemplate: string;
  }> = [
    {
      label: "2g of 500g (production wording)",
      waterAmount: 500,
      template: "Add 2 grams of salt and pour 300 grams of water.",
      expectedTemplate:
        "Add 2 grams of salt and pour (0.6 x <final_water_amount>)g of water.",
    },
    {
      label: "4.5g of 500g",
      waterAmount: 500,
      template: "Add 4.5 grams of citric acid and pour 300 grams of water.",
      expectedTemplate:
        "Add 4.5 grams of citric acid and pour (0.6 x <final_water_amount>)g of water.",
    },
    {
      label: "2g of 260g",
      waterAmount: 260,
      template: "Add 2 grams of citric acid and pour 200 grams of water.",
      expectedTemplate:
        "Add 2 grams of citric acid and pour (0.769231 x <final_water_amount>)g of water.",
    },
    {
      label: "1g of 225g",
      waterAmount: 225,
      template: "Add 1 gram of citric acid and pour 200 grams of water.",
      expectedTemplate:
        "Add 1 gram of citric acid and pour (0.888889 x <final_water_amount>)g of water.",
    },
  ];

  for (const testCase of cases) {
    const normalized: NormalizedDraft = {
      extracted_amounts: [],
      detected_input_language: "en",
      warnings: [],
      recipe: {
        brewing_method_id: "v60",
        brewing_method_confidence: "high",
        coffee_amount: 15,
        water_amount: testCase.waterAmount,
        water_temp: 93,
      },
      localization: {
        name: "F1 zero-collapse case",
        grind_size: "Medium",
        short_description: "Tests small-amount handling.",
      },
      steps: [
        {
          kind: "preparation",
          description_source: "Prepare the brewer.",
          description_template: "Prepare the brewer.",
          duration_seconds: 0,
          elapsed_seconds: null,
          starts_timer: false,
          duration_is_stated: false,
          scalable_amounts: [],
          step_role: null,
        },
        {
          kind: "brew",
          description_source: testCase.template,
          description_template: testCase.template,
          duration_seconds: 30,
          elapsed_seconds: null,
          starts_timer: false,
          duration_is_stated: false,
          scalable_amounts: [],
          step_role: null,
        },
      ],
    };

    const parser = createRecipeDraftParser({
      providers: [
        createMockProvider({
          name: "groq",
          extraction: createExtraction(),
          normalized,
          calls: [],
        }),
      ],
      now: () => 1776000000000,
    });

    const result = await parser.parseDraft({
      text: "Mock recipe",
      userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
      brewingMethods: [
        { brewing_method_id: "v60", brewing_method: "Hario V60" },
      ],
      requestId: `req-f1-${testCase.label}`,
    });

    assertEquals(
      result.draft.steps[1].description_template,
      testCase.expectedTemplate,
      `[${testCase.label}] Expected the negligible amount to stay literal while the normal amount converts.`,
    );
    assert(
      !result.draft.steps.some((step) =>
        step.description_template.includes("(0 x") ||
        step.description_template.includes("(-0 x")
      ),
      `[${testCase.label}] Expected no step to ever contain a "(0 x" or "(-0 x" expression.`,
    );
  }
});

// ---------------------------------------------------------------------
// Precision cap: Phase C's zero-collapse fix widened formatMultiplier's
// precision without an upper bound, so a non-terminating ratio like
// 25/300 rendered with full floating-point noise (0.08333333333333333)
// instead of the old, tidier 0.08333. Cap at 6 significant digits, but
// only when doing so still satisfies the F1(a) zero-collapse guarantee
// above: a nonzero multiplier must never format as "0" or "-0".
// ---------------------------------------------------------------------

Deno.test("caps formatMultiplier at 6 significant digits without ever collapsing a nonzero value to zero", () => {
  // Real ratios pulled from production recipes (F1 bug report + Phase C
  // follow-up). Some are small enough that convertNumericValuesToExpressions
  // would filter them out via the F1(b) 2%-of-base scalability gate before
  // they ever reach formatMultiplier, so this test calls the exported
  // formatter directly rather than round-tripping through parseDraft.
  const cases: Array<{ label: string; multiplier: number }> = [
    { label: "4.5/500", multiplier: 4.5 / 500 },
    { label: "2/260", multiplier: 2 / 260 },
    { label: "1/225", multiplier: 1 / 225 },
    { label: "25/300", multiplier: 25 / 300 },
    { label: "175/300", multiplier: 175 / 300 },
    { label: "0.5/1000", multiplier: 0.5 / 1000 },
  ];

  for (const testCase of cases) {
    const formatted = formatMultiplier(testCase.multiplier);
    assert(
      formatted !== "0" && formatted !== "-0",
      `[${testCase.label}] Expected the nonzero multiplier ${testCase.multiplier} not to collapse to "${formatted}".`,
    );
    // Round-tripping the formatted string back to a number must stay
    // close to the true multiplier -- 6 significant digits is precise
    // enough that the relative error is negligible for a recipe scaling
    // factor.
    const roundTripped = Number(formatted);
    const relativeError = Math.abs(roundTripped - testCase.multiplier) /
      Math.abs(testCase.multiplier);
    assert(
      relativeError < 1e-4,
      `[${testCase.label}] Expected "${formatted}" to round-trip close to ${testCase.multiplier}, got relative error ${relativeError}.`,
    );
  }

  const uncappedTenDecimalOutput = (25 / 300).toFixed(10);
  const cappedOutput = formatMultiplier(25 / 300);
  assertEquals(
    cappedOutput,
    "0.0833333",
    "Expected 25/300 to round to exactly 6 significant digits.",
  );
  assert(
    cappedOutput.length < uncappedTenDecimalOutput.length,
    `Expected the 6-significant-digit output "${cappedOutput}" to be materially shorter than the 10-decimal rendering "${uncappedTenDecimalOutput}".`,
  );
});

Deno.test("widens formatMultiplier past 6 significant digits only when needed to avoid a zero-collapse", () => {
  // A multiplier small enough that 6 significant digits alone would still
  // land on a real, nonzero value is the common case (covered above). This
  // exercises the guard for a multiplier so tiny that 6 significant
  // digits would still be representable without rounding to zero at any
  // precision -- i.e. confirms the loop never has to widen for realistic
  // recipe ratios, while remaining correct in principle for a
  // pathologically small one.
  const tiny = 3e-7; // e.g. 0.0003g of a 1000g base -- unrealistic but must never format as "0".
  const formatted = formatMultiplier(tiny);
  assert(
    formatted !== "0" && formatted !== "-0",
    `Expected a pathologically small nonzero multiplier not to collapse to "${formatted}".`,
  );
});

Deno.test("widens precision instead of collapsing a tiny nested multiplier to zero (F1a)", async () => {
  // Exercises formatMultiplier via the nested-expression-collapse path
  // (normalizeExpressionLikeMath), independent of the 2% scalability gate
  // added for F1(b) — this is the general "never render zero for a
  // nonzero multiplier" guarantee.
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 1000,
      water_temp: 93,
    },
    localization: {
      name: "F1a nested multiplier",
      grind_size: "Medium",
      short_description: "Tests nested multiplier precision.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Prepare the brewer.",
        description_template: "Prepare the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Add stabilizer then pour.",
        description_template:
          "Add (0.01 x (0.5 x <final_water_amount>))g of stabilizer.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f1a",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Add (0.005 x <final_water_amount>)g of stabilizer.",
    "Expected the nested 0.01 x 0.5 multiplier to collapse to 0.005, not 0.",
  );
  assertEquals(
    result.draft.steps[1].expressions[0].multiplier,
    0.005,
    "Expected the extracted multiplier metadata to also preserve the small value.",
  );
});

Deno.test("does not let getCleanestPlaceholder prefer a degenerate near-zero-ratio base (F1c)", async () => {
  // Before the fix, calculateCleanScore scored a ratio near zero as
  // "clean" (close to the round number 0), so an ambiguous amount with no
  // nearby coffee/water wording could get attached to whichever base made
  // it vanish. With coffee_amount=15 and water_amount=10000, 2 is a
  // legitimate ~13% coffee-relative amount but a degenerate 0.02%
  // water-relative one — the fix must pick coffee.
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 10000,
      water_temp: 93,
    },
    localization: {
      name: "F1c ambiguous amount",
      grind_size: "Medium",
      short_description: "Tests ambiguous-amount base selection.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Something happens with 2g nearby afterward okay.",
        description_template:
          "Something happens with 2g nearby afterward okay.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Continue brewing.",
        description_template: "Continue brewing.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f1c",
  });

  assertEquals(
    result.draft.steps[0].description_template,
    "Something happens with (0.133333 x <final_coffee_amount>)g nearby afterward okay.",
    "Expected the ambiguous amount to resolve against coffee, not the degenerate near-zero water ratio.",
  );
});

// ---------------------------------------------------------------------
// F3: "remaining"-class quantifiers used to survive a cumulative rewrite,
// producing self-contradicting wording like "the remaining 400g".
// ---------------------------------------------------------------------

Deno.test("rewrites 'the remaining Ng' wording to correct cumulative phrasing (F3)", async () => {
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "kalita",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 400,
      water_temp: 93,
    },
    localization: {
      name: "Kalita remaining-water case",
      grind_size: "Medium",
      short_description: "Tests remaining-water cumulative rewriting.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter.",
        description_template: "Rinse the filter.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 200g of water.",
        description_template: "Pour 200g of water.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Add the Dripmaster and pour the remaining 200g of water.",
        description_template:
          "Add the Dripmaster and pour the remaining 200g of water.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock Kalita recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "kalita", brewing_method: "Kalita Wave" },
    ],
    requestId: "req-f3-remaining",
  });

  assertEquals(
    result.draft.steps[2].description_template,
    "Add the Dripmaster and pour up to (1 x <final_water_amount>)g of water.",
    "Expected 'the remaining' wording to be rewritten to correct cumulative phrasing.",
  );
  assertEquals(
    result.draft.steps[2].preview_text,
    "Add the Dripmaster and pour up to 400g of water.",
    "Expected the preview text to show the recipe's actual 400g total, not a mismatched number.",
  );
  assert(
    !result.draft.steps[2].description_template.includes("remaining"),
    "Expected the stale 'remaining' quantifier not to survive next to the cumulative total.",
  );
});

Deno.test("skips the cumulative rewrite and keeps the incremental amount when wording is unrecognized (F3)", async () => {
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "kalita",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 400,
      water_temp: 93,
    },
    localization: {
      name: "Kalita leftover-water case",
      grind_size: "Medium",
      short_description: "Tests an unrecognized quantifier is skipped safely.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter.",
        description_template: "Rinse the filter.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 200g of water.",
        description_template: "Pour 200g of water.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour the leftover 200g of water.",
        description_template: "Pour the leftover 200g of water.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock Kalita recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "kalita", brewing_method: "Kalita Wave" },
    ],
    requestId: "req-f3-leftover",
  });

  assertEquals(
    result.draft.steps[2].description_template,
    "Pour the leftover (0.5 x <final_water_amount>)g of water.",
    "Expected the unrecognized 'leftover' quantifier to leave the step's own incremental amount untouched instead of renumbering it to the cumulative total.",
  );
  assert(
    !result.draft.steps[2].description_template.includes("400"),
    "Expected the step not to silently claim the recipe's 400g total under unrecognized wording.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("could not be safely rewritten")
    ),
    "Expected a warning explaining the cumulative rewrite was skipped for this step.",
  );
});

// ---------------------------------------------------------------------
// F4: RATE_CONTEXT_REGEX used to miss "a/each/every second|minute" and
// slash/per-second|minute abbreviations, so a pour-rate instruction could
// get scaled like a dose.
// ---------------------------------------------------------------------

Deno.test("does not scale pour-rate amounts for every new RATE_CONTEXT_REGEX form (F4)", async () => {
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Rate wording case",
      grind_size: "Medium",
      short_description: "Tests rate-context detection.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Prepare the brewer.",
        description_template: "Prepare the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 9 to 10 milliliters a second until done.",
        description_template:
          "Pour at 9 to 10 milliliters a second until done.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 20ml/s to fill the chamber.",
        description_template: "Pour at 20ml/s to fill the chamber.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 20ml/sec into the dripper.",
        description_template: "Pour at 20ml/sec into the dripper.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 20ml/min slowly.",
        description_template: "Pour at 20ml/min slowly.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 20 ml per second into the dripper.",
        description_template: "Pour at 20 ml per second into the dripper.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 20 ml per min slowly.",
        description_template: "Pour at 20 ml per min slowly.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 20ml each second while swirling.",
        description_template: "Pour at 20ml each second while swirling.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour at 20ml every minute while swirling.",
        description_template: "Pour at 20ml every minute while swirling.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 20ml into the chamber.",
        description_template: "Pour 20ml into the chamber.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f4",
  });

  const rateSteps = result.draft.steps.slice(1, 9);
  rateSteps.forEach((step, index) => {
    assert(
      !step.description_template.includes("("),
      `Expected rate-context step ${
        index + 1
      } to stay a literal amount: "${step.description_template}"`,
    );
  });

  assertEquals(
    result.draft.steps[9].description_template,
    "Pour (0.08 x <final_water_amount>)ml into the chamber.",
    "Expected a plain (non-rate) amount in the same recipe to still convert normally.",
  );
});

// ---------------------------------------------------------------------
// F5: non-recipe numbers (equipment capacities, product specs, asides)
// used to become scalable expressions with no notion of which numbers
// were actually this recipe's own coffee/water amounts.
// ---------------------------------------------------------------------

Deno.test("converts only amounts listed in scalable_amounts, leaving unlisted equipment capacities literal (F5)", async () => {
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 400,
      water_temp: 93,
    },
    localization: {
      name: "Gabi Dripmaster case",
      grind_size: "Medium",
      short_description: "Tests scalable_amounts allowlisting.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Prepare the brewer.",
        description_template: "Prepare the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Use the Gabi Dripmaster's 120ml reservoir and pour 200g of water total.",
        description_template:
          "Use the Gabi Dripmaster's 120ml reservoir and pour 200g of water total.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 200, unit: "g" }],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f5-allowlist",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Use the Gabi Dripmaster's 120ml reservoir and pour (0.5 x <final_water_amount>)g of water total.",
    "Expected the unlisted 120ml equipment capacity to stay literal while the listed 200g pour converts.",
  );
});

Deno.test("falls back to unrestricted amount conversion when scalable_amounts is empty (F5 backward compatibility)", async () => {
  // Same fixture as the allowlisting test above, but with an empty
  // scalable_amounts list — standing in for a model that doesn't yet (or
  // ever) populate the field. Conversion must not silently stop working
  // end-to-end, so this falls back to the pre-F5 regex-only heuristic,
  // which also converts the 120ml capacity (the pre-existing, less
  // precise behavior this change intentionally preserves as a fallback).
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 400,
      water_temp: 93,
    },
    localization: {
      name: "Gabi Dripmaster fallback case",
      grind_size: "Medium",
      short_description: "Tests the scalable_amounts fallback path.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Prepare the brewer.",
        description_template: "Prepare the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Use the Gabi Dripmaster's 120ml reservoir and pour 200g of water total.",
        description_template:
          "Use the Gabi Dripmaster's 120ml reservoir and pour 200g of water total.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f5-fallback",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Use the Gabi Dripmaster's (0.3 x <final_water_amount>)ml reservoir and pour (0.5 x <final_water_amount>)g of water total.",
    "Expected the empty-scalable_amounts fallback to keep converting every eligible amount, matching pre-F5 behavior.",
  );
});

// ---------------------------------------------------------------------
// F28: drawdown detection was English-only and substring-loose, causing
// two production failures — (a) a pour whose wording happened to mention
// "drain" absorbed the whole timing remainder instead of the recipe's
// actual final step, and (b) a synthetic English drawdown sentence got
// appended onto a German recipe that already had its own final step.
// ---------------------------------------------------------------------

Deno.test("does not let a pour step that merely mentions 'drain' absorb the drawdown remainder (F28a)", async () => {
  // Regression test for the exact production shape: a Chemex pour step
  // ("...avoid the filter walls, and let it drain almost completely")
  // matches the drawdown regex on the word "drain", but it is itself a
  // POUR that adds water (90g -> 350g), so by definition it cannot be the
  // drawdown — a drawdown only ever happens after the last pour. The
  // recipe's real final step ("...let it finish drawing down") only
  // matches once "drawing down" (an inflected form of "draw down") is
  // recognized by the regex; before the fix it did not match at all, so
  // the mislabeled pour absorbed the whole remainder instead.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Chemex",
    name: "Chemex Drain Regression",
    short_description:
      "Tests that a pour mentioning drain does not steal the drawdown role.",
    grind_size: "Medium-coarse",
    water_temp_celsius: 94,
    coffee_amount_grams: 30,
    water_amount: 500,
    preparation: "Rinse the filter and add the coffee.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with 90g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Pour up to 350g in the same spiral pattern, avoiding the filter walls, and let it drain almost completely.",
        duration_seconds: 176,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Pour the remaining water up to 500g total, keeping a steady pour.",
        duration_seconds: 19,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Stir gently, then swirl the brewer and let it finish drawing down.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 240,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 30,
      water_amount: 500,
      water_temp: 94,
    },
    localization: {
      name: "Chemex Drain Regression",
      grind_size: "Medium-coarse",
      short_description:
        "Tests that a pour mentioning drain does not steal the drawdown role.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add the coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom with 90g water for 45 seconds.",
        description_template:
          "Bloom with (0.18 x <final_water_amount>)g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Pour up to 350g in the same spiral pattern, avoiding the filter walls, and let it drain almost completely.",
        description_template:
          "Pour up to (0.7 x <final_water_amount>)g in the same spiral pattern, avoiding the filter walls, and let it drain almost completely.",
        duration_seconds: 176,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Pour the remaining water up to 500g total, keeping a steady pour.",
        description_template:
          "Pour the remaining water up to (1 x <final_water_amount>)g total, keeping a steady pour.",
        duration_seconds: 19,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Stir gently, then swirl the brewer and let it finish drawing down.",
        description_template:
          "Stir gently, then swirl the brewer and let it finish drawing down.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock Chemex recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "chemex", brewing_method: "Chemex" },
    ],
    requestId: "req-f28a",
  });

  // Bloom (anchored) stays 45; the "drain"-mentioning pour is estimated
  // from the water it itself adds (260g / 8g/s ~= 33s), NOT the 176s the
  // model originally guessed; the second pour is estimated from its own
  // 150g addition (~19s); and the real final step ("...drawing down",
  // which adds no water) absorbs the remainder: 240 - 45 - 33 - 19 = 143.
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 33, 19, 143],
    "Expected the 'drain'-mentioning pour to get a water-rate estimate instead of absorbing the remainder, and the true final step to absorb it instead.",
  );
  assert(
    result.draft.steps[2].duration_seconds <
      result.draft.steps[4].duration_seconds,
    "Expected the pour that merely mentions 'drain' to take less time than the step that actually performs the drawdown.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes(
        "split deterministically from the stated total brew time",
      )
    ),
    "Expected the deterministic split to be surfaced as a warning.",
  );
});

Deno.test("never appends a synthetic English drawdown step onto a non-English recipe (F28b)", async () => {
  // Regression test for the exact production shape: a German V60 recipe
  // whose steps carry explicit elapsed_seconds timestamps (Phase B fields,
  // not text regex parsing) already ends with its own final step,
  // "Vollständig durchlaufen lassen." ("let it finish draining
  // completely"). Before the fix, isDrawdownLikeStep only recognized
  // English wording, so hasDrawdownStep came back false and the synthesis
  // branch appended a SIXTH step reading "Wait for the complete
  // drawdown." in English — a German recipe must never gain an English
  // sentence. The final step here is explicitly ANCHORED
  // (duration_is_stated: true) so this test isolates the append-skipping
  // behavior itself: nothing about the split stage should touch it either.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "de",
    likely_brewing_method: "V60",
    name: "Deutsches V60 Rezept",
    short_description: "Testet die deutsche Drawdown-Erkennung.",
    grind_size: "Mittel",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Filter spülen und Kaffee hinzufügen.",
    steps: [
      {
        title: null,
        raw_text: "Gieße 50g Wasser auf.",
        duration_seconds: null,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Gieße auf 120g Wasser auf.",
        duration_seconds: null,
        elapsed_seconds: 45,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Gieße auf 180g Wasser auf.",
        duration_seconds: null,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Gieße auf 240g Wasser auf.",
        duration_seconds: null,
        elapsed_seconds: 135,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Gieße auf 300g Wasser auf.",
        duration_seconds: null,
        elapsed_seconds: 180,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Vollständig durchlaufen lassen.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    // Deliberately much larger than the natural end of the timestamped
    // sequence (180s + 10s = 190s) so that, pre-fix, the synthesis branch
    // would have fired and appended an English step absorbing ~100s.
    total_brew_time_seconds: 290,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "de",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Deutsches V60 Rezept",
      grind_size: "Mittel",
      short_description: "Testet die deutsche Drawdown-Erkennung.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Filter spülen und Kaffee hinzufügen.",
        description_template: "Filter spülen und Kaffee hinzufügen.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Gieße 50g Wasser auf.",
        description_template: "Gieße 50g Wasser auf.",
        duration_seconds: 0,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Gieße auf 120g Wasser auf.",
        description_template: "Gieße auf 120g Wasser auf.",
        duration_seconds: 45,
        elapsed_seconds: 45,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Gieße auf 180g Wasser auf.",
        description_template: "Gieße auf 180g Wasser auf.",
        duration_seconds: 45,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Gieße auf 240g Wasser auf.",
        description_template: "Gieße auf 240g Wasser auf.",
        duration_seconds: 45,
        elapsed_seconds: 135,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Gieße auf 300g Wasser auf.",
        description_template: "Gieße auf 300g Wasser auf.",
        duration_seconds: 45,
        elapsed_seconds: 180,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Vollständig durchlaufen lassen.",
        description_template: "Vollständig durchlaufen lassen.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Deutsches V60 Rezept",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f28b",
  });

  assertEquals(
    result.draft.steps.length,
    7,
    "Expected no synthetic step to be appended onto the German recipe.",
  );
  assertEquals(
    result.draft.steps.at(-1)?.description_template,
    "Vollständig durchlaufen lassen.",
    "Expected the recipe's own final step to keep its role as the last step.",
  );
  assertEquals(
    result.draft.steps.at(-1)?.duration_seconds,
    10,
    "Expected the existing final step's stated duration to survive untouched.",
  );
  assert(
    !result.draft.steps.some((step) =>
      /drawdown|wait for the complete/i.test(step.description_template)
    ),
    "Expected no English sentence to be injected into the German recipe.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    200,
    "Expected brew time to reflect only the recipe's own steps (45*4 + 10 + 10), not the unmet 290s target.",
  );
});

Deno.test("recognizes 'drawing down' as the drawdown step even when an earlier water-adding step matches 'drain' (F28c)", async () => {
  // Isolates requirement 3 (recognize the inflected "drawing down" form)
  // together with requirement 1 (a water-adding step can never be the
  // drawdown): the pour that mentions "drain" is excluded because it adds
  // water and reaches the recipe's full water amount, and the step that
  // actually says "drawing down" — NOT the true last derived step, which
  // has no drawdown wording at all — must be the one that absorbs the
  // remainder. If "drawing down" were not recognized, the split would
  // instead fall back to the last derived step ("Let it rest for a moment
  // and enjoy."), giving the wrong step the remainder.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Drawing Down Regression",
    short_description: "Tests recognition of the 'drawing down' wording.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with 50g water for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Pour up to 300g total, letting it drain slightly between pulses.",
        duration_seconds: 32,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Stir the bed, then let it finish drawing down.",
        duration_seconds: 73,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Let it rest for a moment and enjoy.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 150,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Drawing Down Regression",
      grind_size: "Medium",
      short_description: "Tests recognition of the 'drawing down' wording.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom with 50g water for 30 seconds.",
        description_template:
          "Bloom with (0.166667 x <final_water_amount>)g water for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Pour up to 300g total, letting it drain slightly between pulses.",
        description_template:
          "Pour up to (1 x <final_water_amount>)g total, letting it drain slightly between pulses.",
        duration_seconds: 32,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Stir the bed, then let it finish drawing down.",
        description_template: "Stir the bed, then let it finish drawing down.",
        duration_seconds: 73,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Let it rest for a moment and enjoy.",
        description_template: "Let it rest for a moment and enjoy.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f28c",
  });

  // Bloom (anchored) stays 30. The pour reaches the full 300g (adding
  // 250g on top of the 50g bloom) for a ~32s water-rate estimate. "Let it
  // rest for a moment and enjoy" — the true last derived step, but not a
  // drawdown match — gets the fixed 15s quick-action estimate like any
  // other non-water action. "Stir the bed, then let it finish drawing
  // down" is recognized via the new "drawing down" regex form and adds no
  // water, so it absorbs whatever remains: 150 - 30 - 32 - 15 = 73.
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 30, 32, 73, 15],
    "Expected the 'drawing down' step (not the actual last derived step) to absorb the remainder.",
  );
});

Deno.test("prefers the LAST drawdown-matching step over the first when both match (F28d)", async () => {
  // Isolates requirement 2 (prefer the last match, not the first). Two
  // non-water-adding derived steps both read as a drawdown by wording
  // ("draw down" and "serve"); the LAST one must absorb the remainder.
  // Before the fix, .find() picked the FIRST match, so this test's
  // expected order would be exactly reversed under the old code.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Last Match Wins Regression",
    short_description:
      "Tests that the last drawdown match wins, not the first.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 250,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with 40g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour up to 240g total.",
        duration_seconds: 25,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Let it draw down partway, about half the liquid clears.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Swirl the bed once more, then serve.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 200,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Last Match Wins Regression",
      grind_size: "Medium",
      short_description:
        "Tests that the last drawdown match wins, not the first.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom with 40g water for 45 seconds.",
        description_template:
          "Bloom with (0.16 x <final_water_amount>)g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour up to 240g total.",
        description_template:
          "Pour up to (0.96 x <final_water_amount>)g total.",
        duration_seconds: 25,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Let it draw down partway, about half the liquid clears.",
        description_template:
          "Let it draw down partway, about half the liquid clears.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Swirl the bed once more, then serve.",
        description_template: "Swirl the bed once more, then serve.",
        duration_seconds: 20,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f28d",
  });

  // Bloom (anchored) stays 45. The pour adds 200g (240-40) for a ~25s
  // water-rate estimate. Both "Let it draw down..." and "...then serve."
  // match the drawdown regex and add no water; the FIRST match ("Let it
  // draw down...") is treated as a normal non-water quick action (the
  // fixed 15s), and the LAST one ("...then serve.") absorbs whatever
  // remains: 200 - 45 - 25 - 15 = 115. Under the old .find()-based
  // first-match logic, this would be exactly reversed (the first match
  // would absorb the remainder instead).
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 25, 15, 115],
    "Expected the LAST drawdown-matching step to absorb the remainder, not the first.",
  );
});

// ---------------------------------------------------------------------
// F28 follow-up: removing the bogus appended English drawdown step
// exposed that it had been accidentally padding non-English recipes'
// timing. A live German V60 whose extraction left total_brew_time_seconds
// null — despite the source stating "Brühzeit: 2:30 - 3:30" — silently
// produced an 80s recipe (durations [0, 30, 30, 10, 10]) instead of the
// stated ~180s, because the regex fallback that mines a total out of
// narrowedText is English-only by design and cannot help for German. The
// fix is NOT to internationalize the regex (that path never ends); it is
// (1) telling the extraction LLM explicitly that a labelled total-time
// field is the same field in any language, and (2) warning the operator
// whenever a non-English recipe ends up with no resolved total so the
// short timing is visible instead of silent.
// ---------------------------------------------------------------------

function buildGermanNoTotalBrewTimeFixtures(
  totalBrewTimeSeconds: number | null,
): { extraction: ExtractionResult; normalized: NormalizedDraft } {
  const rawTexts = [
    "Gieße 50g Wasser auf und starte die Zeit.",
    "Gieße auf 150g Wasser auf.",
    "Gieße auf 300g Wasser auf.",
    "Vollständig durchlaufen lassen.",
  ];
  const startsTimer = [true, false, false, false];
  const elapsedSeconds: Array<number | null> = [0, 30, 60, null];
  // The model's own small guess for the untimed final step — deliberately
  // below MIN_BREW_STEP_DURATION_SECONDS so the "falls back to minimums"
  // wording in the warning is literally what happens when no target
  // resolves (enforceMinimumStepDurations bumps this up to 10).
  const rawDurations = [0, 30, 30, 5];

  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "de",
    likely_brewing_method: "V60",
    name: "Deutsches V60 Rezept ohne Brühzeit",
    short_description: "Testet die fehlende Brühzeit-Warnung.",
    grind_size: "Mittel",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Filter spülen und Kaffee hinzufügen.",
    steps: rawTexts.map((raw_text, index) => ({
      title: null,
      raw_text,
      duration_seconds: rawDurations[index],
      elapsed_seconds: elapsedSeconds[index],
      starts_timer: startsTimer[index],
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    })),
    notes: [],
    total_brew_time_seconds: totalBrewTimeSeconds,
  };

  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "de",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Deutsches V60 Rezept ohne Brühzeit",
      grind_size: "Mittel",
      short_description: "Testet die fehlende Brühzeit-Warnung.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Filter spülen und Kaffee hinzufügen.",
        description_template: "Filter spülen und Kaffee hinzufügen.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      ...rawTexts.map((raw_text, index) => ({
        kind: "brew" as const,
        description_source: raw_text,
        description_template: raw_text,
        duration_seconds: rawDurations[index],
        elapsed_seconds: elapsedSeconds[index],
        starts_timer: startsTimer[index],
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      })),
    ],
  };

  return { extraction, normalized };
}

Deno.test("warns instead of silently producing minimal durations when a non-English recipe has no extracted total brew time (F28e)", async () => {
  const { extraction, normalized } = buildGermanNoTotalBrewTimeFixtures(null);
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Deutsches V60 Rezept",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f28e-no-total",
  });

  // Matches the exact production shape: two timestamp-differenced 30s
  // steps, the last timestamped step falling back to the 10s terminal
  // default (no next timestamp to diff against), and the untimed final
  // step's own tiny guess (5s) bumped up to the 10s minimum — nothing
  // here is derived from a resolved target, because none resolved.
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 30, 30, 10, 10],
    "Expected no total-brew-time target to be resolved, so derived/terminal steps fall back to fixed defaults instead of being split from a target.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    80,
    "Expected brew time to reflect only the fallback minimums, reproducing the reported 80s under-brewed result.",
  );
  assert(
    result.warnings.includes(
      "No total brew time was extracted for a non-English recipe; step durations fall back to minimums and should be reviewed.",
    ),
    "Expected the operator-facing warning naming why the timing looks short, instead of silence.",
  );
});

Deno.test("splits correctly and does not warn when a non-English recipe's extraction supplies total_brew_time_seconds (F28f)", async () => {
  // Same shape as F28e, but as if the extraction stage had correctly
  // picked up "Brühzeit: 2:30 - 3:30" (midpoint 180s) per the updated
  // extraction prompt guidance.
  const { extraction, normalized } = buildGermanNoTotalBrewTimeFixtures(180);
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Deutsches V60 Rezept",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f28f-with-total",
  });

  // The two timestamp-DIFFERENCED steps (0:00->0:30, 0:30->1:00) are
  // genuinely anchored (30 each). defect-1: the third pour (elapsed 60s)
  // is the LAST timestamped step, so — unlike the first two — its
  // duration was never actually derived from two known timestamps, only
  // its start time was known. It is now correctly DERIVED and estimated
  // from the 150g it itself adds (150 -> 300g) at the ~8 g/s pour-rate
  // model (150 / 8 = 19s) instead of a flat 10s guess, and the untimed
  // final step ("Vollständig durchlaufen lassen") absorbs what remains of
  // the resolved 180s target: 180 - 30 - 30 - 19 = 101.
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 30, 30, 19, 101],
    "Expected the untimed final step to absorb the remainder of the resolved 180s target.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    180,
    "Expected brew time to land exactly on the resolved 180s target.",
  );
  assert(
    !result.warnings.includes(
      "No total brew time was extracted for a non-English recipe; step durations fall back to minimums and should be reviewed.",
    ),
    "Expected no missing-total-brew-time warning when extraction did supply a total.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes(
        "split deterministically from the stated total brew time",
      )
    ),
    "Expected the deterministic split to actually have run and be surfaced as a warning.",
  );
});

// ---------------------------------------------------------------------
// F10: max_completion_tokens was hardcoded to 2500 for every stage with no
// truncation detection and no same-provider retry, so an over-long
// response (materially more likely now that Phases B/B2/C added four new
// per-step fields) failed JSON.parse, abandoned the provider, and
// surfaced only "All providers failed during recipe normalization." with
// no indication of why.
// ---------------------------------------------------------------------

function buildMinimalValidExtractionPayload() {
  return {
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Token Limit Test",
    short_description: "Tests per-stage token ceilings.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 250,
    preparation: "Rinse the filter and add the coffee.",
    steps: [
      {
        title: null,
        raw_text: "Pour 250g of water and wait 180 seconds.",
        duration_seconds: 180,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function buildMinimalValidNormalizedPayload() {
  return {
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Token Limit Test",
      grind_size: "Medium",
      short_description: "Tests per-stage token ceilings.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add the coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 250g of water and wait 180 seconds.",
        description_template: "Pour 250g of water and wait 180 seconds.",
        duration_seconds: 180,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("F10: a truncated (finish_reason length) response produces a clearly-typed error naming the stage, provider, and model", async () => {
  let fetchCallCount = 0;
  const mockFetch: typeof fetch = (_input, _init) => {
    fetchCallCount += 1;
    // Deliberately unparsable as JSON — proves the truncation check fires
    // BEFORE any attempt to JSON.parse the (truncated) content, rather
    // than surfacing as an opaque parse error.
    return Promise.resolve(
      jsonResponse({
        choices: [
          {
            message: { content: '{"name": "Truncated recipe", "steps": [' },
            finish_reason: "length",
          },
        ],
        usage: { total_tokens: 8000 },
      }),
    );
  };

  const parser = createRecipeDraftParser({
    openAiApiKey: "test-key",
    fetchImpl: mockFetch,
    now: () => 1776000000000,
  });

  let caughtError: unknown = null;
  try {
    await parser.parseDraft({
      text: "Mock recipe",
      userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
      brewingMethods: [
        { brewing_method_id: "v60", brewing_method: "Hario V60" },
      ],
      requestId: "req-truncation",
    });
    throw new Error(
      "Expected parseDraft to reject when every attempt truncates.",
    );
  } catch (error) {
    caughtError = error;
  }

  assert(
    caughtError instanceof Error,
    "Expected a thrown Error when every provider attempt is truncated.",
  );
  const message = (caughtError as Error).message;
  assert(
    message.includes("extraction"),
    `Expected the final error to name the "extraction" stage. Got: ${message}`,
  );
  assert(
    /truncat/i.test(message),
    `Expected the final error to name truncation as the reason, not a generic parse failure. Got: ${message}`,
  );
  assert(
    message.includes("openai"),
    `Expected the final error to name the provider. Got: ${message}`,
  );
  // Phase E: with only openAiApiKey configured, the default cascade is now
  // openai@MEDIUM then openai@BIG (Groq/Cerebras removed from the default
  // list — see buildProviders). F10 retries each same provider exactly
  // once before falling through, so MEDIUM makes 2 calls, then BIG makes 2
  // more, for 4 total — not 2 (single-provider assumption from before
  // Phase E) and not repeated indefinitely.
  assertEquals(
    fetchCallCount,
    4,
    "Expected one same-provider retry each on openai MEDIUM and openai BIG before the stage is abandoned.",
  );
});

Deno.test("Phase E (Task 1): default provider list is openai MEDIUM, openai BIG, then gemini only — Groq/Cerebras keys are ignored", async () => {
  // Production evidence: openai/gpt-5.6-terra (MEDIUM) served 11/12 live
  // parses end-to-end; Groq's 8,000 TPM ceiling cannot structurally absorb
  // a single parse. Groq and Cerebras were removed from the DEFAULT
  // cascade (buildProviders without an injected config.providers). This
  // configures groqApiKey/cerebrasApiKey alongside openAiApiKey to prove
  // they're now ignored: every fetch call must be an openai call (proven
  // by requestedModels only ever containing MEDIUM/BIG), and the count
  // must stay at exactly 4 (2 retries each on MEDIUM then BIG) rather than
  // growing if Groq/Cerebras providers were still being appended.
  const requestedModels: string[] = [];
  const mockFetch: typeof fetch = (_input, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body));
    requestedModels.push(body.model);
    // Deliberately unparsable/truncated so every attempt fails and the
    // loop is forced to walk the ENTIRE default provider list.
    return Promise.resolve(
      jsonResponse({
        choices: [
          {
            message: { content: '{"name": "Truncated recipe", "steps": [' },
            finish_reason: "length",
          },
        ],
        usage: { total_tokens: 8000 },
      }),
    );
  };

  const parser = createRecipeDraftParser({
    openAiApiKey: "test-openai-key",
    groqApiKey: "test-groq-key",
    cerebrasApiKey: "test-cerebras-key",
    fetchImpl: mockFetch,
    now: () => 1776000000000,
  });

  let caughtError: unknown = null;
  try {
    await parser.parseDraft({
      text: "Mock recipe",
      userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
      brewingMethods: [
        { brewing_method_id: "v60", brewing_method: "Hario V60" },
      ],
      requestId: "req-default-provider-list",
    });
    throw new Error(
      "Expected parseDraft to reject when every attempt truncates.",
    );
  } catch (error) {
    caughtError = error;
  }

  assert(caughtError instanceof Error, "Expected a thrown Error.");
  assertEquals(
    requestedModels,
    [
      OPENAI_MODELS.MEDIUM,
      OPENAI_MODELS.MEDIUM,
      OPENAI_MODELS.BIG,
      OPENAI_MODELS.BIG,
    ],
    "Expected exactly MEDIUM (x2, same-provider retry) then BIG (x2) and nothing else — no groq/compound-mini, no openai/gpt-oss-20b, no cerebras model, confirming Groq/Cerebras keys no longer produce default providers.",
  );
});

Deno.test("F10: a provider that fails once then succeeds is retried on the SAME provider and its result is used", async () => {
  const calls: Array<{ stage: string; attempt: number }> = [];
  let normalizationAttempts = 0;
  const flakyThenRecoveringProvider: RecipeDraftAiProvider = {
    name: "groq",
    model: "groq/flaky-test-model",
    invokeJson<T>(input: { stage: string }) {
      if (input.stage === "extraction") {
        calls.push({ stage: "extraction", attempt: 1 });
        return Promise.resolve({
          result: createExtraction() as unknown as T,
          tokensUsed: 0,
        });
      }
      if (input.stage === "normalization") {
        normalizationAttempts += 1;
        calls.push({
          stage: "normalization",
          attempt: normalizationAttempts,
        });
        if (normalizationAttempts === 1) {
          return Promise.reject(
            new Error("transient truncation-shaped failure"),
          );
        }
        return Promise.resolve({
          result: createNormalized() as unknown as T,
          tokensUsed: 0,
        });
      }
      return Promise.reject(new Error(`unexpected stage ${input.stage}`));
    },
  };

  const parser = createRecipeDraftParser({
    providers: [flakyThenRecoveringProvider],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-retry-success",
  });

  assertEquals(
    result.provider_used,
    "groq",
    "Expected the same (only) provider to be used after recovering on retry — there is nothing to fall through to.",
  );
  assertEquals(
    calls,
    [
      { stage: "extraction", attempt: 1 },
      { stage: "normalization", attempt: 1 },
      { stage: "normalization", attempt: 2 },
    ],
    "Expected normalization to be retried exactly once on the SAME provider after its first (transient) failure, and for the retry's successful result to be used.",
  );
});

Deno.test("F10: extraction and normalization request their own per-stage max_completion_tokens ceilings", async () => {
  const requestedMaxTokens: number[] = [];
  let callIndex = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body));
    requestedMaxTokens.push(body.max_completion_tokens);
    callIndex += 1;
    const content = callIndex === 1
      ? JSON.stringify(buildMinimalValidExtractionPayload())
      : JSON.stringify(buildMinimalValidNormalizedPayload());
    return jsonResponse({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { total_tokens: 100 },
    });
  };

  const parser = createRecipeDraftParser({
    openAiApiKey: "test-key",
    fetchImpl: mockFetch,
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-token-limits",
  });

  assertEquals(
    requestedMaxTokens,
    [8000, 4000],
    "Expected extraction to request the 8000-token ceiling and normalization to request the 4000-token ceiling, not a single shared 2500 hardcoded for both.",
  );
  assertEquals(
    result.draft.localization.name,
    "Token Limit Test",
    "Expected the parse to actually succeed end-to-end using these responses.",
  );
});

Deno.test("F10: the final error names the normalization stage and underlying reason instead of a bare 'all providers failed' message", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        failNormalization: true,
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  let caughtError: unknown = null;
  try {
    await parser.parseDraft({
      text: "Mock recipe",
      userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
      brewingMethods: [
        { brewing_method_id: "v60", brewing_method: "Hario V60" },
      ],
      requestId: "req-normalization-error-detail",
    });
    throw new Error(
      "Expected parseDraft to reject when normalization fails on every provider.",
    );
  } catch (error) {
    caughtError = error;
  }

  assert(caughtError instanceof Error, "Expected a thrown Error.");
  const message = (caughtError as Error).message;
  assert(
    message.includes("normalization"),
    `Expected the error to name the normalization stage. Got: ${message}`,
  );
  assert(
    message.includes("groq normalization failed"),
    `Expected the error to include the underlying reason from the last attempt, not just the bare stage name. Got: ${message}`,
  );
});

// ---------------------------------------------------------------------
// Phase C3 (F29): step_role — role detection moved out of English-only
// regexes and into an extraction-labelled field, so a non-English step
// can be recognized as the bloom or the drawdown by what it DOES, not by
// which language it happens to be written in.
// ---------------------------------------------------------------------

Deno.test("reads step_role to identify the German drawdown step instead of letting the bloom absorb the remainder (F29)", async () => {
  // Regression test for the reported production defect: a German V60
  // recipe whose real drawdown step, "Vollständig durchlaufen lassen."
  // (let it drain completely), never matches the English-only
  // isDrawdownLikeStep regex ("draw down|drawdown|drain|serve"). Before
  // the fix, with no drawdown step identified, the two elapsed-timestamped
  // pours (0:30, 1:00) anchor themselves via elapsed_seconds, leaving the
  // bloom and the drawdown step as the only two DERIVED brew steps — and
  // because bloomIndex was resolved purely from a water-adding heuristic
  // (no scalable expression is present on the bloom step here), nothing
  // distinguished the bloom step from the drawdown step for the model's
  // own naive per-step estimate. step_role fixes this at the source: the
  // bloom step is labelled "bloom" and gets the fixed 45s nominal bloom
  // duration (not a naive guess), and the drawdown step is labelled
  // "drawdown" and is correctly identified via isDrawdownLikeStep's
  // role-first check, so it — not the bloom — absorbs the remainder of
  // the recipe's stated 180s total brew time.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "de",
    likely_brewing_method: "V60",
    name: "Deutsches V60 Rezept mit Rollen",
    short_description: "Testet die rollenbasierte Drawdown-Erkennung.",
    grind_size: "Mittel",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Filter spülen und Kaffee hinzufügen.",
    steps: [
      {
        title: null,
        raw_text: "Gieße 40g Wasser auf und lasse den Kaffee aufquellen.",
        duration_seconds: 50,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "Gieße bei 0:30 auf 200g Wasser auf.",
        duration_seconds: 40,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Gieße bei 1:00 auf 300g Wasser auf.",
        duration_seconds: 20,
        elapsed_seconds: 60,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Vollständig durchlaufen lassen.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 180,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "de",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Deutsches V60 Rezept mit Rollen",
      grind_size: "Mittel",
      short_description: "Testet die rollenbasierte Drawdown-Erkennung.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Filter spülen und Kaffee hinzufügen.",
        description_template: "Filter spülen und Kaffee hinzufügen.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source:
          "Gieße 40g Wasser auf und lasse den Kaffee aufquellen.",
        description_template:
          "Gieße 40g Wasser auf und lasse den Kaffee aufquellen.",
        duration_seconds: 50,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "Gieße bei 0:30 auf 200g Wasser auf.",
        description_template: "Gieße bei 0:30 auf 200g Wasser auf.",
        duration_seconds: 40,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Gieße bei 1:00 auf 300g Wasser auf.",
        description_template: "Gieße bei 1:00 auf 300g Wasser auf.",
        duration_seconds: 20,
        elapsed_seconds: 60,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Vollständig durchlaufen lassen.",
        description_template: "Vollständig durchlaufen lassen.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Deutsches V60 Rezept mit Rollen",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f29",
  });

  // The 0:30 -> 1:00 pour is genuinely timestamp-DIFFERENCED (30s, a real
  // interval between two known timestamps) and stays anchored. defect-1:
  // the 1:00 pour is the LAST timestamped step, so only its start time was
  // known, never its duration — it is now correctly DERIVED and estimated
  // from the ~100g it itself adds (200 -> 300g) at the ~8 g/s pour-rate
  // model (100 / 8 = 13s) instead of a flat 10s guess. The bloom (labelled
  // "bloom") still gets the fixed 45s nominal bloom duration instead of
  // the model's wrong 50s guess. The drawdown (labelled "drawdown",
  // correctly recognized despite being pure German text) absorbs whatever
  // is left: 180 - 30 - 13 - 45 = 92.
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 30, 13, 92],
    "Expected step_role to identify the bloom and the German drawdown step so the drawdown, not the bloom, absorbs the remainder.",
  );
  assert(
    result.draft.steps[1].duration_seconds <= 60,
    "Expected the bloom to stay a sane, short length instead of absorbing most of the total brew time.",
  );
  assert(
    result.draft.steps[4].duration_seconds >
      result.draft.steps[1].duration_seconds,
    "Expected the drawdown step to take longer than the bloom, not shorter.",
  );
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds).reduce(
      (sum, value) => sum + value,
      0,
    ),
    180,
    "Expected the brew step durations to sum to exactly the stated 180s total.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    180,
    "Expected brew time to land exactly on the stated 180s target.",
  );
});

Deno.test("F28 water-adding guard survives a step mislabelled step_role drawdown (F29)", async () => {
  // Same transcript as F28a ("does not let a pour step that merely
  // mentions 'drain' absorb the drawdown remainder"), but this time the
  // water-adding pour is ALSO (incorrectly) labelled step_role
  // "drawdown" — simulating a model mislabel. isDrawdownLikeStep now
  // reads step_role first, so without the F28 water-added guard staying
  // in place, this mislabel would make the water-adding pour win the
  // drawdown role outright. The guard in splitDerivedBrewStepDurationsFromTarget
  // — "(waterAddedByIndex[index] ?? 0) <= 0" — is applied before
  // isDrawdownLikeStep is ever consulted, so it must still exclude this
  // step regardless of its (mis)labelled role, leaving the true final
  // step (also labelled "drawdown", and the only one of the two that adds
  // no water) as the sole match. Expected numbers are therefore identical
  // to F28a's.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Chemex",
    name: "Chemex Drain Mislabel Regression",
    short_description:
      "Tests that a mislabelled water-adding step does not steal the drawdown role.",
    grind_size: "Medium-coarse",
    water_temp_celsius: 94,
    coffee_amount_grams: 30,
    water_amount: 500,
    preparation: "Rinse the filter and add the coffee.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with 90g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text:
          "Pour up to 350g in the same spiral pattern, avoiding the filter walls, and let it drain almost completely.",
        duration_seconds: 176,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        // Deliberately mislabelled: this step ADDS water (90g -> 350g), so
        // by definition it cannot be the drawdown, no matter what the
        // model labelled it.
        step_role: "drawdown",
      },
      {
        title: null,
        raw_text:
          "Pour the remaining water up to 500g total, keeping a steady pour.",
        duration_seconds: 19,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text:
          "Stir gently, then swirl the brewer and let it finish drawing down.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 240,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 30,
      water_amount: 500,
      water_temp: 94,
    },
    localization: {
      name: "Chemex Drain Mislabel Regression",
      grind_size: "Medium-coarse",
      short_description:
        "Tests that a mislabelled water-adding step does not steal the drawdown role.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add the coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Bloom with 90g water for 45 seconds.",
        description_template:
          "Bloom with (0.18 x <final_water_amount>)g water for 45 seconds.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source:
          "Pour up to 350g in the same spiral pattern, avoiding the filter walls, and let it drain almost completely.",
        description_template:
          "Pour up to (0.7 x <final_water_amount>)g in the same spiral pattern, avoiding the filter walls, and let it drain almost completely.",
        duration_seconds: 176,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
      {
        kind: "brew",
        description_source:
          "Pour the remaining water up to 500g total, keeping a steady pour.",
        description_template:
          "Pour the remaining water up to (1 x <final_water_amount>)g total, keeping a steady pour.",
        duration_seconds: 19,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source:
          "Stir gently, then swirl the brewer and let it finish drawing down.",
        description_template:
          "Stir gently, then swirl the brewer and let it finish drawing down.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock Chemex recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "chemex", brewing_method: "Chemex" },
    ],
    requestId: "req-f29-mislabel",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 33, 19, 143],
    "Expected the mislabelled water-adding step to still be excluded by the F28 guard, leaving the true final step to absorb the remainder — identical to F28a's unlabelled result.",
  );
  assert(
    result.draft.steps[2].duration_seconds <
      result.draft.steps[4].duration_seconds,
    "Expected the mislabelled pour to take less time than the step that actually performs the drawdown.",
  );
});

Deno.test("leaves drawdown detection unchanged when step_role is null throughout (F29)", async () => {
  // Reuses the F28c fixture verbatim, without any step_role field set on
  // any step (every step defaults to step_role: null). isDrawdownLikeStep
  // must fall back to exactly its pre-C3 English-only regex behavior in
  // this case, and splitDerivedBrewStepDurationsFromTarget's bloom
  // selection must fall back to the pre-C3 water-adding heuristic — so
  // the result must be byte-for-byte identical to what F28c already
  // asserts, proving the step_role feature is additive and does not
  // change behavior for a recipe (or provider) that has never heard of
  // it.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Drawing Down Null Role Regression",
    short_description:
      "Tests that null step_role throughout falls back to the pre-C3 regex.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with 50g water for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Pour up to 300g total, letting it drain slightly between pulses.",
        duration_seconds: 32,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Stir the bed, then let it finish drawing down.",
        duration_seconds: 73,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Let it rest for a moment and enjoy.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 150,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Drawing Down Null Role Regression",
      grind_size: "Medium",
      short_description:
        "Tests that null step_role throughout falls back to the pre-C3 regex.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Bloom with 50g water for 30 seconds.",
        description_template:
          "Bloom with (0.166667 x <final_water_amount>)g water for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Pour up to 300g total, letting it drain slightly between pulses.",
        description_template:
          "Pour up to (1 x <final_water_amount>)g total, letting it drain slightly between pulses.",
        duration_seconds: 32,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Stir the bed, then let it finish drawing down.",
        description_template: "Stir the bed, then let it finish drawing down.",
        duration_seconds: 73,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Let it rest for a moment and enjoy.",
        description_template: "Let it rest for a moment and enjoy.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f29-null-role",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 30, 32, 73, 15],
    "Expected identical output to the F28c fixture: with step_role null throughout, drawdown detection must fall back to the pre-C3 English-only regex unchanged.",
  );
});

Deno.test("does not append a synthetic drawdown step when an earlier step is already labelled step_role drawdown (F29)", async () => {
  // Isolates the new hasRoleDrawdownStep guard in
  // normalizeAbsoluteTimestampDurations. The recipe is English-like (so
  // the pre-existing F28 language gate does NOT itself block the
  // append), and its true last brew step adds water (so the F28
  // "last brew step already adds no water" guard does NOT block it
  // either) — every other precondition for the synthetic "Wait for the
  // complete drawdown." append is satisfied. The step that settles the
  // bed ("Let the bed settle for a moment.") carries elapsed_seconds
  // (it's the last timestamped step) so it sits before
  // lastTimestamped.index and is invisible to hasDrawdownStep's
  // positional scan; its wording also matches no drawdown keyword, so
  // the pre-C3 regex-only hasDrawdownStep also can't catch it. Only
  // step_role labels it as the drawdown, and only the new
  // hasRoleDrawdownStep guard — which scans every step regardless of
  // position or language — can therefore prevent the synthetic append.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Append Guard Regression",
    short_description:
      "Tests that a labelled drawdown step suppresses the synthetic append.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Add coffee to the brewer.",
    steps: [
      {
        title: null,
        raw_text: "Start the timer and pour water to bloom the coffee.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Pour to 180g total.",
        duration_seconds: 40,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Let the bed settle for a moment.",
        duration_seconds: 20,
        elapsed_seconds: 60,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
      {
        title: null,
        raw_text: "Pour a final splash of water over the bed.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: 200,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Append Guard Regression",
      grind_size: "Medium",
      short_description:
        "Tests that a labelled drawdown step suppresses the synthetic append.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add coffee to the brewer.",
        description_template: "Add coffee to the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Start the timer and pour water to bloom the coffee.",
        description_template:
          "Start the timer and pour water to bloom the coffee.",
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour to 180g total.",
        description_template: "Pour to (0.6 x <final_water_amount>)g total.",
        duration_seconds: 40,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Let the bed settle for a moment.",
        description_template: "Let the bed settle for a moment.",
        duration_seconds: 20,
        elapsed_seconds: 60,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
      {
        kind: "brew",
        description_source: "Pour a final splash of water over the bed.",
        description_template:
          "Pour a final (0.7 x <final_water_amount>)g splash of water over the bed.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f29-append-guard",
  });

  assertEquals(
    result.draft.steps.length,
    5,
    "Expected no synthetic drawdown step to be appended when an earlier step is already labelled step_role drawdown.",
  );
  assert(
    !result.draft.steps.some((step) =>
      /wait for the complete drawdown/i.test(step.description_template)
    ),
    "Expected no synthetic 'Wait for the complete drawdown.' sentence to be injected.",
  );
});

// ---------------------------------------------------------------------
// F31: computeBrewStepWaterAddedAmounts looked ONLY for a
// <final_water_amount> expression, so a bloom/pour step phrased as a
// multiple of the coffee dose ("three times the dose, five times the
// dose, eight times the dose" -- an entirely ordinary way to narrate a
// pour schedule, see the Kalita fixture) registered as adding NO water.
// That routed the step to the flat 15s DERIVED_STIR_SECONDS estimate
// instead of the pour-rate estimate, and starved/inflated later
// cumulative math -- the same "flat quick-action where a pour-rate
// estimate belongs" shape as the historical [0, 45, 217, 10] Chemex bug.
// ---------------------------------------------------------------------

Deno.test("a fully dose-phrased pour schedule gets pour-rate durations instead of flat 15s stirs (F31)", async () => {
  // Every scalable step here is phrased as a multiple of the coffee dose,
  // exactly the shape the reported bug targets: bloom 3x, pour 5x, pour
  // 8x, on a 50g dose -- cumulative 150g / 250g / 400g. With the bug,
  // computeBrewStepWaterAddedAmounts would see no <final_water_amount>
  // expression anywhere and mark both pours as adding no water, so both
  // would fall back to the flat 15s stir estimate and the drawdown would
  // swallow the entire remaining 170s. Fixed, each pour must instead
  // reflect the water it actually adds: pour 1 adds 250-150=100g
  // (ceil(100/8)=13s), pour 2 adds 400-250=150g (ceil(150/8)=19s), and
  // the drawdown absorbs only the true leftover.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Kalita Wave",
    name: "Fully Dose-Phrased Pour Schedule",
    short_description: "Every scalable step is stated as a dose multiple.",
    grind_size: "Medium-fine",
    water_temp_celsius: 93,
    coffee_amount_grams: 50,
    water_amount: 400,
    preparation: "Add the coffee to the filter.",
    steps: [
      {
        title: null,
        raw_text: "Bloom to three times the dose.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 150, unit: "g" }],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "Pour to five times the dose.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 250, unit: "g" }],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Pour to eight times the dose.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 400, unit: "g" }],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Let it draw down completely.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 200,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "kalita",
      brewing_method_confidence: "high",
      coffee_amount: 50,
      water_amount: 400,
      water_temp: 93,
    },
    localization: {
      name: "Fully Dose-Phrased Pour Schedule",
      grind_size: "Medium-fine",
      short_description: "Every scalable step is stated as a dose multiple.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add the coffee to the filter.",
        description_template: "Add the coffee to the filter.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Bloom to three times the dose.",
        description_template: "Bloom to (3 x <final_coffee_amount>)g.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 150, unit: "g" }],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "Pour to five times the dose.",
        description_template: "Pour to (5 x <final_coffee_amount>)g.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 250, unit: "g" }],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Pour to eight times the dose.",
        description_template: "Pour to (8 x <final_coffee_amount>)g.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 400, unit: "g" }],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Let it draw down completely.",
        description_template: "Let it draw down completely.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({ name: "groq", extraction, normalized, calls: [] }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock fully dose-phrased recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "kalita", brewing_method: "Kalita Wave" },
    ],
    requestId: "req-f31-fully-dose-phrased",
  });

  const durations = result.draft.steps.map((step) => step.duration_seconds);
  assertEquals(
    durations,
    [0, 45, 13, 19, 123],
    "Expected the bloom to keep its fixed 45s, each dose-phrased pour to get a pour-rate-based duration (100g added -> 13s, 150g added -> 19s at 8 g/s), and the drawdown to absorb only the true 123s remainder.",
  );
  assert(
    durations[2] !== 15 && durations[3] !== 15,
    "Expected neither dose-phrased pour to fall back to the flat 15s DERIVED_STIR_SECONDS quick-action estimate.",
  );
  assertEquals(
    durations.reduce((sum, value) => sum + value, 0),
    200,
    "Expected the derived brew step durations to still sum exactly to the stated 200s total.",
  );
});

Deno.test("a dose-phrased bloom followed by a water-phrased pour computes the pour's delta from the real baseline, not from zero (F31)", async () => {
  // Mixed case from the bug report: bloom is dose-phrased (3 x dose = 75g
  // on a 25g dose), the pour that follows is water-phrased (up to the
  // final 200g). Before the fix, the dose-phrased bloom registered as
  // adding no water at all (null), so previousCumulative was never
  // advanced past 0 -- the water-phrased pour then computed its delta as
  // 200 - 0 = 200g (ceil(200/8) = 25s) instead of the physically correct
  // 200 - 75 = 125g (ceil(125/8) = 16s). Assert the fixed, smaller value.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Dose Bloom Then Water Pour",
    short_description: "Dose-phrased bloom, water-phrased final pour.",
    grind_size: "Medium",
    water_temp_celsius: 94,
    coffee_amount_grams: 25,
    water_amount: 200,
    preparation: "Add the coffee to the filter.",
    steps: [
      {
        title: null,
        raw_text: "Bloom to three times the dose.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 75, unit: "g" }],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "Pour up to 200g total.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 200, unit: "g" }],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Let it draw down completely.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 91,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 25,
      water_amount: 200,
      water_temp: 94,
    },
    localization: {
      name: "Dose Bloom Then Water Pour",
      grind_size: "Medium",
      short_description: "Dose-phrased bloom, water-phrased final pour.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add the coffee to the filter.",
        description_template: "Add the coffee to the filter.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Bloom to three times the dose.",
        description_template: "Bloom to (3 x <final_coffee_amount>)g.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 75, unit: "g" }],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "Pour up to 200g total.",
        description_template: "Pour up to (1 x <final_water_amount>)g total.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 200, unit: "g" }],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Let it draw down completely.",
        description_template: "Let it draw down completely.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({ name: "groq", extraction, normalized, calls: [] }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock mixed dose/water recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-f31-mixed-baseline",
  });

  const durations = result.draft.steps.map((step) => step.duration_seconds);
  assertEquals(
    durations,
    [0, 45, 16, 30],
    "Expected the water-phrased pour's delta to be computed from the real 75g baseline (200-75=125g added, ceil(125/8)=16s), not from zero (which would give 200-0=200g, ceil(200/8)=25s).",
  );
  assert(
    durations[2] !== 25,
    "Expected the pour to NOT be computed against a stale zero baseline (that would produce 25s instead of 16s).",
  );
  assertEquals(
    durations.reduce((sum, value) => sum + value, 0),
    91,
    "Expected the derived brew step durations to still sum exactly to the stated 91s total.",
  );
});

Deno.test("a stir step that mentions the coffee dose is not counted as adding water (F31)", async () => {
  // step_role "stir" is neither "bloom" nor "pour", so per the fix a
  // coffee-dose expression on it must NOT be treated as a water signal --
  // even though the step's wording happens to reference the dose. The
  // stir step must keep the flat 15s DERIVED_STIR_SECONDS quick-action
  // estimate, and must not disturb the running water total used by the
  // real water-phrased pour that precedes it.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Stir Mentions Dose Regression",
    short_description: "A stir step references the dose but adds no water.",
    grind_size: "Medium",
    water_temp_celsius: 94,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Add the coffee to the filter.",
    steps: [
      {
        title: null,
        raw_text: "Bloom to two times the dose.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 40, unit: "g" }],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "Pour up to 300g total.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 300, unit: "g" }],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Stir gently, about as many turns as grams in your dose.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 20, unit: "g" }],
        step_role: "stir",
      },
      {
        title: null,
        raw_text: "Let it draw down completely.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 113,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 94,
    },
    localization: {
      name: "Stir Mentions Dose Regression",
      grind_size: "Medium",
      short_description: "A stir step references the dose but adds no water.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Add the coffee to the filter.",
        description_template: "Add the coffee to the filter.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Bloom to two times the dose.",
        description_template: "Bloom to (2 x <final_coffee_amount>)g.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 40, unit: "g" }],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "Pour up to 300g total.",
        description_template: "Pour up to (1 x <final_water_amount>)g total.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 300, unit: "g" }],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source:
          "Stir gently, about as many turns as grams in your dose.",
        description_template:
          "Stir gently, about (1 x <final_coffee_amount>)g many turns as grams in your dose.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 20, unit: "g" }],
        step_role: "stir",
      },
      {
        kind: "brew",
        description_source: "Let it draw down completely.",
        description_template: "Let it draw down completely.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({ name: "groq", extraction, normalized, calls: [] }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock stir-mentions-dose recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-f31-stir-not-water",
  });

  const durations = result.draft.steps.map((step) => step.duration_seconds);
  assertEquals(
    durations,
    [0, 45, 33, 15, 20],
    "Expected the stir step to keep the flat 15s quick-action estimate (its dose-mention must not register as water), the pour to reflect its real 260g added (300-40, ceil(260/8)=33s), and the drawdown to absorb only the true remainder.",
  );
  assertEquals(
    durations[3],
    15,
    "Expected the stir step's duration to stay the flat 15s DERIVED_STIR_SECONDS estimate, proving its coffee-dose expression was not counted as adding water.",
  );
  assertEquals(
    durations.reduce((sum, value) => sum + value, 0),
    113,
    "Expected the derived brew step durations to still sum exactly to the stated 113s total.",
  );
});

// ---------------------------------------------------------------------
// Defect 1 (Aug 2026 live pass): a brew-step coffee dose with no nearby
// English coffee/water keyword used to resolve against the WATER base —
// stepKind === "brew" fell through both keyword-distance checks (both
// null) straight to a hardcoded "default to water" branch. Reproduced
// live via a German step "15 g Kaffee zugeben und umruehren." (coffee_
// amount 15, water_amount 250) that came back as
// "(0.06 x <final_water_amount>)g" — arithmetically right at THIS
// recipe's ratio (0.06 x 250 = 15) but semantically wrong: a user who
// changes only the dose gets a step that doesn't track it, and a user who
// changes only the water silently changes the stated coffee mass.
// resolveAmountPlaceholder now checks the amount against the recipe's own
// coffee_amount/water_amount FIRST — a language-agnostic, structural
// signal — before any (English-only) keyword matching.
// ---------------------------------------------------------------------

function createCoffeeDoseAcrossLanguagesNormalized(args: {
  language: string;
  coffeeStepSource: string;
  waterStepSource: string;
}): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: args.language,
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Defect 1 fixture",
      grind_size: "Medium",
      short_description:
        "Tests coffee-amount base resolution across languages.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Prepare the brewer.",
        description_template: "Prepare the brewer.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: args.coffeeStepSource,
        description_template: args.coffeeStepSource,
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: args.waterStepSource,
        description_template: args.waterStepSource,
        duration_seconds: 60,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

async function runCoffeeDoseAcrossLanguagesCase(args: {
  language: string;
  coffeeStepSource: string;
  waterStepSource: string;
  requestId: string;
}) {
  const normalized = createCoffeeDoseAcrossLanguagesNormalized(args);
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  return parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: args.requestId,
  });
}

Deno.test("resolves a German brew-step coffee dose to the coffee base, not water, and keeps a genuine water amount on water (F1 defect 1, live repro)", async () => {
  const result = await runCoffeeDoseAcrossLanguagesCase({
    language: "de",
    coffeeStepSource: "15 g Kaffee zugeben und umruehren.",
    waterStepSource: "250 g Wasser eingiessen.",
    requestId: "req-defect1-de",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "(1 x <final_coffee_amount>)g Kaffee zugeben und umruehren.",
    "Expected the German coffee dose to scale against the coffee base, not water.",
  );
  assertEquals(
    result.draft.steps[2].description_template,
    "(1 x <final_water_amount>)g Wasser eingiessen.",
    "Expected a genuine water amount in the same recipe to still resolve to the water base.",
  );
});

Deno.test("resolves an English brew-step coffee dose to the coffee base (F1 defect 1)", async () => {
  const result = await runCoffeeDoseAcrossLanguagesCase({
    language: "en",
    coffeeStepSource: "Add 15 g coffee and stir.",
    waterStepSource: "Pour 250 g water in.",
    requestId: "req-defect1-en",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Add (1 x <final_coffee_amount>)g coffee and stir.",
    "Expected the English coffee dose to scale against the coffee base, not water.",
  );
});

Deno.test("resolves a French brew-step coffee dose to the coffee base (F1 defect 1)", async () => {
  const result = await runCoffeeDoseAcrossLanguagesCase({
    language: "fr",
    coffeeStepSource: "Ajoutez 15 g de café et remuez.",
    waterStepSource: "Versez 250 g d'eau.",
    requestId: "req-defect1-fr",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Ajoutez (1 x <final_coffee_amount>)g de café et remuez.",
    "Expected the French coffee dose to scale against the coffee base, not water.",
  );
});

Deno.test("resolves a Spanish brew-step coffee dose to the coffee base (F1 defect 1)", async () => {
  const result = await runCoffeeDoseAcrossLanguagesCase({
    language: "es",
    coffeeStepSource: "Añada 15 g de café y revuelva.",
    waterStepSource: "Vierta 250 g de agua.",
    requestId: "req-defect1-es",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Añada (1 x <final_coffee_amount>)g de café y revuelva.",
    "Expected the Spanish coffee dose to scale against the coffee base, not water.",
  );
});

// ---------------------------------------------------------------------
// Defect 3 (Aug 2026 live pass): live Russian output rendered "20гг" and
// "60 млмл" — a unit appearing twice. Reproduced and root-caused (not
// guessed) to NESTED_PLACEHOLDER_EXPRESSION_REGEX inside
// normalizeExpressionLikeMath: when a malformed nested expression carried
// the SAME trailing unit both right after the inner placeholder's closing
// paren and right after the outer one (e.g. a model-produced
// "(1 x (0.2 x <final_water_amount>)мл)мл"), the regex previously
// consumed only the FIRST "мл", leaving the second sitting unconsumed
// right after the replacement text — a stray ")мл" that reached rendered
// preview text as a doubled unit. This mechanism is language-agnostic (an
// equivalent English "...)ml)ml" input reproduces identically); Cyrillic
// is used here to match the live report. description_source is set to
// the SAME malformed text as description_template to reproduce the
// worst case — a verify-mode round-trip on an already-corrupted stored
// step, where the description_source fallback candidate used to be
// equally invalid and could not rescue the output.
// ---------------------------------------------------------------------
Deno.test("collapses a malformed nested expression's duplicated trailing unit instead of leaking it into rendered text (F1 defect 3, live repro mechanism)", async () => {
  const malformedStep = "Долейте (1 x (0.2 x <final_water_amount>)мл)мл воды.";
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "ru",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "Defect 3 fixture",
      grind_size: "Medium",
      short_description: "Tests malformed nested-expression unit collapse.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Подготовка.",
        description_template: "Подготовка.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: malformedStep,
        description_template: malformedStep,
        duration_seconds: 30,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-defect3-nested-dup-unit",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Долейте (0.2 x <final_water_amount>)мл воды.",
    "Expected the duplicated 'мл' left over from the malformed nested expression to collapse to a single unit.",
  );
  assertEquals(
    result.draft.steps[1].preview_text,
    "Долейте 60 мл воды.",
    "Expected preview text to render a single unit, never 'млмл'.",
  );
  assert(
    !result.draft.steps[1].description_template.includes("млмл") &&
      !result.draft.steps[1].preview_text.includes("млмл"),
    "Expected no doubled 'млмл' unit anywhere in the output.",
  );
});

// ---------------------------------------------------------------------
// Defect 4 (Aug 2026 live pass): a cold brew recipe whose source
// explicitly describes cold/room-temperature water was still assigned
// water_temp 93 — the repair stage's system prompt told the model to
// infer 93/96/100 from the brewing method whenever water_temp was
// unstated, mapping "French press or immersion" to 100/93 without
// carving out an exception for cold brew (which IS immersion). There is
// no water_temp default anywhere in deterministic code (grep confirms
// "93" appears nowhere else in parser.ts) — the fix lives entirely in
// buildRepairSystemPrompt's text, so it is asserted two ways here: (1)
// the exact system prompt text sent to the repair stage now carries the
// cold/iced/room-temperature/cold-brew exception, so a future edit that
// silently drops it fails this test; and (2) a repair mock that responds
// the way a compliant model now should (returning water_temp: null for
// an explicitly cold-brew source) round-trips as null, not a hot
// fabricated number, proving nothing downstream re-defaults it — a null
// water_temp is a reviewable validation issue, not a crash (Phase A).
// ---------------------------------------------------------------------
Deno.test("cold-brew repair prompt rules out the hot water_temp default, and a compliant response stays null (F1 defect 4)", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const systemPrompts: Array<
    { provider: string; stage: string; systemPrompt: string }
  > = [];

  const coldBrewText =
    "Cold brew: steep coarsely ground coffee in room-temperature water for 18 hours, then strain.";

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          likely_brewing_method: "Cold Brew",
          water_temp_celsius: null,
        },
        normalized: {
          ...createNormalized(),
          detected_input_language: "en",
          recipe: {
            ...createNormalized().recipe,
            water_temp: null,
          },
        },
        repair: {
          ...createRepairNormalized(),
          recipe: {
            ...createRepairNormalized().recipe,
            water_temp: null,
          },
        },
        calls,
        systemPrompts,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: coldBrewText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-defect4-cold-brew",
  });

  const repairPrompt = systemPrompts.find((entry) => entry.stage === "repair");
  assert(
    repairPrompt !== undefined,
    "Expected the repair stage to run since water_temp was left null after normalization.",
  );
  assert(
    /cold brew/i.test(repairPrompt!.systemPrompt) &&
      /(cold|iced|room-temperature)/i.test(repairPrompt!.systemPrompt),
    "Expected the repair system prompt to carry an explicit cold/iced/room-temperature/cold-brew exception to the hot water_temp default.",
  );
  assertEquals(
    result.draft.recipe.water_temp,
    null,
    "Expected water_temp to stay null for an explicitly cold-brew recipe instead of defaulting to a hot temperature like 93.",
  );
  assert(
    result.validation.issues.some((issue) =>
      issue.field === "recipe.water_temp"
    ),
    "Expected the null water_temp to surface as a reviewable validation issue rather than fail silently.",
  );
});

// ---------------------------------------------------------------------
// G22: end-to-end provenance verification through the real parser
// pipeline (createRecipeDraftParser + stub providers), not just
// provenance.ts in isolation. See provenance_test.ts for the unit-level
// coverage of verifyAmountProvenance itself.
// ---------------------------------------------------------------------

const G22_REQUEST_TEXT =
  "Rinse the filter and add 15g of coffee. Pour 25g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";

// createNormalized()'s literal "(15)g"/"25g"/"250g" text amounts all get
// deterministically converted into scalable expressions by
// convertNumericValuesToExpressions's regex-only fallback (since
// scalable_amounts is empty), so all three render as amounts that need
// their own provenance record: coffee_amount_grams (step 0), the bloom
// (step 1), and the running water total (step 2).
const G22_BASE_AMOUNTS = [
  {
    value: 15,
    unit: "g",
    step_index: 0,
    provenance: "literal" as const,
    source_quote: "15g",
    rule: null,
    rule_source_quote: null,
    rule_inputs: null,
  },
  {
    value: 250,
    unit: "g",
    step_index: 2,
    provenance: "literal" as const,
    source_quote: "250g",
    rule: null,
    rule_source_quote: null,
    rule_inputs: null,
  },
];

Deno.test("G22 + F32: an extraction-recorded 25 g bloom that would render as 60 g is self-repaired to 25 g and stays publishable", async () => {
  // F32: this scenario used to be a hard block (see the prior version of
  // this test, before F32) — the source recorded 25g but the normalized
  // step rendered 60g, and G22 had no way to reconcile them, so it flagged
  // unverifiable_amount and left it for a human to fix by hand.
  //
  // F32 adds a deterministic repair pass that runs BEFORE G22's check: the
  // extraction stage's own literal record (25g, source_quote "25g", which
  // appears verbatim in G22_REQUEST_TEXT) IS a reliable, source-traceable
  // number, so the parser now recomputes the rendered amount from it
  // directly rather than requiring a human to notice and correct the
  // mismatch. The draft becomes publishable, with a warning documenting
  // exactly what was changed and why, rather than being blocked outright.
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          // Recorded correctly against the source text below — only the
          // NORMALIZED step (rendered to the user) disagrees with it.
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              value: 25,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "25g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              // Bug under test: the source said 25g, this renders 60g.
              // convertNumericValuesToExpressions deterministically turns
              // this literal "60g" into a scalable water expression before
              // F32's repair pass ever runs, exactly like it would for a
              // model-authored malformed placeholder expression.
              description_template: "Pour 60g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: G22_REQUEST_TEXT,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-g22-mismatch",
  });

  assert(
    !result.validation.issues.some((issue) => issue.code === "unverifiable_amount"),
    "Expected F32's repair to resolve the mismatch before G22 ever sees it.",
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected the repaired 25g rendering (now matching the recorded literal) to be publishable.",
  );
  assert(
    result.publish_projection !== undefined,
    "Expected a publish_projection once the repair resolves the only blocking issue.",
  );
  const bloomStep = result.draft.steps[1];
  assert(
    bloomStep.expressions.some((expression) => expression.preview_value === 25),
    `Expected the bloom step's expression to preview as 25g after repair, got: ${
      JSON.stringify(bloomStep.expressions)
    }`,
  );
  assert(
    !bloomStep.preview_text.includes("60"),
    `Expected the repaired bloom step to no longer render 60g, got: ${bloomStep.preview_text}`,
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("F32 repair") && warning.includes("25") &&
      warning.includes("60")
    ),
    `Expected a warning documenting the repair from 60g to 25g, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("G22: an extraction-recorded amount that matches what renders stays publishable", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              value: 25,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "25g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              // Matches the recorded 25g exactly.
              description_template: "Pour 25g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: G22_REQUEST_TEXT,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-g22-match",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "unverifiable_amount" ||
      issue.code === "amount_provenance_mismatch" ||
      issue.code === "unsupported_derivation_rule" ||
      issue.code === "inferred_amount_not_permitted" ||
      issue.code === "amount_step_binding_mismatch" ||
      issue.code === "non_monotonic_cumulative"
    ),
    "Expected no provenance-related validation issue when the rendered amount matches what was recorded.",
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a draft whose rendered amounts match their recorded provenance to stay publishable.",
  );
  assert(
    result.publish_projection !== undefined,
    "Expected a publish_projection once nothing blocks the draft.",
  );
});

Deno.test("G22: empty extracted_amounts degrades to one compatibility warning and stays publishable", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        // createExtraction()/createNormalized() both default
        // extracted_amounts to [] — the shape a provider that ignores the
        // G22 fields entirely would return.
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: G22_REQUEST_TEXT,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-g22-empty",
  });

  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected an empty extracted_amounts array to degrade to a warning, never block publishing.",
  );
  assert(
    result.publish_projection !== undefined,
    "Expected a publish_projection since nothing blocks this draft.",
  );
  const provenanceWarnings = result.warnings.filter((warning) =>
    warning.includes("Amount provenance could not be verified")
  );
  assertEquals(
    provenanceWarnings.length,
    1,
    "Expected exactly one compatibility warning, not zero and not one per amount.",
  );
});

Deno.test("Fix 1: extraction using concentration_water_from_coffee (not concentration) for a derived water amount recomputes correctly and stays publishable (Chemex-shaped, live incident)", async () => {
  // Live captures 5ee85b7e-6f38-4dbd-a19c-4700c3b166f0 and
  // ffd6a248-973c-4940-b160-f96e2d50f8d1 (Chemex, "60 grams per liter", 30g
  // coffee, 500ml water) both blocked with "500g does not match its stated
  // derivation 'concentration', which yields 30." — the extraction stage
  // recorded the WATER amount with rule "concentration" and fed its own
  // 500 back in as rule_inputs.millilitres, which is self-referential and
  // definitionally wrong: 'concentration' only ever derives a COFFEE mass
  // (grams_per_litre/1000 * millilitres), so recomputing gave 30, not 500,
  // and G22 correctly flagged the mismatch. The fix adds
  // 'concentration_water_from_coffee' to the extraction prompt's rule list
  // (AMOUNT_PROVENANCE_PROMPT_RULES) so a water amount derived from a dose
  // and a stated concentration gets the rule that actually solves in that
  // direction.
  //
  // This test is necessarily incomplete as coverage: createMockProvider
  // returns a canned object regardless of what the system prompt says, so
  // nothing here can prove a live model now reliably picks
  // concentration_water_from_coffee over concentration — that is prompt
  // behaviour, only confirmable against live/replayed traffic. What this
  // DOES prove deterministically: once extraction emits the correctly
  // shaped record (rule "concentration_water_from_coffee", rule_inputs {
  // grams_per_litre, coffee_grams }, nothing self-referential), the rest of
  // the pipeline — schema acceptance of the new rule string, carry-through
  // into the final draft, and G22's own recomputation
  // (provenance.ts's concentration_water_from_coffee case) — accepts it
  // and does not block the draft.
  const calls: Array<{ provider: string; stage: string }> = [];
  const requestText =
    "Rinse the filter and add 15g of coffee. Pour 50g of water and bloom for 30 seconds. Use a ratio of 60 grams per liter. Pour to 250g total and wait 90 seconds.";

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            {
              value: 15,
              unit: "g",
              step_index: 0,
              provenance: "literal",
              source_quote: "15g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
            {
              value: 50,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "50g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
            {
              value: 250,
              unit: "g",
              step_index: 2,
              provenance: "derived",
              source_quote: null,
              // The fix under test: NOT "concentration" (which would be
              // self-referential here, since 250 is the water figure being
              // justified, not a coffee mass), and rule_inputs holds only
              // the OTHER two facts (the ratio and the dose), never the
              // water value itself.
              rule: "concentration_water_from_coffee",
              rule_source_quote: "60 grams per liter",
              rule_inputs: { grams_per_litre: 60, coffee_grams: 15 },
            },
          ],
        },
        normalized: createNormalized(),
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    // Matches createExtraction()/createNormalized()'s default
    // brewing_method_id ("v60") so brewing-method resolution — an
    // unrelated concern to this test — does not itself block the draft.
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-fix1-concentration-water-from-coffee",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "amount_provenance_mismatch" ||
      issue.code === "unsupported_derivation_rule" ||
      issue.code === "unverifiable_amount"
    ),
    `Expected concentration_water_from_coffee (15g coffee at 60 g/L -> 250ml) to recompute cleanly and raise no G22 finding, got: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a correctly-shaped concentration_water_from_coffee record to keep the draft publishable.",
  );
});

// ---------------------------------------------------------------------
// F32 — deterministic multiplier repair against literal provenance. See
// repairExpressionMultipliersAgainstLiteralProvenance in parser.ts: the
// normalization/repair LLM's prompt lists example scalable-quantity
// placeholders ("(0.2 x <final_water_amount>)g" etc.) to illustrate the
// EXPRESSION SHAPE, but live traffic showed the model copying those exact
// numbers onto whichever step it pattern-matched instead of computing its
// own multiplier — e.g. a source-stated 40g bloom against a 300g water
// target rendered as "(0.2 x <final_water_amount>)g" (80g) instead of the
// correct "(0.133333 x <final_water_amount>)g" (40g), even though the
// extraction stage's own extracted_amounts already recorded 40g as a
// literal value. These tests exercise the deterministic repair pass
// through the full pipeline, the same way every other pass in this file
// is tested.
// ---------------------------------------------------------------------

function createF32Extraction(
  overrides: { coffeeAmount: number; waterAmount: number },
): ExtractionResult {
  return {
    ...createExtraction(),
    coffee_amount_grams: overrides.coffeeAmount,
    water_amount: overrides.waterAmount,
  };
}

function createF32Normalized(
  overrides: { coffeeAmount: number; waterAmount: number },
): NormalizedDraft {
  const base = createNormalized();
  return {
    ...base,
    recipe: {
      ...base.recipe,
      coffee_amount: overrides.coffeeAmount,
      water_amount: overrides.waterAmount,
    },
  };
}

Deno.test("F32: a bloom rendered with a copied example multiplier is repaired to the literal source value, with a warning", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
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
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              // Bug under test: the model copied the prompt's own example
              // multiplier (0.2) instead of computing 40/300.
              description_template:
                "Pour (0.2 x <final_water_amount>)جرام water and bloom.",
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 20g of coffee. Add 40 جرام water and bloom. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f32-copied-example",
  });

  const bloomStep = result.draft.steps[1];
  assertEquals(
    bloomStep.description_template,
    "Pour (0.133333 x <final_water_amount>)جرام water and bloom.",
    "Expected the copied 0.2 multiplier to be recomputed to 40/300 = 0.133333.",
  );
  assert(
    bloomStep.expressions.some((expression) =>
      expression.preview_value === 40
    ),
    `Expected the repaired expression to preview as 40, got: ${
      JSON.stringify(bloomStep.expressions)
    }`,
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("F32 repair") && warning.includes("0.2") &&
      warning.includes("0.133333")
    ),
    `Expected a warning naming the old (0.2) and new (0.133333) multipliers, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("F32: a range rendered as two identical copied-example expressions is repaired to two different values (Chemex shape)", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 30,
    waterAmount: 500,
  });
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 30, waterAmount: 500 }),
          extracted_amounts: [
            {
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "60 g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
            {
              value: 90,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "90 g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              // Bug under test: BOTH range endpoints copied the same 0.2
              // example multiplier, collapsing a 60-90g range down to a
              // single repeated value — the live Chemex "100-100 g" shape.
              description_template:
                "Add (0.2 x <final_water_amount>)g to (0.2 x <final_water_amount>)g water to bloom.",
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 30g of coffee. Add 60 g to 90 g water to bloom. Pour to 500g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f32-range",
  });

  const bloomStep = result.draft.steps[1];
  const previewValues = bloomStep.expressions.map((expression) =>
    expression.preview_value
  );
  assertEquals(
    previewValues,
    [60, 90],
    `Expected the two range expressions to repair to two DIFFERENT values (60 and 90), not collapse together. Got: ${
      JSON.stringify(bloomStep.expressions)
    }`,
  );
  assert(
    !bloomStep.description_template.includes("0.2 x"),
    `Expected neither copied-example multiplier to survive repair, got: ${bloomStep.description_template}`,
  );
  const repairWarnings = result.warnings.filter((warning) =>
    warning.includes("F32 repair")
  );
  assertEquals(
    repairWarnings.length,
    2,
    `Expected one warning per repaired expression, got: ${
      JSON.stringify(repairWarnings)
    }`,
  );
});

Deno.test("F32: a 'derived' (not literal) record is never used to repair a rendering", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  const original = "Pour (0.2 x <final_water_amount>)g and bloom.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
            {
              value: 40,
              unit: "g",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "multiple_of_coffee",
              rule_source_quote: "twice the dose",
              rule_inputs: { multiplier: 2, coffee_amount: 20 },
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              description_template: original,
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 20g of coffee. Add water to bloom, twice the dose. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f32-derived-not-repaired",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    original,
    "Expected a 'derived' record to never overwrite a rendered expression — only 'literal' is authoritative enough.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("F32 repair")),
    `Expected no F32 repair warning when the only record is 'derived', got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("F32: a step with no matching literal record is left untouched", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  const original = "Pour (0.2 x <final_water_amount>)g and bloom.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          // No extracted_amounts record at all, for any step — including
          // step 0's own default "(15)g" text, which convertNumericValues-
          // ToExpressions deterministically turns into its own coffee-
          // scaled expression regardless of provenance. Leaving
          // extracted_amounts empty means neither step has anything to
          // repair against.
          extracted_amounts: [],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              description_template: original,
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 20g of coffee. Add water to bloom. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f32-no-record",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    original,
    "Expected a step with no matching literal record to be left completely untouched — never guess.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("F32 repair")),
    `Expected no F32 repair warning when there is nothing to repair against, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("F32: a non-Latin unit survives repair unchanged", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 15,
    waterAmount: 150,
  });
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 15, waterAmount: 150 }),
          extracted_amounts: [
            {
              value: 20,
              unit: "مل",
              step_index: 1,
              provenance: "literal",
              source_quote: "20 مل",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              // Bug under test (Persian live incident shape): copied 0.2
              // example multiplier renders 30 مل instead of the stated
              // 20 مل. The unit must never be normalized/translated away.
              description_template:
                "Pour (0.2 x <final_water_amount>)مل and bloom.",
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 15g of coffee. Add 20 مل water and bloom. Pour to 150g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f32-non-latin-unit",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Pour (0.133333 x <final_water_amount>)مل and bloom.",
    "Expected the multiplier to be repaired to 20/150 = 0.133333 while the مل unit stays exactly as written — never normalized to a Latin unit.",
  );
});

Deno.test("F32: a rendering that already matches its literal record is left untouched, with no warning", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  // 60/300 = 0.2 exactly — this is a genuinely correct multiplier that
  // happens to equal the prompt's own example constant, not a copied
  // placeholder. Repairing it anyway (or warning about it) would be a
  // false positive.
  const original = "Pour (0.2 x <final_water_amount>)g and bloom.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
            {
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "60g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              description_template: original,
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 20g of coffee. Add 60g water and bloom. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f32-already-correct",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    original,
    "Expected an already-correct rendering to be left byte-for-byte untouched.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("F32 repair")),
    `Expected no repair warning when nothing needed repairing, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

// ---------------------------------------------------------------------
// D2 (plan 020 §3, §5 item 3) — F32 must consult unit_kind before binding a
// literal provenance record to an expression: a "volume" record must never
// repair a <final_coffee_amount> expression, however its value/step_index
// line up. Reproduces the confirmed live defect (cold-brew capture
// 5b3b8661-a22c-4088-9e8e-9cf45793dc9c): extracted_amounts carried a
// step-0 { value: 4, unit: "cups", unit_kind: "volume" } record for "4
// cups" of WATER alongside the real 82 g coffee dose, and the old
// (unit_kind-blind) F32 matched the two by step_index/placeholder alone,
// "repairing" a correct coffee multiplier of 1 down to 4/82 and rendering
// "Grind 4g coffee" against an 82 g recipe.
// ---------------------------------------------------------------------

Deno.test("D2/F32: a step-level 'volume' record never repairs a <final_coffee_amount> expression (cold-brew shape)", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 82,
    waterAmount: 946,
  });
  // Already numerically correct: 1 x 82 = 82g, the real dose. Nothing here
  // needs repairing — the only thing on offer is the wrong-kind "4 cups"
  // record, and it must be refused.
  const original =
    "Grind (1 x <final_coffee_amount>)g coffee very coarse. Combine with cold filtered water in a large jar or pitcher.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 82, waterAmount: 946 }),
          extracted_amounts: [
            {
              value: 4,
              unit: "cups",
              step_index: 0,
              provenance: "literal",
              source_quote: "4 cups",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "volume",
            },
            {
              value: 82,
              unit: "grams",
              step_index: -1,
              provenance: "literal",
              source_quote: "82g coffee",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "mass",
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            {
              ...normalizedBase.steps[0],
              description_template: original,
            },
            normalizedBase.steps[1],
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Grind 82g coffee very coarse. Combine with 4 cups cold filtered water in a large jar or pitcher.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Cold Brew" },
    ],
    requestId: "req-d2-cold-brew-volume-guard",
  });

  assertEquals(
    result.draft.steps[0].description_template,
    original,
    "Expected the volume record to be refused, leaving the already-correct coffee expression untouched.",
  );
  assert(
    result.draft.steps[0].expressions.some((expression) =>
      expression.preview_value === 82
    ),
    `Expected the coffee expression to still preview as 82 (the real dose), got: ${
      JSON.stringify(result.draft.steps[0].expressions)
    }`,
  );
  assert(
    !result.warnings.some((warning) => warning.includes("F32 repair")),
    `Expected no F32 repair when the only candidate record is a volume record against a coffee-mass expression, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("D2/F32: a 'mass' unit_kind record still repairs a <final_water_amount> expression (water mass/volume equivalence preserved)", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
            {
              value: 40,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "40g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              // Explicitly labelled "mass" (not absent) — this is the
              // asymmetric half of D2's rule: mass is always an
              // acceptable source-of-truth for a WATER expression, since
              // water is legitimately measured in both g and ml at
              // density ~= 1 (same equivalence unit_kind's schema comment
              // and normalizeUnitForRangeCheck already document). German
              // round-3 (fb41e2fc) and a Kalita capture both depend on
              // exactly this direction still firing.
              unit_kind: "mass",
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              description_template:
                "Pour (0.2 x <final_water_amount>)g water and bloom.",
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 20g of coffee. Add 40g water and bloom. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d2-mass-repairs-water",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Pour (0.133333 x <final_water_amount>)g water and bloom.",
    "Expected the mass literal to still repair the water expression to 40/300 = 0.133333.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("F32 repair") && warning.includes("0.133333")
    ),
    `Expected the usual F32 repair warning, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("D2/F32: backward compatibility — a record with no unit_kind field at all repairs a coffee expression exactly as before this fix", async () => {
  // This is the mandatory backward-compat case (plan 020 "Backward
  // compatibility is required"): unit_kind is optional/nullable, and old
  // captures / all six golden fixtures predate it entirely. An absent
  // field must never change an existing outcome — including this one,
  // where the pre-fix behavior (no unit_kind to consult) is to accept
  // the record. This is deliberately the OLD behavior, preserved on
  // purpose for the absent-field case; it is not a re-introduction of
  // D2, because D2 only ever reproduces once unit_kind: "volume" is
  // actually present and ignored, which the two tests above cover.
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 82,
    waterAmount: 946,
  });
  const original =
    "Grind (1 x <final_coffee_amount>)g coffee very coarse. Combine with cold filtered water in a large jar or pitcher.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 82, waterAmount: 946 }),
          extracted_amounts: [
            {
              value: 4,
              unit: "cups",
              step_index: 0,
              provenance: "literal",
              source_quote: "4 cups",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              // No unit_kind key at all — the old-shape record.
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            {
              ...normalizedBase.steps[0],
              description_template: original,
            },
            normalizedBase.steps[1],
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Grind 82g coffee very coarse. Combine with 4 cups cold filtered water in a large jar or pitcher.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Cold Brew" },
    ],
    requestId: "req-d2-backward-compat-no-unit-kind",
  });

  assertEquals(
    result.draft.steps[0].description_template,
    "Grind (0.0487805 x <final_coffee_amount>)g coffee very coarse. Combine with cold filtered water in a large jar or pitcher.",
    "Expected the pre-existing (unit_kind-blind) repair behavior to be preserved exactly when unit_kind is absent.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("F32 repair") && warning.includes("0.0487805")
    ),
    `Expected the usual F32 repair warning when unit_kind is absent, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("D2/F32: a 'time' unit_kind record never repairs a coffee OR water expression (a stray duration is not an amount)", async () => {
  // Same defect shape as the cold-brew "4 cups" case, just a different
  // wrong kind: a stated duration ("30 seconds") happens to collide in
  // value with a step's already-correct rendered mass/volume, and F32
  // must not treat the duration as the amount's source-of-truth. Exercises
  // BOTH placeholders in one draft: step 0's coffee expression and step
  // 1's water expression each have their own colliding time record.
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  const coffeeOriginal = "Grind (1 x <final_coffee_amount>)g coffee.";
  const waterOriginal = "Pour (0.2 x <final_water_amount>)g water and bloom.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
            {
              value: 20,
              unit: "s",
              step_index: 0,
              provenance: "literal",
              source_quote: "20 seconds",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "time",
            },
            {
              value: 60,
              unit: "s",
              step_index: 1,
              provenance: "literal",
              source_quote: "60 seconds",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "time",
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            {
              ...normalizedBase.steps[0],
              description_template: coffeeOriginal,
            },
            {
              ...normalizedBase.steps[1],
              description_template: waterOriginal,
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Grind coffee for 20 seconds. Pour water and bloom for 60 seconds. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d2-time-kind-refused",
  });

  assertEquals(
    result.draft.steps[0].description_template,
    coffeeOriginal,
    "Expected a 'time' record to be refused against <final_coffee_amount>, leaving the correct rendering untouched.",
  );
  assertEquals(
    result.draft.steps[1].description_template,
    waterOriginal,
    "Expected a 'time' record to be refused against <final_water_amount>, leaving the correct rendering untouched.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("F32 repair")),
    `Expected no F32 repair from a 'time'-kind record against either placeholder, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("D2/F32: a 'percent' unit_kind record never repairs a coffee OR water expression (a stated ratio is not an amount)", async () => {
  // Same shape again with unit_kind 'percent' (e.g. a stated ratio like
  // "6%" TDS or a brew-ratio percentage mentioned in passing) — neither a
  // coffee nor a water amount, so it must never source-of-truth either
  // placeholder.
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  const coffeeOriginal = "Grind (1 x <final_coffee_amount>)g coffee.";
  const waterOriginal = "Pour (0.2 x <final_water_amount>)g water and bloom.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
            {
              value: 20,
              unit: "%",
              step_index: 0,
              provenance: "literal",
              source_quote: "20%",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "percent",
            },
            {
              value: 60,
              unit: "%",
              step_index: 1,
              provenance: "literal",
              source_quote: "60%",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "percent",
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            {
              ...normalizedBase.steps[0],
              description_template: coffeeOriginal,
            },
            {
              ...normalizedBase.steps[1],
              description_template: waterOriginal,
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Grind coffee, 20% of total. Pour water and bloom, 60% strength. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d2-percent-kind-refused",
  });

  assertEquals(
    result.draft.steps[0].description_template,
    coffeeOriginal,
    "Expected a 'percent' record to be refused against <final_coffee_amount>, leaving the correct rendering untouched.",
  );
  assertEquals(
    result.draft.steps[1].description_template,
    waterOriginal,
    "Expected a 'percent' record to be refused against <final_water_amount>, leaving the correct rendering untouched.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("F32 repair")),
    `Expected no F32 repair from a 'percent'-kind record against either placeholder, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

// ---------------------------------------------------------------------
// F33 — repairExpressionMultipliersAgainstLiteralProvenance must verify a
// 'literal' record's source_quote against the request text before trusting
// it, exactly like G22 (verifyAmountProvenance/quoteAppearsInSource) does
// downstream. Without this, a hallucinated literal record (provenance
// "literal" but a source_quote that never appeared in the submitted text)
// could rewrite a correct-looking rendering into a fabricated value before
// the user ever sees it — G22 would still catch and block the draft
// afterward (quoteAppearsInSource runs again there), but the repair pass
// itself should never have trusted the unverified record in the first
// place. See parser.ts's quoteAppearsInSourceLocal, a small intentionally
// duplicated copy of provenance.ts's own helper (parser.ts does not import
// provenance.ts's internals).
// ---------------------------------------------------------------------

Deno.test("F33: a literal record whose source_quote is absent from the request text does not trigger a repair", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  // Same copied-example-multiplier bug shape as the F32 tests above (0.2
  // instead of the correct 40/300 = 0.133333) — but this time the
  // extraction stage's literal record cites a source_quote ("50 جرام")
  // that does not appear anywhere in the request text below, which only
  // ever says "40 جرام". A record like this is indistinguishable from a
  // hallucination and must not be trusted to rewrite the rendering.
  const original = "Pour (0.2 x <final_water_amount>)جرام water and bloom.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
            {
              value: 40,
              unit: "جرام",
              step_index: 1,
              provenance: "literal",
              // Hallucinated: never appears in the request text, which
              // states "40 جرام", not "50 جرام".
              source_quote: "50 جرام",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              description_template: original,
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 20g of coffee. Add 40 جرام water and bloom. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f33-unverified-quote",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    original,
    "Expected a literal record whose source_quote does not appear in the request text to be excluded from repair, leaving the rendering untouched.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("F32 repair")),
    `Expected no F32 repair warning when the only literal record fails quote verification, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
  // G22 still catches the untouched, wrong 60g rendering downstream — the
  // repair pass declining to act does not mean the draft silently
  // publishes with a bad amount.
  assert(
    result.validation.issues.some((issue) =>
      issue.field === "steps[1].description_template" &&
      (issue.code === "unverifiable_amount" ||
        issue.code === "amount_provenance_mismatch")
    ),
    `Expected G22 to independently flag the unrepaired step, got: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
});

Deno.test("F33: a literal record whose source_quote is present in the request text still triggers a repair", async () => {
  const calls: Array<{ provider: string; stage: string }> = [];
  const normalizedBase = createF32Normalized({
    coffeeAmount: 20,
    waterAmount: 300,
  });
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createF32Extraction({ coffeeAmount: 20, waterAmount: 300 }),
          extracted_amounts: [
            {
              value: 40,
              unit: "جرام",
              step_index: 1,
              provenance: "literal",
              // Verifiable: appears verbatim in the request text below.
              source_quote: "40 جرام",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
            },
          ],
        },
        normalized: {
          ...normalizedBase,
          steps: [
            normalizedBase.steps[0],
            {
              ...normalizedBase.steps[1],
              description_template:
                "Pour (0.2 x <final_water_amount>)جرام water and bloom.",
            },
            normalizedBase.steps[2],
          ],
        },
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 20g of coffee. Add 40 جرام water and bloom. Pour to 300g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-f33-verified-quote",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Pour (0.133333 x <final_water_amount>)جرام water and bloom.",
    "Expected a literal record whose source_quote checks out against the request text to still repair the rendering, exactly as F32 did before this fix.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("F32 repair") && warning.includes("0.2") &&
      warning.includes("0.133333")
    ),
    `Expected the usual F32 repair warning once quote verification passes, got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

// ---------------------------------------------------------------------
// Stage-capture (opt-in via capture_stages) — see plans/011-recipe-draft-
// lab-live-test-runbook.md (timer-coffee-landing-2 repo) for why this
// exists: a live test pass that does not record per-stage raw output
// cannot be replayed as a regression fixture.
// ---------------------------------------------------------------------

Deno.test("capture_stages: false collects nothing — stage_outputs is null", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "openai",
        tag: "openai/gpt-5.6-terra",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-capture-off",
    // captureStages omitted — matches every existing caller, including
    // verify-user-recipe-draft, which never sets this field at all.
  });

  assertEquals(
    result.stage_outputs,
    null,
    "Expected stage_outputs to stay null when capture_stages was never requested — zero collection, zero retention.",
  );
  assertEquals(
    result.capture_id,
    null,
    "Expected capture_id null from the parser itself — only handler.ts can populate it, after a successful insert.",
  );
});

Deno.test("capture_stages: true — a stage that retries on the same provider records more than one entry", async () => {
  const provider = createStageCaptureTestProvider({
    name: "openai",
    model: "openai/gpt-5.6-terra",
    outcomes: {
      extraction: [
        {
          ok: false,
          error: "openai/gpt-5.6-terra extraction transient blip",
          rawText: "{not valid json",
          finishReason: "stop",
        },
        {
          ok: true,
          result: createExtraction(),
          rawText: JSON.stringify(createExtraction()),
          finishReason: "stop",
        },
      ],
      normalization: [
        {
          ok: true,
          result: createNormalized(),
          rawText: JSON.stringify(createNormalized()),
          finishReason: "stop",
        },
      ],
    },
  });

  const parser = createRecipeDraftParser({
    providers: [provider],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-capture-retry",
    captureStages: true,
  });

  assert(result.stage_outputs !== null, "Expected stage_outputs to be populated.");
  const extractionEntries = result.stage_outputs!.extraction;
  assertEquals(
    extractionEntries.length,
    2,
    "Expected two capture entries: the failed first attempt and the succeeding retry.",
  );
  assertEquals(
    extractionEntries[0]!.error,
    "openai/gpt-5.6-terra extraction transient blip",
    "Expected the first (failed) attempt's error recorded.",
  );
  assertEquals(
    extractionEntries[0]!.parsed,
    null,
    "Expected the first (failed) attempt's parsed field to be null.",
  );
  assertEquals(
    extractionEntries[0]!.raw_text,
    "{not valid json",
    "Expected the first (failed) attempt's raw_text recorded even though it failed.",
  );
  assert(
    extractionEntries[1]!.error === null,
    "Expected the second (succeeding) attempt to have no error.",
  );
  assertEquals(
    extractionEntries[0]!.attempt,
    1,
    "Expected the first entry's attempt counter to be 1.",
  );
  assertEquals(
    extractionEntries[1]!.attempt,
    2,
    "Expected the second entry's attempt counter to be 2, continuing the same stage's sequence.",
  );

  // All four stage keys must always be present, even for stages that never
  // ran (repair wasn't needed here; cumulative_rewrite wasn't triggered by
  // this English-language mock recipe).
  assertEquals(
    Object.keys(result.stage_outputs!).sort(),
    ["cumulative_rewrite", "extraction", "normalization", "repair"],
    "Expected all four stage keys present on stage_outputs.",
  );
  assertEquals(
    result.stage_outputs!.repair,
    [],
    "Expected repair's array to be empty since repair never ran.",
  );
});

Deno.test("capture_stages: true — a failing stage records its error AND its raw_text", async () => {
  // Repair is triggered by a normalized draft missing required fields; the
  // provider below fails BOTH of REPAIR_MAX_ATTEMPTS_PER_PROVIDER's
  // attempts (matching the existing "exhausts its retry" pattern used
  // elsewhere in this file), so the pipeline falls through with the
  // missing fields still unset rather than throwing — repair failing is
  // non-fatal to the overall parse.
  const provider = createStageCaptureTestProvider({
    name: "openai",
    model: "openai/gpt-5.6-terra",
    outcomes: {
      // The extraction fields that could otherwise backfill the missing
      // normalized fields via applyExtractionFallbacks must be nulled out
      // too — otherwise the fallback fills them in BEFORE repairFields is
      // computed, repairFields comes back empty, and repair never runs at
      // all (matching the same setup used by the "Phase E: repair falls
      // through..." test elsewhere in this file).
      extraction: [{
        ok: true,
        result: {
          ...createExtraction(),
          name: null,
          grind_size: null,
          short_description: null,
          likely_brewing_method: null,
          water_temp_celsius: null,
          coffee_amount_grams: null,
          water_amount: null,
        },
      }],
      normalization: [{ ok: true, result: createMissingRequiredNormalized() }],
      repair: [
        {
          ok: false,
          error: "repair still missing or malformed fields: recipe.name",
          rawText: '{"recipe": {"name": null',
          finishReason: "length",
        },
        {
          ok: false,
          error: "repair still missing or malformed fields: recipe.name",
          rawText: '{"recipe": {"name": null',
          finishReason: "length",
        },
      ],
    },
  });

  const parser = createRecipeDraftParser({
    providers: [provider],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-capture-repair-fail",
    captureStages: true,
  });

  const repairEntries = result.stage_outputs!.repair;
  assertEquals(
    repairEntries.length,
    2,
    "Expected two capture entries, one per exhausted repair attempt.",
  );
  for (const entry of repairEntries) {
    assertEquals(
      entry.error,
      "repair still missing or malformed fields: recipe.name",
      "Expected every failing repair attempt's error recorded.",
    );
    assertEquals(
      entry.raw_text,
      '{"recipe": {"name": null',
      "Expected every failing repair attempt's raw_text recorded — the most valuable thing available when a stage fails.",
    );
    assertEquals(
      entry.parsed,
      null,
      "Expected a failing attempt's parsed field to be null.",
    );
    assertEquals(
      entry.finish_reason,
      "length",
      "Expected finish_reason carried through even on failure.",
    );
  }
});

Deno.test("capture_stages: true — raw_text over 200,000 characters is truncated and marked", async () => {
  const oversizedRawText = "x".repeat(250_000);
  const provider = createStageCaptureTestProvider({
    name: "openai",
    model: "openai/gpt-5.6-terra",
    outcomes: {
      extraction: [
        {
          ok: true,
          result: createExtraction(),
          rawText: oversizedRawText,
        },
      ],
      normalization: [{ ok: true, result: createNormalized() }],
    },
  });

  const parser = createRecipeDraftParser({
    providers: [provider],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-capture-truncate",
    captureStages: true,
  });

  const entry: StageCaptureEntry = result.stage_outputs!.extraction[0]!;
  assert(
    entry.raw_text.length <= 200_000,
    `Expected raw_text truncated to at most 200,000 characters, got ${entry.raw_text.length}.`,
  );
  assertEquals(
    entry.truncated,
    true,
    "Expected the oversized entry marked truncated: true.",
  );
  assert(
    !entry.raw_text.endsWith("x"),
    "Expected the tail to be replaced by a truncation marker, not silently cut mid-content.",
  );
});

Deno.test("capture_stages: true — a stage under the size guard is never marked truncated", async () => {
  const provider = createStageCaptureTestProvider({
    name: "openai",
    model: "openai/gpt-5.6-terra",
    outcomes: {
      extraction: [
        {
          ok: true,
          result: createExtraction(),
          rawText: JSON.stringify(createExtraction()),
        },
      ],
      normalization: [{ ok: true, result: createNormalized() }],
    },
  });

  const parser = createRecipeDraftParser({
    providers: [provider],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-capture-no-truncate",
    captureStages: true,
  });

  const entry: StageCaptureEntry = result.stage_outputs!.extraction[0]!;
  assertEquals(
    entry.truncated,
    undefined,
    "Expected the truncated field omitted (not false) for an entry under the size guard.",
  );
});

// ---------------------------------------------------------------------
// Aug 2026 live pass, Fix 1: a stated additive pour RANGE must never be
// recomputed into a cumulative <final_water_amount> fraction. Live capture
// 627c64a7-e7a5-4cb7-a355-259d07c714ee (German V60, 4:6-ish): the source
// states a 25g bloom, then "gieße nun weitere 50-70g Wasser hinzu" (pour a
// FURTHER 50-70g on top — additive, not cumulative), then later stated
// cumulative markers "bis zu 175g" and "auf 300g". cumulative_rewrite
// turned the additive range into "auf insgesamt (0.25 x
// <final_water_amount>)-(0.3166666667 x <final_water_amount>)g" — i.e. it
// computed 25+50=75 and 25+70=95 itself. Neither 75g nor 95g appears
// anywhere in the source, so G22 correctly (and permanently — no retry
// fixes this) reported both as unverifiable.
// ---------------------------------------------------------------------
Deno.test("Aug 2026 Fix 1: cumulative_rewrite recomputing an additive pour RANGE into new figures is reverted to the original traceable wording", async () => {
  const germanExtraction: ExtractionResult = {
    ...createExtraction(),
    detected_input_language: "de",
    likely_brewing_method: "V60",
    water_amount: 300,
    coffee_amount_grams: 20,
  };

  const originalStep2Template =
    "Timer starten und langsam (0.0833333333 x <final_water_amount>)g Wasser mittig aufgießen.";
  // NUMERIC_SCALABLE_RANGE_REGEX/convertNumericValuesToExpressions is what
  // actually builds a range expression from literal "50-70g" text deep in
  // the pipeline; this test supplies the already-built range directly (as
  // buildDraftSteps would have produced it from that literal text) so the
  // assertions are about the cumulative_rewrite guard specifically, not
  // about range-detection elsewhere.
  const originalStep3Template =
    "Bei der 30-Sekunden-Marke gieße nun weitere (0.1666666667 x <final_water_amount>)-(0.2333333333 x <final_water_amount>)g Wasser hinzu.";

  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "de",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 92,
    },
    localization: {
      name: "V60 4:6",
      grind_size: "Medium-fine",
      short_description: "German V60 bloom-plus-range pour.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "V60 und Filter spülen und vorwärmen.",
        description_template: "V60 und Filter spülen und vorwärmen.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source:
          "Starte einen Timer, gieße langsam und vorsichtig 25g Wasser in der Mitte ein.",
        description_template: originalStep2Template,
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 25, unit: "g" }],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source:
          "Bei der 30-Sekunden-Marke gieße nun weitere 50-70g Wasser hinzu.",
        description_template: originalStep3Template,
        duration_seconds: 60,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [{ value: 50, unit: "g" }, { value: 70, unit: "g" }],
        step_role: "pour",
      },
    ],
  };

  // Reproduces the live bug: step 2 (bloom) is left alone, exactly as the
  // real capture did, but step 3's RANGE is recomputed into new cumulative
  // figures (75g/95g) that do not trace to the source.
  const badCumulativeRewrite: CumulativeRewriteResult = {
    warnings: [
      "Later brew steps were rewritten to cumulative water totals in the source language.",
    ],
    steps: [
      normalized.steps[0],
      normalized.steps[1],
      {
        ...normalized.steps[2],
        description_template:
          "Bei 0:30 auf insgesamt (0.25 x <final_water_amount>)-(0.3166666667 x <final_water_amount>)g Wasser aufgießen.",
      },
    ],
  };

  const calls: Array<{ provider: string; stage: string }> = [];
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: germanExtraction,
        normalized,
        cumulativeRewrite: badCumulativeRewrite,
        calls,
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "V60 und Filter spülen und vorwärmen. Starte einen Timer, gieße langsam und vorsichtig 25g Wasser in der Mitte ein. Bei der 30-Sekunden-Marke gieße nun weitere 50-70g Wasser hinzu.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "V60" }],
    requestId: "req-fix1-range-cumulative",
  });

  assert(
    calls.some((call) => call.stage === "cumulative_rewrite"),
    "Expected the cumulative_rewrite stage to actually run for this test to be meaningful.",
  );

  const rangeStep = result.draft.steps.find((step) =>
    step.description_source.includes("weitere 50-70g")
  );
  assert(rangeStep !== undefined, "Expected to find the additive-range step in the final draft.");

  const waterValues = rangeStep!.expressions
    .filter((expression) => expression.placeholder === "<final_water_amount>")
    .map((expression) => expression.preview_value)
    .sort((left, right) => (left ?? 0) - (right ?? 0));

  assertEquals(
    waterValues,
    [50, 70],
    "Expected the range step's rendered water amounts to stay 50g/70g (traceable), not be recomputed to 75g/95g.",
  );
  assert(
    !rangeStep!.expressions.some((expression) =>
      expression.preview_value === 75 || expression.preview_value === 95
    ),
    "Expected no expression on the range step to render the untraceable 75g/95g cumulative figures.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("recomputed") && warning.includes("do not trace")
    ),
    "Expected a warning explaining the reverted range rewrite.",
  );
});

// ---------------------------------------------------------------------
// Aug 2026 live pass, Fix 2 (and Fix 3): EXPRESSION_REGEX's trailing unit
// capture used to be an ASCII-only denylist that happily swallowed
// whatever text followed a unit when that text wasn't specifically
// excluded — including non-ASCII punctuation like the Japanese ideographic
// full stop "。". Live capture 594bb92f-76a4-43cd-b28c-e34048988b7e (a
// Japanese 4:6 V60) had "(0.2 x <final_water_amount>)mlまで注ぐ。" (no
// space, as normal in Japanese) render with expressions[].unit corrupted
// to "mlまで注ぐ。" — G22 then reported "60mlまで注ぐ。" as unverifiable, and
// the same corrupted unit was rendered a second time anywhere the admin
// draft-lab shows an expression's unit standalone next to the step's own
// full text (recipe-draft-lab.tsx's "Proportional amounts" panel), which is
// what made the trailing clause look duplicated. Fix 3 was confirmed to be
// the exact same root cause: nothing else in the draft (preview_text,
// description_template) ever showed "まで注ぐ。" printed twice — only the
// `unit` field carried the corrupted extra text, which a second UI surface
// then rendered next to the already-correct sentence.
// ---------------------------------------------------------------------
Deno.test("Aug 2026 Fix 2/3: a Japanese unit immediately followed by a trailing clause is captured as just the unit, not swallowed", async () => {
  const template =
    "タイマーを開始し、(0.2 x <final_water_amount>)mlまで注ぐ。";

  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "ja",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "4:6メソッド",
      grind_size: "やや粗挽き",
      short_description: "V60で300mlの湯を注ぐ。",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "準備。",
        description_template: "準備。",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "タイマースタート。0:00、1投目を注いで累計60ml。",
        description_template: template,
        duration_seconds: 45,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 60, unit: "ml" }],
        step_role: "bloom",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: { ...createExtraction(), detected_input_language: "ja" },
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-fix2-japanese-unit",
  });

  const step = result.draft.steps[1];
  assertEquals(
    step.expressions[0]?.unit,
    "ml",
    "Expected the unit to be exactly 'ml', not the trailing clause 'mlまで注ぐ。'.",
  );
  assertEquals(
    step.preview_text,
    "タイマーを開始し、60 mlまで注ぐ。",
    "Expected the trailing clause to appear exactly once in the rendered text.",
  );

  const occurrences = step.preview_text.split("まで注ぐ。").length - 1;
  assertEquals(
    occurrences,
    1,
    "Expected 'まで注ぐ。' to appear exactly once (Fix 3: not duplicated).",
  );
});

Deno.test("Aug 2026 Fix 2: Latin-script control — a unit directly followed by a sentence period is not swallowed", async () => {
  const template =
    "Pour until you reach the full (1 x <final_water_amount>)g.";

  const normalized: NormalizedDraft = {
    ...createNormalized(),
    steps: [
      createNormalized().steps[0],
      {
        ...createNormalized().steps[1],
        description_template: template,
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-fix2-latin-control",
  });

  const step = result.draft.steps[1];
  assertEquals(
    step.expressions[0]?.unit,
    "g",
    "Expected the unit to be exactly 'g', with the sentence period left as ordinary trailing text.",
  );
  assert(
    step.preview_text.endsWith("."),
    "Expected the sentence-ending period to survive in the rendered text.",
  );
});

Deno.test("Aug 2026 Fix 2: a legitimate non-Latin unit (Chinese, no space before the following clause) is captured correctly", async () => {
  const template = "煮沸后倒入(1 x <final_water_amount>)克水中搅拌。";

  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "zh",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "V60 中文",
      grind_size: "中细",
      short_description: "中文V60配方。",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "准备。",
        description_template: "准备。",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "煮沸后倒入300克水中搅拌。",
        description_template: template,
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [{ value: 300, unit: "克" }],
        step_role: "pour",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: { ...createExtraction(), detected_input_language: "zh" },
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-fix2-chinese-unit",
  });

  const step = result.draft.steps[1];
  assertEquals(
    step.expressions[0]?.unit,
    "克",
    "Expected the unit to be exactly '克', not swallowing the following '水中搅拌。' clause.",
  );
  assert(
    step.preview_text.includes("水中搅拌。"),
    "Expected the trailing clause to survive intact in the rendered text.",
  );
});

// ---------------------------------------------------------------------
// defect-2 / F19 (2026-08-12 live pass): grind_size had no deterministic
// handling anywhere in the parser — only prompt instructions — so a model
// that grabbed the wrong clause of the source sailed through unchecked.
// Live shapes: all four V60 runs stored an instruction sentence ("Grind
// ... for a total brew time of 2 to 2.5 minutes.") instead of a grind
// size; two of four Kalita runs stored ASR garbage ("pure wood grind
// size", a mis-hearing of "pour-over"). The fix adds grind_size_is_stated
// (a semantic-judgement extraction field, mirroring duration_is_stated)
// plus a deterministic, English-only, WARN-not-block shape check for the
// instruction-leak class. The ASR-garbage class is NOT covered by any
// deterministic mechanism here — see the report for why — and is called
// out explicitly rather than silently left untested.
// ---------------------------------------------------------------------

Deno.test("defect-2: warns when a suspiciously long, sentence-shaped grind_size looks like a leaked instruction", async () => {
  // Reproduces the exact live shape: an instruction sentence about brew
  // time, not a grind descriptor, ends up in grind_size.
  const badGrindSize =
    "Grind fine for a total brew time of 2 to 2.5 minutes.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          grind_size: badGrindSize,
          grind_size_is_stated: true,
        },
        normalized: {
          ...createNormalized(),
          detected_input_language: "en",
          localization: {
            ...createNormalized().localization,
            grind_size: badGrindSize,
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-defect2-instruction-leak",
  });

  assert(
    result.warnings.some((warning) =>
      warning.includes(badGrindSize) &&
      warning.includes("reported as stated by the source")
    ),
    `Expected a warning naming the suspicious grind_size value. Got: ${
      JSON.stringify(result.warnings)
    }`,
  );
  assertEquals(
    result.draft.localization.grind_size,
    badGrindSize,
    "Expected grind_size to be surfaced (warn), not blocked or silently altered.",
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected the suspicious grind_size to WARN, not block publishing — grind_size is legitimately inferable, unlike a coffee/water amount.",
  );
});

Deno.test("defect-2: does not warn for a short, clean, stated grind_size", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          grind_size: "Medium-fine",
          grind_size_is_stated: true,
        },
        normalized: {
          ...createNormalized(),
          detected_input_language: "en",
          localization: {
            ...createNormalized().localization,
            grind_size: "Medium-fine",
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-defect2-clean-grind-size",
  });

  assert(
    !result.warnings.some((warning) => warning.includes("Grind size")),
    `Expected no grind_size warning for a clean value. Got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("defect-2: does not warn for a clean grind_size that was inferred rather than stated", async () => {
  // grind_size_is_stated defaults to false/absent when a provider doesn't
  // set it — must degrade to the "inferred" treatment, not silently
  // become the "stated" (garbage-suspicious) treatment.
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "en",
          grind_size: "Medium",
        },
        normalized: {
          ...createNormalized(),
          detected_input_language: "en",
          localization: {
            ...createNormalized().localization,
            grind_size: "Medium",
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-defect2-inferred-grind-size",
  });

  assert(
    !result.warnings.some((warning) => warning.includes("Grind size")),
    `Expected no grind_size warning when grind_size_is_stated is absent/false and the value is clean. Got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("defect-2: warns (does not silently trust) a stated grind_size for a non-English recipe, since the shape check is English-only", async () => {
  // The shape heuristic cannot run for non-English text (never
  // internationalize the regex — see isSuspiciousGrindSizeText). Rather
  // than silently trusting an unverifiable "stated" grind_size, this
  // mirrors F28e's convention: an honest warning instead of a guess.
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "de",
          grind_size: "Mittelfein",
          grind_size_is_stated: true,
        },
        normalized: {
          ...createNormalized(),
          detected_input_language: "de",
          localization: {
            ...createNormalized().localization,
            grind_size: "Mittelfein",
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock-Rezept",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-defect2-non-english-stated",
  });

  assert(
    result.warnings.some((warning) =>
      warning.includes("Mittelfein") && warning.includes("cannot be automatically verified")
    ),
    `Expected an honest "cannot verify" warning for a stated non-English grind_size. Got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("defect-2: does not warn for an inferred (not stated) grind_size on a non-English recipe", async () => {
  // Symmetric to the extraction-only English-recipe case: an INFERRED
  // value is expected to already be a short canonical phrase by
  // construction, so there is nothing new to verify by warning about it,
  // even though the shape check itself cannot run for this language.
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          detected_input_language: "de",
          grind_size: "Mittel",
          grind_size_is_stated: false,
        },
        normalized: {
          ...createNormalized(),
          detected_input_language: "de",
          localization: {
            ...createNormalized().localization,
            grind_size: "Mittel",
          },
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock-Rezept",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [{ brewing_method_id: "v60", brewing_method: "Hario V60" }],
    requestId: "req-defect2-non-english-inferred",
  });

  assert(
    !result.warnings.some((warning) => warning.includes("Grind size")),
    `Expected no grind_size warning for a non-English inferred value. Got: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

// ---------------------------------------------------------------------
// D4 (plan 016 Phase 3a): a range_endpoint record collapsed to a single
// rendered endpoint, with the other endpoint absent from the entire draft,
// used to block publication outright (Chemex 2/4, Spanish 4/4 from
// plans/015). A range whose both endpoints survive somewhere in the draft
// (German V60 4/4) must NOT be treated as a collapse — that half is
// unchanged.
//
// Plan 020 Phase D supersedes the FIRST half of that: this is precisely
// the shape CONFIRMED live as the Chemex/Spanish defect (plan 020 §3 D1,
// the task brief's acceptance criteria) — a single-record step-level range
// collapsed to its low endpoint, with stated_range carrying both. Phase D's
// deterministic backstop (expandCollapsedStatedRangeEndpoints in parser.ts)
// now reconstructs the missing endpoint's rendering instead of blocking,
// which is the whole point of the backstop ("prefer reconstructing over
// blocking", plan 020 §3 D1) — so this scenario is now expected to publish
// with BOTH endpoints rendered, not to block.
// ---------------------------------------------------------------------

Deno.test("D4 -> Phase D: a coffee/water range collapsed to its low endpoint is reconstructed to render both endpoints and stays publishable (Chemex/Spanish shape)", async () => {
  const requestText =
    "Rinse the filter and add 15g of coffee. Pour 60-90g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "60-90g",
              rule_inputs: { low: 60, high: 90, endpoint: 0 },
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              // The source stated a 60-90g range but the final draft only
              // shows the low endpoint (60g) — the high endpoint (90) never
              // appears anywhere else in the draft. Phase D's backstop must
              // reconstruct the high endpoint's rendering from this
              // record's own rule_inputs.
              description_template: "Pour 60g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d4-collapse",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected Phase D to reconstruct the missing high endpoint rather than report a collapse. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected the reconstructed rendering (both 60g and 90g) to stay publishable.",
  );
  assert(
    result.publish_projection !== undefined,
    "Expected a publish_projection now that both endpoints render and nothing blocks the draft.",
  );

  const step1 = result.draft.steps[1];
  assertEquals(
    step1.expressions.length,
    2,
    `Expected the reconstructed step to carry two scalable expressions (one per range endpoint). Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
  assert(
    step1.expressions.some((expression) =>
      expression.preview_value !== null &&
      Math.abs(expression.preview_value - 60) < 0.5
    ),
    `Expected the low endpoint (60) to still render. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
  assert(
    step1.expressions.some((expression) =>
      expression.preview_value !== null &&
      Math.abs(expression.preview_value - 90) < 0.5
    ),
    `Expected the reconstructed high endpoint (90) to render. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
});

Deno.test("D4: a coffee/water range that preserves both endpoints in the draft is NOT treated as a collapse (German V60 non-regression)", async () => {
  const requestText =
    "Rinse the filter and add 15g of coffee. Pour 60-90g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "60-90g",
              rule_inputs: { low: 60, high: 90, endpoint: 0 },
            },
            {
              value: 90,
              unit: "g",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "60-90g",
              rule_inputs: { low: 60, high: 90, endpoint: 1 },
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              // Both endpoints of the stated range survive into the
              // rendered draft (unlike the collapse case above) — this
              // must NOT trip the range-collapse check. Written as two
              // separately-unitted amounts ("60g to 90g"), not a bare
              // hyphen range ("60-90g"): the deterministic range-to-
              // expression conversion attaches the shared unit suffix only
              // to the SECOND expression in a hyphen chain, which is a
              // pre-existing empty-rendered-unit gap (diagnosis D1, owned
              // by provenance.ts's Phase 1a, not this check) — orthogonal
              // to what this test is verifying.
              description_template: "Pour 60g to 90g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d4-preserved",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue when both endpoints of the range survive into the draft. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a range whose both endpoints are preserved in the draft to stay publishable.",
  );
  assert(
    result.publish_projection !== undefined,
    "Expected a publish_projection since nothing blocks this draft.",
  );
});

// ---------------------------------------------------------------------
// D5 (plan 016 Phase 3b): a stated total brew time contradicted by the
// final emitted total must block in EXTRACT mode when the divergence is
// proportionally severe (Russian 3/4 from plans/015: stated 180s, emitted
// 40s, a 4.5x contraction), while an ordinary rounding-scale divergence
// (the cold_brew fixture control: stated 64800s, emitted 64830s, ~0.05%)
// must keep only warning. See isTotalBrewTimeMismatchSevere in parser.ts.
// ---------------------------------------------------------------------

Deno.test("D5: a stated total brew time contradicted by a 4.5x divergence in the emitted total blocks publication in extract mode (Russian shape)", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          total_brew_time_seconds: 180,
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              duration_seconds: 20,
              duration_is_stated: true,
            },
            {
              ...createNormalized().steps[2],
              duration_seconds: 20,
              duration_is_stated: true,
            },
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe with a source-stated 180s total brew time.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d5-severe",
  });

  assert(
    result.validation.issues.some((issue) =>
      issue.code === "total_brew_time_mismatch"
    ),
    `Expected a blocking total_brew_time_mismatch issue for a stated 180s total emitted as 40s (4.5x off). Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    false,
    "Expected a 4.5x stated-vs-emitted total brew time divergence to block publication in extract mode.",
  );
  assert(
    result.publish_projection === undefined,
    "Expected no publish_projection while the severe total-brew-time mismatch blocks the draft.",
  );
  assert(
    !result.warnings.some((warning) => warning.includes("total brew time")),
    `Expected the blocking finding to appear only in issues, not duplicated as a warning. Got warnings: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("D5: a 0.05% stated-vs-emitted total brew time divergence stays a warning and does not block (cold-brew control)", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          total_brew_time_seconds: 64800,
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              duration_seconds: 64800,
              duration_is_stated: true,
            },
            {
              ...createNormalized().steps[2],
              duration_seconds: 30,
              duration_is_stated: true,
            },
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe with an 18-hour cold brew steep, stated total 64800s.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d5-control",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "total_brew_time_mismatch"
    ),
    `Expected no blocking total_brew_time_mismatch issue for a 0.05% stated-vs-emitted divergence. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a 0.05% stated-vs-emitted total brew time divergence to stay publishable.",
  );
  assert(
    result.publish_projection !== undefined,
    "Expected a publish_projection since nothing blocks this draft.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("64800s") && warning.includes("64830s")
    ),
    `Expected the non-severe mismatch to still surface as a warning. Got warnings: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

// ---------------------------------------------------------------------
// D6 (plan 020 §3 D6, §5 item 5): the factor-of-2 threshold above was
// retuned to TOTAL_BREW_TIME_BLOCKING_RATIO = 1.05 from the full corpus of
// live captures accumulated since 016, not just the original two points.
// Every row of plan 020's table is exercised explicitly here so the next
// person to touch this constant sees the whole distribution rather than
// rediscovering it. See the comment above TOTAL_BREW_TIME_BLOCKING_RATIO in
// parser.ts for the full rationale, including why French press (1.06) is
// deliberately chosen to block and why 1.10 was rejected in favour of 1.05.
// ---------------------------------------------------------------------

async function assertTotalBrewTimeVerdict(
  label: string,
  statedSeconds: number,
  emittedSeconds: number,
  expectBlocked: boolean,
): Promise<void> {
  const half = Math.floor(emittedSeconds / 2);
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          total_brew_time_seconds: statedSeconds,
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              duration_seconds: half,
              duration_is_stated: true,
            },
            {
              ...createNormalized().steps[2],
              duration_seconds: emittedSeconds - half,
              duration_is_stated: true,
            },
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: `Mock recipe for D6 ratio case: ${label}.`,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: `req-d6-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
  });

  const hasBlockingFinding = result.validation.issues.some((issue) =>
    issue.code === "total_brew_time_mismatch"
  );
  assertEquals(
    hasBlockingFinding,
    expectBlocked,
    `D6 ${label}: stated ${statedSeconds}s, emitted ${emittedSeconds}s (ratio ${
      (Math.max(statedSeconds, emittedSeconds) /
        Math.min(statedSeconds, emittedSeconds)).toFixed(4)
    }). Expected blocking=${expectBlocked}, got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    !expectBlocked,
    `D6 ${label}: expected is_publishable=${!expectBlocked}.`,
  );
}

Deno.test("D6: cold brew 64,800s stated vs 64,820s emitted (ratio 1.0003) must pass — live-capture control", async () => {
  await assertTotalBrewTimeVerdict("cold-brew-live-control", 64800, 64820, false);
});

Deno.test("D6: French press 480s stated vs 510s emitted (ratio 1.06) blocks under the 1.05 threshold", async () => {
  await assertTotalBrewTimeVerdict("french-press-4", 480, 510, true);
});

Deno.test("D6: moka pot 240s stated vs 270s emitted (ratio 1.125, low-variance draw) must block", async () => {
  await assertTotalBrewTimeVerdict("moka-pot-1", 240, 270, true);
});

Deno.test("D6: moka pot 240s stated vs 490s emitted (ratio 2.04, high-variance draw) must block", async () => {
  await assertTotalBrewTimeVerdict("moka-pot-2-4", 240, 490, true);
});

Deno.test("D6: Russian 180s stated vs 40s emitted (ratio 4.5) must block", async () => {
  await assertTotalBrewTimeVerdict("russian", 180, 40, true);
});

// ---------------------------------------------------------------------
// D3'/Phase 2 (plan 016 §3 D3', §4 Phase 2): verify mode's whole contract
// is that a submitted, already-well-formed recipe's wording is never
// silently rewritten. Phase 0 found the actual (undocumented) source of
// the "0:00 pour 50g" -> "Pour 50g" and "pour to" -> "Pour up to"
// regressions was NOT the LLM stages (their stage_outputs were empty
// arrays, never invoked) but normalizeStepDescriptionTemplate's own
// unconditional leading-timestamp-strip+capitalize and cumulative-water-
// wording passes, which ran regardless of mode. These amounts are chosen
// so neither step's text matches NUMERIC_SCALABLE_AMOUNT_REGEX (no bare
// numeric coffee/water figure), isolating this test from the separate,
// mode-independent numeric-to-expression conversion pass so the assertion
// can be true byte-for-byte equality against description_source.
// ---------------------------------------------------------------------

Deno.test("Phase 2: verify mode preserves a leading-timestamp step and a 'pour to' step byte-identical to description_source", async () => {
  const normalized: NormalizedDraft = {
    ...createNormalized(),
    steps: [
      createNormalized().steps[0],
      {
        ...createNormalized().steps[1],
        // Verify mode's own normalization prompt already instructs
        // description_template === description_source verbatim — mocked
        // here exactly as a compliant model would return it, so this test
        // isolates the deterministic buildDraftSteps pass, not the prompt.
        description_source: "0:00 pour water for the bloom.",
        description_template: "0:00 pour water for the bloom.",
      },
      {
        ...createNormalized().steps[2],
        description_source: "Pour to the fill line and wait.",
        description_template: "Pour to the fill line and wait.",
      },
    ],
  };
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        cumulativeRewrite: { warnings: [], steps: normalized.steps },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-phase2-verify-preserve",
    mode: "verify",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "0:00 pour water for the bloom.",
    "Expected verify mode to keep a leading timestamp and lowercase wording byte-identical to description_source instead of stripping the timestamp and capitalizing.",
  );
  assertEquals(
    result.draft.steps[2].description_template,
    "Pour to the fill line and wait.",
    "Expected verify mode to keep 'pour to' wording byte-identical to description_source instead of rewriting it to 'pour up to'.",
  );
});

// Mirror image of the guard test above (same pattern as the existing
// pre-timer fold guard/mirror pair in this file): the SAME normalized
// fixture, with no `mode` (defaulting to "extract"), must still apply
// both deterministic rewrites — this proves the verify-mode preservation
// above is scoped to verify mode, not an accidental behavior change for
// extract mode. Extract-mode output must stay byte-identical to before
// Phase 2's change; the six golden fixtures are the broader proof of
// that, and this test additionally exercises the exact two rewrite
// functions D3' identified.
Deno.test("Phase 2 mirror: extract mode still strips a leading timestamp/capitalizes and still rewrites 'pour to' to 'pour up to'", async () => {
  const normalized: NormalizedDraft = {
    ...createNormalized(),
    steps: [
      createNormalized().steps[0],
      {
        ...createNormalized().steps[1],
        description_source: "0:00 pour water for the bloom.",
        description_template: "0:00 pour water for the bloom.",
      },
      {
        ...createNormalized().steps[2],
        description_source: "Pour to the fill line and wait.",
        description_template: "Pour to the fill line and wait.",
      },
    ],
  };
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-phase2-extract-mirror",
  });

  assertEquals(
    result.draft.steps[1].description_template,
    "Pour water for the bloom.",
    "Expected extract mode to keep stripping a leading timestamp and capitalizing, unchanged from before Phase 2.",
  );
  assertEquals(
    result.draft.steps[2].description_template,
    "Pour up to the fill line and wait.",
    "Expected extract mode to keep rewriting 'pour to' to 'pour up to', unchanged from before Phase 2.",
  );
});

// ---------------------------------------------------------------------
// B1 (plan 016 §3 D4′, §4 Task B): findRangeEndpointCollapseIssues must
// skip step_index -1 (recipe-level) records entirely — collapsing a
// recipe-level range like coffee_amount's "20-24g" is CORRECT (a single
// number by schema), not a defect, and must not false-block a German
// capture whose draft is otherwise correct.
// ---------------------------------------------------------------------

// Shared base for the B1 pair: G22_BASE_AMOUNTS only covers the 15g dose
// (step 0) and the 250g final total (step 2) — createNormalized()'s
// default step 1 also renders a literal 50g bloom that G22_BASE_AMOUNTS
// does not cover, so every test below adds a matching literal record for
// it. Without this, the unmatched 50g would itself produce an
// unverifiable_amount finding and mask what each test is actually
// checking.
const B1_BLOOM_LITERAL_AMOUNT = {
  value: 50,
  unit: "g",
  step_index: 1,
  provenance: "literal" as const,
  source_quote: "50g",
  rule: null,
  rule_source_quote: null,
  rule_inputs: null,
};
const B1_REQUEST_TEXT =
  "Rinse the filter and add 15g of coffee (a dose stated as 20-24g). Pour 50g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";

Deno.test("B1: a step_index -1 (recipe-level) range_endpoint record does not trip range_endpoint_collapsed, even though its other endpoint appears nowhere in the draft (German dose shape)", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            B1_BLOOM_LITERAL_AMOUNT,
            {
              // The German capture's coffee dose, stated as "20-24g",
              // recorded at the recipe level (step_index: -1) with only
              // the low endpoint (20) selected. 24 appears nowhere in the
              // rendered draft — before B1's fix this false-blocked the
              // exact draft this plan exists to unblock.
              value: 20,
              unit: "g",
              step_index: -1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "20-24g",
              rule_inputs: { low: 20, high: 24, endpoint: 0 },
            },
          ],
        },
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: B1_REQUEST_TEXT,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-b1-recipe-level",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue for a step_index -1 (recipe-level) range record. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a recipe-level range collapse (coffee_amount is a single number by schema) to stay publishable.",
  );
});

Deno.test("B1 contrast: a step_index >= 0 range_endpoint record with the same shape still blocks (Spanish shape, non-regression)", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            B1_BLOOM_LITERAL_AMOUNT,
            {
              // Endpoints (42/48) deliberately avoid colliding with any
              // value already present in the default rendered draft
              // (15, 50, 250) — a collision would make the "other"
              // endpoint look coincidentally preserved and defeat the
              // point of this contrast test.
              value: 42,
              unit: "ml",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "42-48ml",
              rule_inputs: { low: 42, high: 48, endpoint: 0 },
            },
          ],
        },
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: `${B1_REQUEST_TEXT} (elsewhere stated as 42-48ml)`,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-b1-step-level",
  });

  assert(
    result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected a range_endpoint_collapsed issue for a step_index >= 0 range record whose other endpoint is missing from the draft. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    false,
    "Expected a step-level range collapse to still block publication (B1 must not weaken this).",
  );
});

// ---------------------------------------------------------------------
// B2 (plan 016 §3 D4′/D1-empty-unit, §4 Task B): a hyphenated range like
// "60-90g" renders through EXPRESSION_REGEX as two adjacent expressions
// sharing one trailing unit suffix, so the FIRST rendered expression's
// unit is legitimately "". This must not cause a false block when the
// value is genuinely preserved. Replaces the prior agent's worked-around
// test (which used "60g to 90g" to dodge the gap) with a real hyphen
// range, per this task's explicit instruction.
// ---------------------------------------------------------------------

Deno.test("B2: a real hyphenated range ('60-90g') whose first expression renders with an empty unit is still recognized as preserving both endpoints", async () => {
  const requestText =
    "Rinse the filter and add 15g of coffee. Pour 60-90g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "60-90g",
              rule_inputs: { low: 60, high: 90, endpoint: 0 },
            },
            {
              value: 90,
              unit: "g",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "60-90g",
              rule_inputs: { low: 60, high: 90, endpoint: 1 },
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              // A genuine hyphenated expression range against the default
              // fixture's water_amount (250): 60/250 = 0.24, 90/250 = 0.36.
              // EXPRESSION_REGEX renders this as "(0.24 x
              // <final_water_amount>)-(0.36 x <final_water_amount>)g" — a
              // shared trailing unit, so the FIRST rendered amount (60)
              // carries an EMPTY unit. This is the real gap B2 fixes, not a
              // worked-around substitute.
              description_template:
                "Pour (0.24 x <final_water_amount>)-(0.36 x <final_water_amount>)g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-b2-hyphen-range",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue when a real hyphenated range's first expression renders with an empty unit but the value is genuinely preserved. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a preserved hyphenated range with an empty-unit first expression to stay publishable.",
  );
});

// ---------------------------------------------------------------------
// Task C (plan 016 §3 D4′, §4 Task C): stated_range must work as an
// ADDITIONAL trigger for findRangeEndpointCollapseIssues, independent of
// rule_inputs/range_endpoint — this is exactly the Chemex shape, where the
// collapsed high endpoint (90) was never assigned the range_endpoint rule
// at all (recorded as a plain LITERAL 60, no rule, rule_inputs null), so
// D4's original rule_inputs-only detection had nothing to find.
//
// Plan 020 Phase D supersedes the outcome (not the detection): CONFIRMED
// live as the Chemex/Spanish defect itself (plan 020 §3 D1), this shape is
// now expected to be RECONSTRUCTED — both endpoints rendered — rather than
// blocked; see the D4 test above for the same flip and its rationale.
//
// source_quote is "60" here (a bare number), not "60g" — matching what a
// literal record's source_quote actually looks like on every real capture
// inspected for this phase (CONFIRMED: German round-3's literal 50/70 g
// bloom recorded source_quote "50", not "50g"). A quote of "60g" is not a
// literal substring of this test's own request text ("Pour 60-90g of
// water..." contains "60-90g", not "60g") — that mismatch was harmless
// under the old expectation (the draft blocked via range_endpoint_collapsed
// regardless of whether the quote itself would separately verify) but
// becomes load-bearing now that Phase D's reconstruction depends on the
// quote genuinely passing G22's own literal check.
// ---------------------------------------------------------------------

Deno.test("Task C -> Phase D: stated_range on a LITERAL record (no range_endpoint rule at all) is reconstructed to render both endpoints and stays publishable (Chemex shape)", async () => {
  const requestText =
    "Rinse the filter and add 15g of coffee. Pour 60-90g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              // The Chemex shape from D4′: extraction recorded only the
              // literal 60, with NO rule and NO rule_inputs — the 90 would
              // be entirely invisible to the original D4 check. stated_range
              // is the field that keeps it visible, and Phase D's backstop
              // is what turns that visibility into an actual reconstructed
              // rendering.
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "60",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              stated_range: { low: 60, high: 90 },
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              description_template: "Pour 60g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-taskc-stated-range-literal",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected Phase D to reconstruct the missing high endpoint rather than report a collapse. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    `Expected the Chemex-shaped stated_range collapse to be reconstructed and stay publishable. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );

  const step1 = result.draft.steps[1];
  assert(
    step1.expressions.some((expression) =>
      expression.preview_value !== null &&
      Math.abs(expression.preview_value - 90) < 0.5
    ),
    `Expected the reconstructed high endpoint (90) to render. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
});

Deno.test("Task C: stated_range is backward compatible — a record with neither unit_kind nor stated_range (old-shape fixture) behaves exactly as before", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: createExtraction(),
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-taskc-backward-compat",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue for a draft whose provenance records predate unit_kind/stated_range entirely. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected an old-shape draft (no unit_kind/stated_range fields at all) to publish exactly as before Task C.",
  );
});

// ---------------------------------------------------------------------
// D3 (plan 020 §3 D3, §1 root cause): the recipe-level exemption in
// findRangeEndpointCollapseIssues must not rest on step_index -1 alone.
// CONFIRMED on production data (plan 020 task brief): four French-press
// captures carrying an IDENTICAL raw extraction record (value 60,
// stated_range {60,70}, step_index -1) split 2 published / 2 falsely
// blocked, because normalization nondeterministically re-emitted
// step_index as 0 on two of the four runs. The fix derives recipe-level
// status from the record's VALUE against this draft's own final
// recipe.coffee_amount/water_amount — data the model does not get to
// rewrite after extraction — and keeps step_index < 0 only as
// corroboration, not the sole oracle.
// ---------------------------------------------------------------------

Deno.test("D3: a recipe-level range collapse is exempted by VALUE match even when step_index was corrupted to a step index (French-press false-block shape)", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            B1_BLOOM_LITERAL_AMOUNT,
            {
              // Same shape as the CONFIRMED production defect: the record's
              // value (15) equals createNormalized()'s recipe.coffee_amount
              // (15) exactly, but step_index has been corrupted to 0 (a
              // real step index) instead of the -1 sentinel — exactly what
              // normalization did on two of the four French-press captures.
              // Before D3, this false-blocks; after D3, the value match
              // exempts it regardless of step_index.
              value: 15,
              unit: "g",
              step_index: 0,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "15-18g",
              rule_inputs: { low: 15, high: 18, endpoint: 0 },
              unit_kind: "mass",
            },
          ],
        },
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 15g of coffee (a dose stated as 15-18g). Pour 50g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d3-value-match-corrupted-sentinel",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue when the record's value matches recipe.coffee_amount, even with step_index corrupted to 0. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a recipe-level range collapse (value matches coffee_amount) to stay publishable regardless of step_index.",
  );
});

Deno.test("D3 non-regression: a genuine step-level pour range whose value does NOT match coffee_amount or water_amount still blocks, even with unit_kind set (German round-3 shape)", async () => {
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            B1_BLOOM_LITERAL_AMOUNT,
            {
              // Mirrors the German round-3 capture that must stay blocked:
              // value 42 matches neither createNormalized()'s coffee_amount
              // (15) nor water_amount (250) — a genuine step-level pour
              // range collapse, not a restatement of the recipe's own
              // final target. D3 must not exempt this.
              value: 42,
              unit: "ml",
              step_index: 1,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "42-48ml",
              rule_inputs: { low: 42, high: 48, endpoint: 0 },
              unit_kind: "volume",
            },
          ],
        },
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: `${B1_REQUEST_TEXT} (elsewhere stated as 42-48ml)`,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d3-non-regression-step-level",
  });

  assert(
    result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected a range_endpoint_collapsed issue for a step-level range whose value matches neither coffee_amount nor water_amount. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    false,
    "Expected a genuine step-level range collapse to still block, even after D3's value-match exemption.",
  );
});

Deno.test("D3 decision: a step-level record whose collapsed value equals recipe.water_amount is exempted (restated-final-total case)", async () => {
  // Deliberate decision (plan 020 §3 D3's second trap, documented in
  // isRecipeLevelScalarValue's header comment in parser.ts): a step-level
  // record that restates the recipe's own final water total (e.g. a final
  // cumulative pour phrased as "top up to 250g", where water_amount is
  // already 250) is exempted by the SAME value-match rule as the
  // recipe-level case. Rationale: the physical quantity a value-matching
  // record names has exactly one legitimate number in this schema
  // regardless of which step restates it, so collapsing a stated range for
  // it is not a defect. This is a deliberate broadening, not an accident —
  // see the header comment for the trade-off being made.
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            B1_BLOOM_LITERAL_AMOUNT,
            {
              // value 250 equals createNormalized()'s water_amount (250)
              // exactly, recorded at a real step index (the final pour),
              // with a stated range whose high endpoint (300) never
              // appears anywhere in the rendered draft.
              value: 250,
              unit: "g",
              step_index: 2,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "250-300g",
              rule_inputs: { low: 250, high: 300, endpoint: 0 },
              unit_kind: "mass",
            },
          ],
        },
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 15g of coffee. Pour 50g of water and bloom for 30 seconds. Pour to 250g total (stated elsewhere as 250-300g) and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d3-cumulative-pour-equals-water-amount",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue for a step-level record whose value equals recipe.water_amount (restated final total). Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a step-level range collapse that restates the recipe's own final water_amount to stay publishable, per D3's documented decision.",
  );
});

// ---------------------------------------------------------------------
// Phase D (plan 020 §3 D1, §4b): expandCollapsedStatedRangeEndpoints — the
// deterministic backstop. CONFIRMED live (task brief): plan 016's
// stated_range field, added so a collapsed range could be DETECTED, instead
// induced the model to stop emitting a per-endpoint record, so v48 renders
// only one endpoint where v47 (pre-stated_range) rendered two. This
// reconstructs the v47 rendering deterministically from the SAME record
// stated_range already carries, rather than leaving the fix to another
// prompt change.
// ---------------------------------------------------------------------

Deno.test("Phase D: a step-level stated_range whose high endpoint collapsed out of the draft is reconstructed to render both endpoints (German 50-70g shape)", async () => {
  const requestText =
    "Rinse the filter and add 15g of coffee. Bei der 30-Sekunden-Marke gieße nun weitere 50-70g Wasser hinzu. Pour to 250g total and wait 90 seconds.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              // Mirrors CONFIRMED production capture b2cf9abd (plan 020
              // task brief): a literal record for the LOW endpoint only,
              // with stated_range carrying both — source_quote is the bare
              // number "50" (matching every real capture inspected for
              // this phase, not "50g"; see the Task C test above for why
              // that distinction matters).
              value: 50,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "50",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "mass",
              stated_range: { low: 50, high: 70 },
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              // A bare literal number, exactly like the D4/Task C fixtures
              // above — buildDraftSteps' own deterministic literal-to-
              // expression conversion (unrelated to this phase) turns this
              // into a scalable "(0.2 x <final_water_amount>)g" BEFORE
              // Phase D's backstop ever runs, which is what gives the
              // backstop an expression to anchor a reconstruction to.
              description_template: "Pour 50g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-phase-d-german-shape",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected the reconstructed rendering to clear range_endpoint_collapsed. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    `Expected both endpoints (50 and 70) to render and the draft to stay publishable. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );

  const step1 = result.draft.steps[1];
  assertEquals(
    step1.expressions.length,
    2,
    `Expected two scalable expressions (one per range endpoint) after reconstruction. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
  assert(
    step1.expressions.some((expression) =>
      expression.preview_value !== null &&
      Math.abs(expression.preview_value - 50) < 0.5
    ),
    `Expected the low endpoint (50) to still render. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
  assert(
    step1.expressions.some((expression) =>
      expression.preview_value !== null &&
      Math.abs(expression.preview_value - 70) < 0.5
    ),
    `Expected the reconstructed high endpoint (70) to render. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
  assert(
    result.warnings.some((warning) => warning.includes("D1 backstop")),
    `Expected a warning documenting the reconstruction. Got warnings: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("Phase D: a recipe-level scalar's collapsed range is left alone — no reconstruction attempted (French-press 60-70g dose shape)", async () => {
  // CONFIRMED production shape (plan 020 task brief, French-press captures
  // 37daf1ec/372dc53f): the dose record's value equals the draft's own
  // final recipe.coffee_amount, so isRecipeLevelScalarValue (Phase C)
  // exempts it from findRangeEndpointCollapseIssues — and this same gate,
  // reused unchanged by expandCollapsedStatedRangeEndpoints, must ALSO stop
  // the backstop from ever touching this step's rendering. "Coffee: 60-70g"
  // is a recipe-level scalar, not a step-level range — collapsing it to a
  // single number is correct, and rendering "(1 x <final_coffee_amount>)-
  // (1.16667 x <final_coffee_amount>)g" would be the exact regression the
  // task brief warns against.
  //
  // Mirrors the D3 test above's own pattern (default createNormalized()'s
  // v60/15g-coffee fixture, unchanged) rather than constructing a fresh
  // French-press recipe context, to keep brewing-method resolution and
  // every other unrelated field exactly as already proven to work.
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            B1_BLOOM_LITERAL_AMOUNT,
            {
              // Same shape as the CONFIRMED French-press defect: the
              // record's value (15) equals createNormalized()'s
              // recipe.coffee_amount (15) exactly, with a genuine stated
              // range (15-18g) and a step-level index — Phase C's
              // value-match exemption applies regardless of step_index,
              // and Phase D must inherit that exemption unchanged.
              value: 15,
              unit: "g",
              step_index: 0,
              provenance: "derived",
              source_quote: null,
              rule: "range_endpoint",
              rule_source_quote: "15-18g",
              rule_inputs: { low: 15, high: 18, endpoint: 0 },
              unit_kind: "mass",
              stated_range: { low: 15, high: 18 },
            },
          ],
        },
        normalized: createNormalized(),
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text:
      "Rinse the filter and add 15g of coffee (a dose stated as 15-18g). Pour 50g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-phase-d-frenchpress-shape",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue for a recipe-level scalar (Phase C's own exemption). Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    `Expected the single collapsed dose to stay publishable. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );

  const step0 = result.draft.steps[0];
  assertEquals(
    step0.expressions.length,
    1,
    `Expected the recipe-level dose to stay a SINGLE expression — reconstructing a second endpoint here would be the exact French-press regression the task brief warns against. Got: ${
      JSON.stringify(step0.expressions)
    }`,
  );
  assert(
    !result.warnings.some((warning) => warning.includes("D1 backstop")),
    `Expected no D1 backstop warning — a recipe-level scalar must never be reconstructed. Got warnings: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("Phase D: a stated_range whose low and high are equal is never treated as a collapsed range (no-op)", async () => {
  const requestText =
    "Rinse the filter and add 15g of coffee. Pour 60g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "60g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              unit_kind: "mass",
              // low === high: not a genuine range by any reasonable
              // reading, even though the field is technically non-null.
              // resolveRangeEndpointTrigger's own low !== high guard must
              // keep this a no-op end to end — no detection, no
              // reconstruction, no warning.
              stated_range: { low: 60, high: 60 },
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              description_template: "Pour 60g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-phase-d-equal-range-noop",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue when stated_range.low === stated_range.high. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected an equal-endpoint stated_range to publish exactly as an ordinary single amount would.",
  );

  const step1 = result.draft.steps[1];
  assertEquals(
    step1.expressions.length,
    1,
    `Expected exactly one expression — stated_range {60,60} must never trigger a reconstruction. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
  assert(
    !result.warnings.some((warning) => warning.includes("D1 backstop")),
    `Expected no D1 backstop warning for a non-genuine (equal-endpoint) range. Got warnings: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

Deno.test("Phase D: a record with no stated_range and no range_endpoint rule is left exactly as before this phase", async () => {
  const requestText =
    "Rinse the filter and add 15g of coffee. Pour 60g of water and bloom for 30 seconds. Pour to 250g total and wait 90 seconds.";
  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction: {
          ...createExtraction(),
          extracted_amounts: [
            ...G22_BASE_AMOUNTS,
            {
              value: 60,
              unit: "g",
              step_index: 1,
              provenance: "literal",
              source_quote: "60g",
              rule: null,
              rule_source_quote: null,
              rule_inputs: null,
              // No unit_kind, no stated_range — the pre-Phase-D shape every
              // fixture predating plan 016/020 still has.
            },
          ],
        },
        normalized: {
          ...createNormalized(),
          steps: [
            createNormalized().steps[0],
            {
              ...createNormalized().steps[1],
              description_template: "Pour 60g of water and bloom.",
            },
            createNormalized().steps[2],
          ],
        },
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: requestText,
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-phase-d-no-stated-range-noop",
  });

  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "range_endpoint_collapsed"
    ),
    `Expected no range_endpoint_collapsed issue. Got issues: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected a record with no stated_range/rule to publish exactly as before Phase D.",
  );

  const step1 = result.draft.steps[1];
  assertEquals(
    step1.expressions.length,
    1,
    `Expected exactly one expression, unchanged from what extraction/normalization produced. Got: ${
      JSON.stringify(step1.expressions)
    }`,
  );
  assert(
    !result.warnings.some((warning) => warning.includes("D1 backstop")),
    `Expected no D1 backstop warning when there is nothing to reconstruct from. Got warnings: ${
      JSON.stringify(result.warnings)
    }`,
  );
});

// ---------------------------------------------------------------------
// D10 (plan 020 §3, following 5cc31dc's "a known start time is not a known
// duration" precedent): a drawdown step's elapsed_seconds equal to the
// recipe's own resolved completion target is stating when the brew ENDS,
// not when the drawdown BEGAN — a step that "begins" exactly when the
// whole recipe ends would have zero duration left to occupy, which is
// incoherent. normalizeAbsoluteTimestampDurations used to trust it as a
// differencing partner anyway, so the step immediately before it absorbed
// the gap between its own timestamp and the bogus "180s start" as its own
// duration; the anchored chain then summed to exactly the target,
// splitDerivedBrewStepDurationsFromTarget's `available === 0` bail-out
// declined to touch anything else, and the leftover derived steps' raw
// unreconciled guesses were left standing on top of the already-"complete"
// total. Live effect (German V60, source states 180s): 250s and 260s
// emitted across three captures; a fourth (same recipe, drawdown
// elapsed_seconds: null) correctly landed on 180s throughout.
//
// isUntrustworthyDrawdownEndMarker (parser.ts) now disqualifies exactly
// that one candidate as a differencing PARTNER — not from `timestamped`
// altogether, so the step keeps every other consequence of being the last
// timestamped step (its own nominal fallback duration, lastTimestamped
// bookkeeping, elapsed_seconds canonicalization).
// ---------------------------------------------------------------------

Deno.test("D10: a drawdown's elapsed_seconds equal to the stated total is not trusted as a differencing partner, so the total lands on target (German round-3 live-incident shape)", async () => {
  // Mirrors the live-capture shape exactly: bloom (elapsed 0), a pour
  // differenced against it (elapsed 30), two further pours sharing the
  // SAME elapsed_seconds (90 -- a landmark-resolution tie, not a stated
  // zero-duration step), and a drawdown whose elapsed_seconds (180) equals
  // the stated 180s total. Before this fix, the last pour (elapsed 90)
  // differenced against the drawdown's bogus "start" at 180, producing a
  // wrong 90s anchored duration; the anchored chain (30 + 60 + 90) summed
  // to exactly 180, the split bailed out with nothing left to distribute,
  // and the two untouched derived steps' raw guesses (60 + 10) landed on
  // top: 250s against a stated 180s.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "de",
    likely_brewing_method: "V60",
    name: "D10 German shape",
    short_description: "Tests D10's drawdown-equals-target fix.",
    grind_size: "Mittel",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Filter spuelen und Kaffee hinzufuegen.",
    steps: [
      {
        title: null,
        raw_text: "Gieße 25g Wasser auf (Bloom).",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "Bei 0:30 weitere 50-70g Wasser aufgießen.",
        duration_seconds: 60,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Auf insgesamt 175g aufgießen.",
        duration_seconds: 60,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Nach einer weiteren Minute auf insgesamt 300g aufgießen.",
        duration_seconds: 10,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Vollständig durchlaufen lassen.",
        duration_seconds: 10,
        elapsed_seconds: 180,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 180,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "de",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "D10 German shape",
      grind_size: "Mittel",
      short_description: "Tests D10's drawdown-equals-target fix.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Filter spuelen und Kaffee hinzufuegen.",
        description_template: "Filter spuelen und Kaffee hinzufuegen.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Gieße 25g Wasser auf (Bloom).",
        description_template: "Gieße 25g Wasser auf (Bloom).",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "Bei 0:30 weitere 50-70g Wasser aufgießen.",
        description_template: "Bei 0:30 weitere 50g Wasser aufgießen.",
        duration_seconds: 60,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Auf insgesamt 175g aufgießen.",
        description_template: "Auf insgesamt 175g aufgießen.",
        duration_seconds: 60,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source:
          "Nach einer weiteren Minute auf insgesamt 300g aufgießen.",
        description_template:
          "Nach einer weiteren Minute auf insgesamt 300g aufgießen.",
        duration_seconds: 10,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Vollständig durchlaufen lassen.",
        description_template: "Vollständig durchlaufen lassen.",
        duration_seconds: 10,
        elapsed_seconds: 180,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock German V60 recipe",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d10-german-shape",
  });

  assertEquals(
    result.draft.recipe.brew_time_seconds,
    180,
    "Expected the stated 180s total to be enforced instead of the pre-fix 250s overshoot.",
  );
  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds).reduce(
      (sum, value) => sum + value,
      0,
    ),
    180,
    "Expected brew step durations to sum to exactly the stated 180s target.",
  );
  for (const step of result.draft.steps.filter((s) => s.kind === "brew")) {
    assert(
      step.duration_seconds >= 10,
      `Expected every brew step to stay at or above the 10s minimum. Got: ${
        JSON.stringify(result.draft.steps.map((s) => s.duration_seconds))
      }`,
    );
  }
  assertEquals(
    result.draft.steps[5].elapsed_seconds,
    180,
    "Expected the drawdown's own elapsed_seconds to be left exactly as reported (only its use as a differencing PARTNER is suppressed).",
  );
  assertEquals(
    result.draft.steps[5].step_role,
    "drawdown",
    "Sanity check: this fixture's drawdown is genuinely labelled step_role drawdown.",
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected the corrected 180s total to no longer trip total_brew_time_mismatch.",
  );
  assert(
    !result.validation.issues.some((issue) =>
      issue.code === "total_brew_time_mismatch"
    ),
    `Expected no total_brew_time_mismatch issue. Got: ${
      JSON.stringify(result.validation.issues)
    }`,
  );
});

Deno.test("D10: a drawdown with elapsed_seconds null is unaffected — behaves exactly as it did before this fix (control)", async () => {
  // Identical German recipe to the test above, except the drawdown never
  // carried an elapsed_seconds at all (mirrors the fourth live capture,
  // which never hit this defect and already landed on 180s throughout).
  // A null elapsed_seconds was never part of `timestamped` to begin with,
  // so isUntrustworthyDrawdownEndMarker never has a candidate to consider
  // for this shape — confirmed by diffing this test's output against the
  // pre-D10 parser.ts: byte-identical.
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "de",
    likely_brewing_method: "V60",
    name: "D10 control null elapsed",
    short_description: "Control: drawdown elapsed null.",
    grind_size: "Mittel",
    water_temp_celsius: 93,
    coffee_amount_grams: 20,
    water_amount: 300,
    preparation: "Filter spuelen und Kaffee hinzufuegen.",
    steps: [
      {
        title: null,
        raw_text: "Gieße 25g Wasser auf (Bloom).",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "Bei 0:30 auf insgesamt 50-70g Wasser aufgießen.",
        duration_seconds: 60,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Bei 1:30 auf insgesamt 175g Wasser aufgießen.",
        duration_seconds: 13,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Auf insgesamt 300g Wasser aufgießen.",
        duration_seconds: 16,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Vollständig durchlaufen lassen.",
        duration_seconds: 61,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 180,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "de",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 20,
      water_amount: 300,
      water_temp: 93,
    },
    localization: {
      name: "D10 control null elapsed",
      grind_size: "Mittel",
      short_description: "Control: drawdown elapsed null.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Filter spuelen und Kaffee hinzufuegen.",
        description_template: "Filter spuelen und Kaffee hinzufuegen.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Gieße 25g Wasser auf (Bloom).",
        description_template: "Gieße 25g Wasser auf (Bloom).",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "Bei 0:30 auf insgesamt 50-70g Wasser aufgießen.",
        description_template: "Bei 0:30 auf insgesamt 50g Wasser aufgießen.",
        duration_seconds: 60,
        elapsed_seconds: 30,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Bei 1:30 auf insgesamt 175g Wasser aufgießen.",
        description_template: "Bei 1:30 auf insgesamt 175g Wasser aufgießen.",
        duration_seconds: 13,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Auf insgesamt 300g Wasser aufgießen.",
        description_template: "Auf insgesamt 300g Wasser aufgießen.",
        duration_seconds: 16,
        elapsed_seconds: 90,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Vollständig durchlaufen lassen.",
        description_template: "Vollständig durchlaufen lassen.",
        duration_seconds: 61,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock German V60 recipe, null-elapsed drawdown",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d10-control-null-elapsed",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 30, 60, 16, 16, 58],
    "Expected the exact same split this shape already produced before D10 (a null elapsed_seconds was never part of the differencing pool).",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    180,
    "Expected the stated 180s total, unaffected by this fix.",
  );
  assertEquals(
    result.validation.is_publishable,
    true,
    "Expected this control to remain publishable, exactly as before.",
  );
});

Deno.test("D10: two consecutive brew steps sharing the same elapsed_seconds are landmark-resolution noise, not a zero-duration anchor (unaffected by this fix)", async () => {
  // Isolates the collision case named in plan 020 D10 explicitly: two
  // steps resolving to the identical elapsed_seconds (a source landmark
  // being restated, not two genuinely simultaneous actions) must not be
  // read as "this step's duration is 0" and anchored at zero — the
  // pre-existing `naturalDuration >= MIN_BREW_STEP_DURATION_SECONDS` guard
  // already protects this, and no drawdown-equals-target marker is
  // involved here at all, so this fixture's result must be byte-identical
  // before and after the D10 fix (confirmed by diffing against the
  // pre-fix parser.ts).
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "D10 landmark collision",
    short_description: "Tests shared elapsed noise is not turned into a zero anchor.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 18,
    water_amount: 280,
    preparation: "Rinse filter and add coffee.",
    steps: [
      {
        title: null,
        raw_text: "Bloom with water.",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "At 1:35 put the pitcher on.",
        duration_seconds: 5,
        elapsed_seconds: 95,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "At 1:40, pour to the top.",
        duration_seconds: 40,
        elapsed_seconds: 95,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Let it draw down.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 150,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 18,
      water_amount: 280,
      water_temp: 93,
    },
    localization: {
      name: "D10 landmark collision",
      grind_size: "Medium",
      short_description:
        "Tests shared elapsed noise is not turned into a zero anchor.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse filter and add coffee.",
        description_template: "Rinse filter and add coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Bloom with water.",
        description_template: "Bloom with water.",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "At 1:35 put the pitcher on.",
        description_template: "At 1:35 put the pitcher on.",
        duration_seconds: 5,
        elapsed_seconds: 95,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "At 1:40, pour to the top.",
        description_template: "At 1:40, pour to the top.",
        duration_seconds: 40,
        elapsed_seconds: 95,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Let it draw down.",
        description_template: "Let it draw down.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe with a shared elapsed landmark",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d10-landmark-collision",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 95, 15, 15, 25],
    "Expected the tied-elapsed pair to both stay DERIVED (never a zero/sub-minimum anchor) and the total to still land on 150s.",
  );
  assert(
    result.draft.steps[2].duration_seconds >= 10 &&
      result.draft.steps[3].duration_seconds >= 10,
    "Expected neither step of the tied-elapsed pair to fall below the 10s minimum.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    150,
    "Expected the stated 150s total, unaffected by this fix.",
  );
});

Deno.test("D10: a genuinely starved allocation (legitimate duration_is_stated anchors) still leaves the split declining to assign — the bail-out itself is untouched", async () => {
  // Confirms this fix touches only the ANCHORING decision, not the
  // pre-existing splitDerivedBrewStepDurationsFromTarget bail-out guard
  // the plan explicitly says not to touch. Two duration_is_stated steps
  // (bloom 30s, pour 120s = 150s) legitimately anchor themselves, leaving
  // only 5s of a 155s target for two derived steps that each need at least
  // the 10s minimum — a real (not falsely-manufactured) starved case, so
  // the split must still decline exactly as it did before this fix. The
  // two derived steps' raw guesses (5s each) survive the split's bail-out
  // and are then bumped to the 10s floor by the separate, unrelated
  // enforceMinimumStepDurations pass, landing on 170s against the stated
  // 155s (blocked) — byte-identical before and after D10 (confirmed by
  // diffing against the pre-fix parser.ts).
  const extraction: ExtractionResult = {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "D10 starved allocation",
    short_description:
      "Tests the pre-existing bail-out still fires for a LEGITIMATE anchor.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 18,
    water_amount: 280,
    preparation: "Rinse filter and add coffee.",
    steps: [
      {
        title: null,
        raw_text: "Bloom for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        title: null,
        raw_text: "Pour for 120 seconds.",
        duration_seconds: 120,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        title: null,
        raw_text: "Then quickly swirl.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Let it draw down.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
    notes: [],
    total_brew_time_seconds: 155,
  };
  const normalized: NormalizedDraft = {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 18,
      water_amount: 280,
      water_temp: 93,
    },
    localization: {
      name: "D10 starved allocation",
      grind_size: "Medium",
      short_description:
        "Tests the pre-existing bail-out still fires for a LEGITIMATE anchor.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse filter and add coffee.",
        description_template: "Rinse filter and add coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "preparation",
      },
      {
        kind: "brew",
        description_source: "Bloom for 30 seconds.",
        description_template: "Bloom for 30 seconds.",
        duration_seconds: 30,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "bloom",
      },
      {
        kind: "brew",
        description_source: "Pour for 120 seconds.",
        description_template: "Pour for 120 seconds.",
        duration_seconds: 120,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: "pour",
      },
      {
        kind: "brew",
        description_source: "Then quickly swirl.",
        description_template: "Then quickly swirl.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Let it draw down.",
        description_template: "Let it draw down.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: "drawdown",
      },
    ],
  };

  const parser = createRecipeDraftParser({
    providers: [
      createMockProvider({
        name: "groq",
        extraction,
        normalized,
        calls: [],
      }),
    ],
    now: () => 1776000000000,
  });

  const result = await parser.parseDraft({
    text: "Mock recipe with a genuinely starved allocation",
    userId: "800792ab-c2ef-49f3-8d6a-c5dceaf71459",
    brewingMethods: [
      { brewing_method_id: "v60", brewing_method: "Hario V60" },
    ],
    requestId: "req-d10-starved-allocation",
  });

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 30, 120, 10, 10],
    "Expected the two duration_is_stated anchors to survive untouched (30, 120) and the two derived steps to be bumped from their raw 5s guesses to the 10s minimum by enforceMinimumStepDurations — NOT reconciled to the 155s target, since the split's bail-out guard must still decline when there is genuinely no room.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    170,
    "Expected brew_time_seconds to be the actual (mismatched) sum, 170s — every brew step is at or above the minimum by the time this is computed, so it is not null; it simply does not match the stated 155s target.",
  );
  assert(
    result.validation.issues.some((issue) =>
      issue.code === "total_brew_time_mismatch"
    ),
    "Expected the genuine 170s-vs-155s mismatch to still be flagged — this fix must not suppress a real mismatch.",
  );
});
