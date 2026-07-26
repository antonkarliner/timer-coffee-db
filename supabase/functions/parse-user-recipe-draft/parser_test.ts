import {
  createRecipeDraftParser,
  type CumulativeRewriteResult,
  type ExtractionResult,
  type NormalizedDraft,
  type RecipeDraftAiProvider,
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
  systemPrompts?: Array<{ provider: string; stage: string; systemPrompt: string }>;
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

function createExtraction(): ExtractionResult {
  return {
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
      },
      {
        title: null,
        raw_text: "Pour 50g of water and bloom for 30 seconds.",
        duration_seconds: 30,
      },
      {
        title: null,
        raw_text: "Pour to 250g total and wait 90 seconds.",
        duration_seconds: 90,
      },
    ],
    notes: [],
  };
}

function createNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom for 30 seconds.",
        description_template: "Pour 50g of water and bloom.",
        duration_seconds: 30,
      },
      {
        kind: "brew",
        description_source: "Pour to 250g total and wait 90 seconds.",
        description_template: "Pour up to 250g total and wait.",
        duration_seconds: 90,
      },
    ],
  };
}

function createAmbiguousWaterNormalized(): NormalizedDraft {
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
      },
      {
        kind: "brew",
        description_source: "Pour 30g water for bloom.",
        description_template: "Pour 30g water for bloom.",
        duration_seconds: 30,
      },
    ],
  };
}

function createMissingRequiredNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom for 30 seconds.",
        description_template: "Pour 50g of water and bloom.",
        duration_seconds: 30,
      },
    ],
  };
}

function createRepairNormalized(): NormalizedDraft {
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
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom for 30 seconds.",
        description_template: "Pour 50g of water and bloom.",
        duration_seconds: 30,
      },
    ],
  };
}

function createDisplayNameMethodNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source: "Pour 50g water for bloom.",
        description_template: "Pour 50g water for bloom.",
        duration_seconds: 30,
      },
    ],
  };
}

function createTemperatureMentionNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source: "Pour 50g water and bloom for 30 seconds.",
        description_template: "Pour 50g water and bloom for 30 seconds.",
        duration_seconds: 30,
      },
    ],
  };
}

function createMalformedExpressionNormalized(): NormalizedDraft {
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
      },
      {
        kind: "brew",
        description_source: "Pour 50g water for bloom.",
        description_template:
          "Pour (N x <final_water_amount>)g water for bloom.",
        duration_seconds: 30,
      },
    ],
  };
}

function createNestedExpressionMathExtraction(): ExtractionResult {
  return {
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
      },
      {
        title: "Main pour",
        raw_text: "Pour up to 700g total.",
        duration_seconds: 120,
      },
    ],
    notes: [],
  };
}

function createNestedExpressionMathNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source:
          "Start the timer and begin the first pour, adding about 140g of water.",
        description_template:
          "Start the timer and begin the first pour, adding about (0.2 x (1 x <final_water_amount>)g of water.",
        duration_seconds: 45,
      },
      {
        kind: "brew",
        description_source: "Pour up to 700g total.",
        description_template: "Pour up to (1 x <final_water_amount>)g total.",
        duration_seconds: 120,
      },
    ],
  };
}

function createTooShortBrewDurationsNormalized(): NormalizedDraft {
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
      },
      {
        kind: "brew",
        description_source: "Pour 50g of water and bloom briefly.",
        description_template: "Pour 50g of water and bloom briefly.",
        duration_seconds: 3,
      },
      {
        kind: "brew",
        description_source: "Pour up to 250g total and wait briefly.",
        description_template: "Pour up to 250g total and wait briefly.",
        duration_seconds: 4,
      },
    ],
  };
}

function createTetsuTimestampExtraction(): ExtractionResult {
  return {
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
      },
      {
        title: null,
        raw_text: "0:45 pour to 120g",
        duration_seconds: 45,
      },
      {
        title: null,
        raw_text: "1:30 pour to 180g",
        duration_seconds: 90,
      },
      {
        title: null,
        raw_text: "2:15 pour to 240g",
        duration_seconds: 135,
      },
      {
        title: null,
        raw_text: "3:00 pour to 300g",
        duration_seconds: 180,
      },
      {
        title: null,
        raw_text: "Let draw down fully and serve.",
        duration_seconds: null,
      },
    ],
    notes: [],
  };
}

function createTetsuTimestampNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source: "0:00 pour 50g",
        description_template: "At 0:00, pour to 50g.",
        duration_seconds: 0,
      },
      {
        kind: "brew",
        description_source: "0:45 pour to 120g",
        description_template: "At 0:45, pour to 120g.",
        duration_seconds: 45,
      },
      {
        kind: "brew",
        description_source: "1:30 pour to 180g",
        description_template: "At 1:30, pour to 180g.",
        duration_seconds: 90,
      },
      {
        kind: "brew",
        description_source: "2:15 pour to 240g",
        description_template: "At 2:15, pour to 240g.",
        duration_seconds: 135,
      },
      {
        kind: "brew",
        description_source: "3:00 pour to 300g",
        description_template: "At 3:00, pour to 300g.",
        duration_seconds: 180,
      },
      {
        kind: "brew",
        description_source: "Let draw down fully and serve.",
        description_template: "Let draw down fully and serve.",
        duration_seconds: 185,
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
      },
      {
        title: null,
        raw_text:
          "Start the second pour at 45 seconds. Using the same pour pattern, spiral out towards the edge of the slurry before spiraling back. Unlike some other brewers, avoid pouring directly on the filter and bring the water weight up to 300 grams. The water should filter through the grounds almost completely before starting the next pour.",
        duration_seconds: null,
      },
      {
        title: null,
        raw_text:
          "At a minute and 50 seconds, start your third pour, still using the same pouring pattern. Bringing the water weight up to 500 grams. Pause again, allowing the water to filter through the grounds.",
        duration_seconds: null,
      },
      {
        title: null,
        raw_text:
          "Begin the fourth and final pour at 3 minutes and 10 seconds. Still focusing on a consistent pour pattern, bring the water weight up to 700 grams.",
        duration_seconds: null,
      },
    ],
    notes: [
      "Timed references like 45 seconds, a minute and 50 seconds, and 3 minutes and 10 seconds are elapsed brew times, not step durations.",
    ],
  };
}

function createChemexNaturalElapsedNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[0].raw_text,
        description_template:
          "Start the timer and pour up to 100g, spiraling from the center out and back until the coffee is completely saturated.",
        duration_seconds: 45,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[1].raw_text,
        description_template:
          "At 45 seconds, pour up to 300g using the same spiral pattern, avoiding the filter, and let the water drain almost completely before the next pour.",
        duration_seconds: 65,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[2].raw_text,
        description_template:
          "pour up to 500g using the same pouring pattern, then pause and let the water filter through.",
        duration_seconds: 80,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[3].raw_text,
        description_template: "pour up to 700g with a consistent pour pattern.",
        duration_seconds: 5,
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
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[0].raw_text,
        description_template:
          "Start your timer and begin your first pour, known as the Bloom pour. Starting in the center, spiral your pour out and back until the coffee is completely saturated. Target adding around 100 grams of water.",
        duration_seconds: 45,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[1].raw_text,
        description_template:
          "Now start the second pour. Using the same pour pattern, spiral out towards the edge of the slurry before spiraling back. Unlike some other brewers, avoid pouring directly on the filter and bring the water weight up to 300 grams. The water should filter through the grounds almost completely before starting the next pour.",
        duration_seconds: 65,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[2].raw_text,
        description_template:
          "At a minute and 50 seconds, start your third pour, still using the same pouring pattern. Bringing the water weight up to 500 grams. Pause again, allowing the water to filter through the grounds.",
        duration_seconds: 80,
      },
      {
        kind: "brew",
        description_source:
          createChemexNaturalElapsedExtraction().steps[3].raw_text,
        description_template:
          "Begin the fourth and final pour. Still focusing on a consistent pour pattern, bring the water weight up to 700 grams.",
        duration_seconds: 5,
      },
    ],
  };
}

function createChemexCoffeeMakerExtraction(): ExtractionResult {
  return {
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
      },
      {
        title: "Pour",
        raw_text:
          "I would say a similar pouring technique in terms of phases to the V60 video",
        duration_seconds: null,
      },
      {
        title: "Finish",
        raw_text:
          "At the end, you're going to do the same thing with a little stir and then a swirl to help the drawdown and have a flat bed.",
        duration_seconds: null,
      },
    ],
    notes: [
      "The recipe states 60 grams per liter and also says brewing half a liter will use four to five minute brew times; water_amount is inferred as 500 from half a liter.",
    ],
  };
}

function createChemexCoffeeMakerNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source:
          createChemexCoffeeMakerExtraction().steps[0].raw_text,
        description_template: "Bloom with 60-90 grams water for 45 seconds.",
        duration_seconds: 45,
      },
      {
        kind: "brew",
        description_source:
          createChemexCoffeeMakerExtraction().steps[1].raw_text,
        description_template:
          "Continue pouring in phases until you reach 500g total water.",
        duration_seconds: 5,
      },
      {
        kind: "brew",
        description_source:
          createChemexCoffeeMakerExtraction().steps[2].raw_text,
        description_template:
          "Stir lightly, then swirl to level the bed and finish drawdown.",
        duration_seconds: 5,
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
      },
      {
        title: null,
        raw_text: "Begin the first staged pour and continue in pulses.",
        duration_seconds: 45,
      },
    ],
    notes: [],
  };
}

function createPrepHeavyChemexNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source:
          "Begin the first staged pour and continue in pulses.",
        description_template:
          "Begin the first staged pour and continue in pulses.",
        duration_seconds: 45,
      },
    ],
  };
}

function createKimexExtraction(): ExtractionResult {
  return {
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
      },
      {
        title: "Second bloom",
        raw_text:
          "At 30 seconds, pour another 100g of water, then swirl until clumps disappear and gases are released.",
        duration_seconds: 60,
      },
      {
        title: "Third pour",
        raw_text:
          "One minute later, pour 200g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
        duration_seconds: 60,
      },
      {
        title: "Fourth pour",
        raw_text:
          "After another minute, pour 150g of water, maintaining a gentle swirl to avoid over-agitation.",
        duration_seconds: 60,
      },
      {
        title: "Final pour",
        raw_text:
          "One minute after the previous pour, add the final 100g of water softly, finish with a light swirl and let the brew drain.",
        duration_seconds: 60,
      },
    ],
    notes: [],
  };
}

function createKimexNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source:
          "Start timer and pour 100g of boiling water into the center, spiraling outward.",
        description_template:
          "Start timer and pour 100g of boiling water into the center, spiraling outward.",
        duration_seconds: 30,
      },
      {
        kind: "brew",
        description_source:
          "At 30 seconds, pour another 100g of water, then swirl until clumps disappear and gases are released.",
        description_template:
          "At 30 seconds, pour another 100g of water, then swirl until clumps disappear and gases are released.",
        duration_seconds: 60,
      },
      {
        kind: "brew",
        description_source:
          "One minute later, pour 200g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
        description_template:
          "One minute later, pour 200g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
        duration_seconds: 60,
      },
      {
        kind: "brew",
        description_source:
          "After another minute, pour 150g of water, maintaining a gentle swirl to avoid over-agitation.",
        description_template:
          "After another minute, pour 150g of water, maintaining a gentle swirl to avoid over-agitation.",
        duration_seconds: 60,
      },
      {
        kind: "brew",
        description_source:
          "One minute after the previous pour, add the final 100g of water softly, finish with a light swirl and let the brew drain.",
        description_template:
          "One minute after the previous pour, add the final 100g of water softly, finish with a light swirl and let the brew drain.",
        duration_seconds: 60,
      },
    ],
  };
}

function createFrenchIncrementalExtraction(): ExtractionResult {
  return {
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
      },
      {
        title: null,
        raw_text:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        duration_seconds: 60,
      },
    ],
    notes: [],
  };
}

function createFrenchIncrementalNormalized(): NormalizedDraft {
  return {
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
      },
      {
        kind: "brew",
        description_source: "Démarrez le minuteur et versez 100 g d’eau.",
        description_template: "Démarrez le minuteur et versez 100 g d’eau.",
        duration_seconds: 30,
      },
      {
        kind: "brew",
        description_source:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        description_template:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        duration_seconds: 60,
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
      },
      {
        kind: "brew",
        description_source: "Démarrez le minuteur et versez 100 g d’eau.",
        description_template:
          "Démarrez le minuteur et versez (0.5 x <final_water_amount>)g d’eau.",
        duration_seconds: 30,
      },
      {
        kind: "brew",
        description_source:
          "À 30 secondes, versez encore 100 g d’eau puis remuez doucement.",
        description_template:
          "À 30 secondes, versez jusqu’à (1 x <final_water_amount>)g d’eau puis remuez doucement.",
        duration_seconds: 60,
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

  assertEquals(
    result.provider_used,
    "groq",
    "Expected the second Groq model to finish normalization.",
  );
  assertEquals(
    result.provider_model_used,
    "groq/openai/gpt-oss-20b",
    "Expected provider_model_used to identify the exact final model.",
  );
  assertEquals(
    calls,
    [
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/compound-mini", stage: "normalization" },
      { provider: "groq/openai/gpt-oss-20b", stage: "normalization" },
    ],
    "Expected pass 1 to be preserved when pass 2 falls back.",
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
      { provider: "groq/compound-mini", stage: "extraction" },
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
      { provider: "groq/compound-mini", stage: "extraction" },
      { provider: "groq/openai/gpt-oss-20b", stage: "extraction" },
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

  assertEquals(
    result.draft.steps.map((step) => step.duration_seconds),
    [0, 45, 65, 80, 10, 40],
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
    ["0", "45", "65", "80", "10", "40"],
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

Deno.test("condenses verbose Chemex transcript prose into timer-ready steps", async () => {
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

  assertEquals(
    result.draft.steps.map((step) => step.description_template),
    [
      "Prepare a 6 cup Chemex with a Chemex filter, heat water, place and rinse the filter with the trifold facing the spout, grind (1 x <final_coffee_amount>)g coffee medium coarse, level the bed, and tare the scale.",
      "Start the timer and pour up to (0.14286 x <final_water_amount>)g, spiraling from the center out and back.",
      "Pour up to (0.42857 x <final_water_amount>)g using the same spiral pattern, avoiding the filter, and let it drain almost completely.",
      "Pour up to (0.71429 x <final_water_amount>)g using the same pouring pattern, then pause and let it drain.",
      "Pour up to (1 x <final_water_amount>)g with a consistent pour pattern.",
      "Wait for the complete drawdown.",
    ],
    "Expected verbose transcript-like templates to become concise brewing instructions.",
  );
  assertEquals(
    result.draft.steps[1].preview_text,
    "Start the timer and pour up to 100g, spiraling from the center out and back.",
    "Expected backend preview text to separate word units from amounts.",
  );
  assert(
    !result.draft.steps.some((step) =>
      /known as|unlike some other brewers|helps prevent|off-flavors/i.test(
        step.description_template,
      )
    ),
    "Expected explanatory transcript prose to be removed from stored templates.",
  );
});

Deno.test("infers vague Chemex pour and drawdown durations from stated total brew time", async () => {
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
    [0, 45, 45, 150],
    "Expected vague Chemex pour and drawdown durations to use the stated 4 minute lower-bound brew time.",
  );
  assertEquals(
    result.draft.recipe.brew_time_seconds,
    240,
    "Expected brew time to match the inferred total brew time lower bound.",
  );
  assertEquals(
    result.publish_projection?.user_steps.map((step) => step.time),
    ["0", "45", "45", "150"],
    "Expected publish projection step times to match inferred durations.",
  );
  assert(
    result.warnings.some((warning) =>
      warning.includes("inferred from the stated total brew time")
    ),
    "Expected inferred vague-duration repair to be surfaced as a warning.",
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
      "Start timer and pour (0.15385 x <final_water_amount>)g of boiling water into the center, spiraling outward.",
      "At 30 seconds, pour up to (0.30769 x <final_water_amount>)g of water, then swirl until clumps disappear and gases are released.",
      "One minute later, pour up to (0.61538 x <final_water_amount>)g of water aggressively, using gentle circles in the middle and a light swirl to settle the bed.",
      "After another minute, pour up to (0.84615 x <final_water_amount>)g of water, maintaining a gentle swirl to avoid over-agitation.",
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

function createMixedContextNormalized(): NormalizedDraft {
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
      },
      {
        kind: "brew",
        description_source:
          "Pour 50gr of hot water. Then add 15g coffee and stir.",
        description_template:
          "Pour 50gr of hot water. Then add 15g coffee and stir.",
        duration_seconds: 90,
      },
      {
        kind: "brew",
        description_source: "Add coffee 30g water",
        description_template: "Add coffee 30g water",
        duration_seconds: 30,
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
