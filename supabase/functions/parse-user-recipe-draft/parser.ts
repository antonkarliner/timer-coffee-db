import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

export type LlmProviderName = "groq" | "cerebras" | "openai" | "gemini";

export type Logger = Pick<Console, "info" | "warn" | "error">;

export type BrewingMethodOption = {
  brewing_method_id: string;
  brewing_method: string;
};

export const parseUserRecipeDraftRequestSchema = z.object({
  text: z.string().trim().min(1, "text is required"),
  brewing_method_id: z.string().trim().min(1).optional(),
  source_language_hint: z.string().trim().min(1).optional(),
});

const extractedStepSchema = z.object({
  title: z.string().trim().min(1).nullable().default(null),
  raw_text: z.string().trim().min(1),
  duration_seconds: z.number().int().nonnegative().nullable().default(null),
});

export const extractionSchema = z.object({
  detected_input_language: z.string().trim().min(1).nullable().default(null),
  likely_brewing_method: z.string().trim().min(1).nullable().default(null),
  name: z.string().trim().min(1).nullable().default(null),
  short_description: z.string().trim().min(1).nullable().default(null),
  grind_size: z.string().trim().min(1).nullable().default(null),
  water_temp_celsius: z.number().nullable().default(null),
  coffee_amount_grams: z.number().positive().nullable().default(null),
  water_amount: z.number().positive().nullable().default(null),
  preparation: z.string().trim().min(1).nullable().default(null),
  steps: z.array(extractedStepSchema).min(1),
  notes: z.array(z.string()).default([]),
});

const normalizedStepSchema = z.object({
  kind: z.enum(["preparation", "brew"]),
  description_source: z.string().trim().min(1),
  description_template: z.string().trim().min(1),
  duration_seconds: z.number().int().nonnegative(),
});

export const normalizedDraftSchema = z.object({
  detected_input_language: z.string().trim().min(1).nullable().default(null),
  warnings: z.array(z.string()).default([]),
  recipe: z.object({
    brewing_method_id: z.string().trim().min(1).nullable().default(null),
    brewing_method_confidence: z
      .enum(["high", "medium", "low", "none"])
      .default("none"),
    coffee_amount: z.number().positive().nullable().default(null),
    water_amount: z.number().positive().nullable().default(null),
    water_temp: z.number().positive().nullable().default(null),
  }),
  localization: z.object({
    name: z.string().trim().min(1).nullable().default(null),
    grind_size: z.string().trim().min(1).nullable().default(null),
    short_description: z.string().trim().min(1).nullable().default(null),
  }),
  steps: z.array(normalizedStepSchema).min(1),
});

const cumulativeRewriteSchema = z.object({
  warnings: z.array(z.string()).default([]),
  steps: z.array(normalizedStepSchema).min(1),
});

export type ParseUserRecipeDraftRequest = z.infer<
  typeof parseUserRecipeDraftRequestSchema
>;
export type ExtractionResult = z.infer<typeof extractionSchema>;
export type NormalizedDraft = z.infer<typeof normalizedDraftSchema>;
export type CumulativeRewriteResult = z.infer<typeof cumulativeRewriteSchema>;

export type DraftExpression = {
  placeholder: "<final_coffee_amount>" | "<final_water_amount>";
  multiplier: number;
  unit: string;
  preview_value: number | null;
};

export type ValidationIssue = {
  code: string;
  field: string;
  message: string;
};

export type DraftStep = {
  step_order: number;
  kind: "preparation" | "brew";
  description_source: string;
  description_template: string;
  preview_text: string;
  duration_seconds: number;
  expressions: DraftExpression[];
};

export type PublishProjection = {
  user_recipe: {
    id: string;
    brewing_method_id: string;
    coffee_amount: number;
    water_amount: number;
    water_temp: number;
    brew_time: number;
    vendor_id: string;
    last_modified: string;
    import_id: null;
    is_imported: false;
    ispublic: false;
    is_deleted: false;
    needs_moderation_review: false;
  };
  user_recipe_localization: {
    id: string;
    recipe_id: string;
    locale: "en";
    name: string;
    grind_size: string;
    short_description: string;
  };
  user_steps: Array<{
    id: string;
    recipe_id: string;
    step_order: number;
    description: string;
    time: string;
    locale: "en";
  }>;
};

export type ParseUserRecipeDraftResponse = {
  detected_input_language: string | null;
  provider_used: LlmProviderName;
  provider_model_used: string;
  tokens_used: number;
  openai_tokens_used: number;
  warnings: string[];
  validation: {
    is_publishable: boolean;
    issues: ValidationIssue[];
  };
  extraction: ExtractionResult;
  draft: {
    recipe: {
      brewing_method_id: string | null;
      coffee_amount: number | null;
      water_amount: number | null;
      water_temp: number | null;
      brew_time_seconds: number | null;
      vendor_id: string;
    };
    localization: {
      locale: "en";
      name: string | null;
      grind_size: string | null;
      short_description: string | null;
    };
    steps: DraftStep[];
  };
  publish_projection?: PublishProjection;
};

type ProviderInvocation<T> = {
  requestId: string;
  stage:
    | "extraction"
    | "normalization"
    | "repair"
    | "cumulative_rewrite";
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
};

export type RecipeDraftAiProvider = {
  name: LlmProviderName;
  model: string;
  invokeJson<T>(
    input: ProviderInvocation<T>,
  ): Promise<{ result: T; tokensUsed: number }>;
};

export type RecipeDraftParserConfig = {
  groqApiKey?: string;
  cerebrasApiKey?: string;
  openAiApiKey?: string;
  geminiServiceAccountKeyJson?: string;
  geminiProjectId?: string;
  geminiRegion?: string;
  geminiModel?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  providers?: RecipeDraftAiProvider[];
};

export type RecipeDraftParserInput = {
  text: string;
  userId: string;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
  sourceLanguageHint?: string;
  requestId: string;
  disabledProviders?: LlmProviderName[];
};

export type RecipeDraftParser = {
  parseDraft(
    input: RecipeDraftParserInput,
  ): Promise<ParseUserRecipeDraftResponse>;
};

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const OPENAI_CHAT_COMPLETIONS_URL =
  "https://api.openai.com/v1/chat/completions";
const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";
const CEREBRAS_CHAT_COMPLETIONS_URL =
  "https://api.cerebras.ai/v1/chat/completions";
const FORBIDDEN_TIME_PLACEHOLDER_REGEX = /<t\d+>/i;
const MIN_BREW_STEP_DURATION_SECONDS = 10;
const FINAL_TIMESTAMPED_STEP_DURATION_SECONDS = 10;
const DRAWDOWN_STEP_DURATION_SECONDS = 30;
const DEFAULT_VAGUE_POUR_DURATION_SECONDS = 30;
const LARGE_CHEMEX_VAGUE_POUR_DURATION_SECONDS = 45;
const UNSUPPORTED_PLACEHOLDER_REGEX = /<([^>]+)>/g;
const SUPPORTED_PLACEHOLDER_REGEX =
  /<(final_coffee_amount|final_water_amount)>/gi;
const EXPRESSION_REGEX =
  /\(([\d.]+)\s*(?:x|×)\s*<(final_coffee_amount|final_water_amount)>\)\s*([^\s<>().,;:!?\-–—]*)/gi;
const SCALABLE_UNITS = [
  "g",
  "g.",
  "gs",
  "ml",
  "ml.",
  "mll",
  "oz",
  "oz.",
  "ozs",
  "l",
  "l.",
  "ls",
  "gram",
  "grams",
  "milliliter",
  "milliliters",
  "ounce",
  "ounces",
  "liter",
  "liters",
  "gramme",
  "grammes",
  "millilitre",
  "millilitres",
  "once",
  "onces",
  "litre",
  "litres",
  "غ",
  "غ.",
  "جرام",
  "جرامات",
  "مل",
  "مل.",
  "ملليلتر",
  "أونصة",
  "لتر",
  "gramo",
  "gramos",
  "mililitro",
  "mililitros",
  "onza",
  "onzas",
  "litro",
  "litros",
  "گرم",
  "گرم.",
  "میلی‌لیتر",
  "اونس",
  "لیتر",
  "gramm",
  "grammen",
  "gramms",
  "unze",
  "unzen",
  "mililiter",
  "ons",
  "grammo",
  "grammi",
  "millilitro",
  "millilitri",
  "oncia",
  "グラム",
  "ミリリットル",
  "オンス",
  "リットル",
  "그램",
  "밀리리터",
  "온스",
  "리터",
  "gramy",
  "mililitr",
  "mililitry",
  "uncja",
  "uncje",
  "litr",
  "litry",
  "grama",
  "gramas",
  "mililitru",
  "mililitri",
  "uncie",
  "uncii",
  "litru",
  "litri",
  "грамм",
  "граммы",
  "миллилитр",
  "миллилитры",
  "унция",
  "унции",
  "литр",
  "литры",
  "mililitre",
  "грам",
  "грами",
  "мілілітр",
  "мілілітри",
  "унція",
  "унції",
  "літр",
  "літри",
  "克",
  "毫升",
  "盎司",
  "升",
] as const;
const COFFEE_CONTEXT_KEYWORDS = [
  "coffee",
  "bean",
  "beans",
  "ground",
  "grounds",
  "grind",
  "dose",
] as const;
const DIAGNOSTIC_NOTE_KEYWORDS = [
  "infer",
  "inference",
  "ambig",
  "uncertain",
  "confidence",
  "convert",
  "converted",
  "normalize",
  "normalized",
  "repair",
  "repaired",
  "missing",
  "unresolved",
  "resolved",
  "estimate",
  "estimated",
  "approx",
  "fallback",
  "placeholder",
  "expression",
  "fahrenheit",
  "celsius",
  "invalid",
  "schema",
  "malformed",
] as const;
const PREPARATION_DETAIL_KEYWORDS = [
  "rinse",
  "rinsed",
  "filter",
  "paper",
  "silicone",
  "chute",
  "stir stick",
  "stirrer",
  "chopstick",
  "cover",
  "cut",
  "cutting",
  "fold",
  "flap",
  "preheat",
  "pre-heated",
  "discard",
  "tool",
  "modify",
  "modified",
  "bleached",
  "setup",
  "prepare",
  "placed",
  "piece",
] as const;
const ENGLISH_STEP_HINTS = [
  "pour",
  "add",
  "water",
  "bloom",
  "seconds",
  "minute",
  "minutes",
  "rinse",
  "filter",
  "coffee",
  "swirl",
  "drain",
  "drawdown",
] as const;
const SHORT_DESCRIPTION_CONTEXT_PATTERNS = [
  {
    regex: /\bmodified filter(?: setup)?\b/i,
    label: "modified filter",
  },
  {
    regex: /\bsilicone (?:chute )?cover\b/i,
    label: "silicone chute cover",
  },
  {
    regex: /\bbleached filter\b/i,
    label: "bleached filter",
  },
  {
    regex: /\bcloth filter\b/i,
    label: "cloth filter",
  },
  {
    regex: /\bmetal filter\b/i,
    label: "metal filter",
  },
  {
    regex: /\bstaged pours?\b/i,
    label: "staged pours",
  },
  {
    regex: /\bpulsed pours?\b/i,
    label: "pulsed pours",
  },
] as const;
const WATER_CONTEXT_KEYWORDS = [
  "water",
  "pour",
  "pours",
  "bloom",
  "pulse",
  "rinse",
  "rinsed",
  "wet",
  "kettle",
  "drawdown",
  "drain",
  "draining",
  "total",
  "reach",
  "reaching",
] as const;
const RATE_CONTEXT_REGEX =
  /^\s*(?:\/\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes|l|liter|litre|liters|litres)|per\s+(?:second|seconds|sec|secs|minute|minutes|min|mins|liter|litre|liters|litres))/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NUMERIC_SCALABLE_AMOUNT_REGEX = new RegExp(
  `\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(${
    [...SCALABLE_UNITS]
      .sort((left, right) => right.length - left.length)
      .map((unit) => escapeRegExp(unit))
      .join("|")
  })(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);
const NUMERIC_SCALABLE_RANGE_REGEX = new RegExp(
  `\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(?:-|–|—|to)\\s*\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(${
    [...SCALABLE_UNITS]
      .sort((left, right) => right.length - left.length)
      .map((unit) => escapeRegExp(unit))
      .join("|")
  })(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);
const MULTIPLIER_LITERAL_AMOUNT_REGEX = new RegExp(
  `\\(?([\\d]+(?:\\.\\d+)?)\\)?\\s*(?:x|×)\\s*([\\d]+(?:\\.\\d+)?)\\)?\\s*(${
    [...SCALABLE_UNITS]
      .sort((left, right) => right.length - left.length)
      .map((unit) => escapeRegExp(unit))
      .join("|")
  })(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);
const NESTED_PLACEHOLDER_EXPRESSION_REGEX =
  /\(?([\d.]+)\)?\s*(?:x|×)\s*\(([\d.]+)\s*(?:x|×)\s*<(final_coffee_amount|final_water_amount)>\)\)?\s*([^\s<>()]*)/gi;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeKeywordText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeBrewingMethodToken(value: string): string {
  return normalizeKeywordText(value).replace(/[^a-z0-9]+/g, "");
}

function capitalizeFirst(value: string): string {
  if (!value.length) {
    return value;
  }

  return value[0].toUpperCase() + value.slice(1);
}

function joinNaturalList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0];
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function formatMultiplier(multiplier: number): string {
  if (Math.abs(multiplier - Math.round(multiplier)) < 0.01) {
    return String(Math.round(multiplier));
  }

  return multiplier.toFixed(5).replace(/\.?0+$/, "");
}

function formatTemperatureNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

function convertFahrenheitToCelsius(value: number): number {
  return Number((((value - 32) * 5) / 9).toFixed(1));
}

function normalizeTemperatureToCelsius(
  value: number | null,
): { value: number | null; wasConverted: boolean } {
  if (value === null || !Number.isFinite(value)) {
    return {
      value: null,
      wasConverted: false,
    };
  }

  if (value > 120 && value <= 260) {
    return {
      value: Number((((value - 32) * 5) / 9).toFixed(1)),
      wasConverted: true,
    };
  }

  return {
    value: Number(value.toFixed(1)),
    wasConverted: false,
  };
}

const TEMPERATURE_MENTION_REGEX =
  /\b(\d+(?:\.\d+)?)\s*(?:[°º]\s*)?(?:degrees?\s*)?(c|f|celsius|fahrenheit|centigrade)\b/gi;

function normalizeTemperatureMentionsInText(
  value: string,
): { text: string; wasNormalized: boolean } {
  let wasNormalized = false;

  const normalizedText = value.replace(
    TEMPERATURE_MENTION_REGEX,
    (fullMatch, numericValue, unitValue) => {
      const numeric = Number(numericValue);
      if (!Number.isFinite(numeric)) {
        return fullMatch;
      }

      const unit = String(unitValue).toLowerCase();
      const normalizedNumeric = unit.startsWith("f")
        ? convertFahrenheitToCelsius(numeric)
        : Number(numeric.toFixed(1));
      const replacement = `${formatTemperatureNumber(normalizedNumeric)}C`;

      if (replacement !== fullMatch) {
        wasNormalized = true;
      }

      return replacement;
    },
  );

  return {
    text: normalizedText,
    wasNormalized,
  };
}

function normalizeExtractionTemperatures(
  extraction: ExtractionResult,
): ExtractionResult {
  const normalizedTemperature = normalizeTemperatureToCelsius(
    extraction.water_temp_celsius,
  );

  return {
    ...extraction,
    water_temp_celsius: normalizedTemperature.value,
  };
}

function normalizeDraftTemperatures(
  normalized: NormalizedDraft,
): NormalizedDraft {
  const normalizedTemperature = normalizeTemperatureToCelsius(
    normalized.recipe.water_temp,
  );

  return {
    ...normalized,
    warnings: normalizedTemperature.wasConverted
      ? uniqueStrings([
        ...normalized.warnings,
        "Water temperature was normalized to Celsius.",
      ])
      : normalized.warnings,
    recipe: {
      ...normalized.recipe,
      water_temp: normalizedTemperature.value,
    },
  };
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }

  return "Unknown error";
}

function cloneRegex(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags);
}

function formatCompactNumber(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

function isEnglishLikeLanguage(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "en" ||
    trimmed.startsWith("en-") ||
    trimmed.startsWith("en_")
  ) {
    return true;
  }

  const normalized = normalizeKeywordText(value).replace(/[^a-z]/g, "");
  return normalized === "english";
}

function getPrimaryLanguageSignal(
  values: Array<string | null | undefined>,
): string | null {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function filterDiagnosticNotes(notes: string[]): string[] {
  return uniqueStrings(notes.filter((note) => {
    const normalized = normalizeKeywordText(note);
    return DIAGNOSTIC_NOTE_KEYWORDS.some((keyword) =>
      normalized.includes(keyword)
    );
  }));
}

function containsPreparationDetail(text: string | null): boolean {
  if (!text) {
    return false;
  }

  const normalized = normalizeKeywordText(text);
  return PREPARATION_DETAIL_KEYWORDS.some((keyword) =>
    normalized.includes(keyword)
  );
}

function getBrewingMethodLabel(args: {
  brewingMethods: BrewingMethodOption[];
  brewingMethodId: string | null;
}): string | null {
  if (!args.brewingMethodId) {
    return null;
  }

  return args.brewingMethods.find((method) =>
    method.brewing_method_id === args.brewingMethodId
  )?.brewing_method ?? null;
}

function extractShortDescriptionContextItems(
  texts: Array<string | null>,
): string[] {
  const combinedText = texts.filter(Boolean).join(" ");

  return uniqueStrings(
    SHORT_DESCRIPTION_CONTEXT_PATTERNS
      .filter((pattern) => pattern.regex.test(combinedText))
      .map((pattern) => pattern.label),
  ).slice(0, 3);
}

function synthesizeShortDescription(args: {
  normalized: NormalizedDraft;
  brewingMethods: BrewingMethodOption[];
}): string | null {
  const methodLabel = getBrewingMethodLabel({
    brewingMethods: args.brewingMethods,
    brewingMethodId: args.normalized.recipe.brewing_method_id,
  });
  const coffeeAmount = formatCompactNumber(
    args.normalized.recipe.coffee_amount,
  );
  const waterAmount = formatCompactNumber(args.normalized.recipe.water_amount);
  const grindSize = args.normalized.localization.grind_size?.trim() ?? null;
  const contextItems = extractShortDescriptionContextItems([
    args.normalized.localization.short_description,
    args.normalized.steps[0]?.description_source ?? null,
  ]);

  const grindPrefix = grindSize && grindSize.split(/\s+/).length <= 2
    ? `${capitalizeFirst(grindSize.toLowerCase())} `
    : "";
  const subject = methodLabel ? `${methodLabel} recipe` : "coffee recipe";
  const quantityPart = coffeeAmount && waterAmount
    ? ` using ${coffeeAmount}g coffee and ${waterAmount}g water`
    : waterAmount
    ? ` for ${waterAmount}g water`
    : coffeeAmount
    ? ` using ${coffeeAmount}g coffee`
    : "";
  const contextSuffix = contextItems.length > 0
    ? ` with ${joinNaturalList(contextItems)}`
    : "";

  const summary = `${grindPrefix}${subject}${quantityPart}${contextSuffix}.`
    .replace(/\s+/g, " ")
    .trim();

  return summary.length > 0 ? summary : null;
}

function rebalanceShortDescription(args: {
  normalized: NormalizedDraft;
  brewingMethods: BrewingMethodOption[];
}): string | null {
  const current = args.normalized.localization.short_description?.trim() ??
    null;
  const currentContextItems = extractShortDescriptionContextItems([current]);
  const preparationContextItems = extractShortDescriptionContextItems([
    args.normalized.steps[0]?.description_source ?? null,
  ]);
  if (!current) {
    return synthesizeShortDescription(args);
  }

  const preparationText = args.normalized.steps[0]?.description_source ?? null;
  const shouldRebalance = current.length > 160 ||
    (containsPreparationDetail(current) &&
      containsPreparationDetail(preparationText)) ||
    preparationContextItems.some((item) => !currentContextItems.includes(item));

  if (!shouldRebalance) {
    return current;
  }

  return synthesizeShortDescription(args) ?? current;
}

function parseJsonPayload(content: string): unknown {
  const trimmed = content.trim();
  const withoutFences = trimmed.startsWith("```")
    ? trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()
    : trimmed;

  return JSON.parse(withoutFences);
}

function calculateCleanScore(number: number): number {
  if (Math.abs(number - Math.round(number)) < 0.01) {
    return 100 - Math.abs(number - Math.round(number)) * 100;
  }

  const simpleRatios = [
    0.25,
    0.33,
    0.5,
    0.67,
    0.75,
    1.25,
    1.33,
    1.5,
    1.67,
    1.75,
    2.5,
    3.5,
  ];

  for (const ratio of simpleRatios) {
    if (Math.abs(ratio - number) < 0.01) {
      return 90 - Math.abs(ratio - number) * 100;
    }
  }

  const [, decimalPart = ""] = number.toString().split(".");
  return 80 - decimalPart.length * 10;
}

function getCleanestPlaceholder(args: {
  value: number;
  coffeeAmount: number | null;
  waterAmount: number | null;
}): DraftExpression["placeholder"] | null {
  const coffeeAmount = args.coffeeAmount;
  const waterAmount = args.waterAmount;

  if (coffeeAmount === null && waterAmount === null) {
    return null;
  }

  if (coffeeAmount === null) {
    return "<final_water_amount>";
  }

  if (waterAmount === null) {
    return "<final_coffee_amount>";
  }

  const coffeeScore = calculateCleanScore(args.value / coffeeAmount);
  const waterScore = calculateCleanScore(args.value / waterAmount);

  return coffeeScore > waterScore
    ? "<final_coffee_amount>"
    : "<final_water_amount>";
}

function hasContextKeyword(
  context: string,
  keywords: readonly string[],
): boolean {
  return keywords.some((keyword) => context.includes(keyword));
}

function resolveAmountPlaceholder(args: {
  description: string;
  stepKind: "preparation" | "brew";
  matchStart: number;
  matchEnd: number;
  value: number;
  coffeeAmount: number | null;
  waterAmount: number | null;
}): DraftExpression["placeholder"] | null {
  const contextStart = Math.max(0, args.matchStart - 24);
  const contextEnd = Math.min(args.description.length, args.matchEnd + 24);
  const normalizedContext = normalizeKeywordText(
    args.description.slice(contextStart, contextEnd),
  );

  const hasCoffeeContext = hasContextKeyword(
    normalizedContext,
    COFFEE_CONTEXT_KEYWORDS,
  );
  const hasWaterContext = hasContextKeyword(
    normalizedContext,
    WATER_CONTEXT_KEYWORDS,
  );

  if (hasCoffeeContext && !hasWaterContext) {
    return "<final_coffee_amount>";
  }

  if (hasWaterContext && !hasCoffeeContext) {
    return "<final_water_amount>";
  }

  if (args.stepKind === "brew" && args.waterAmount !== null) {
    return "<final_water_amount>";
  }

  return getCleanestPlaceholder({
    value: args.value,
    coffeeAmount: args.coffeeAmount,
    waterAmount: args.waterAmount,
  });
}

function convertNumericValuesToExpressions(args: {
  description: string;
  stepKind: "preparation" | "brew";
  coffeeAmount: number | null;
  waterAmount: number | null;
}): string {
  if (!args.description.trim().length) {
    return args.description;
  }

  const withRanges = args.description.replace(
    NUMERIC_SCALABLE_RANGE_REGEX,
    (
      fullMatch,
      lowerNumericValue,
      upperNumericValue,
      unit,
      offset,
      fullDescription,
    ) => {
      const lowerValue = Number(lowerNumericValue);
      const upperValue = Number(upperNumericValue);
      if (
        !Number.isFinite(lowerValue) ||
        !Number.isFinite(upperValue) ||
        lowerValue < 0.1 ||
        upperValue < 0.1
      ) {
        return fullMatch;
      }

      if (
        isInsideExpressionLikeMultiplier({
          description: String(fullDescription),
          matchStart: Number(offset),
        })
      ) {
        return fullMatch;
      }

      const tail = String(fullDescription).slice(
        Number(offset) + fullMatch.length,
        Number(offset) + fullMatch.length + 24,
      );
      if (RATE_CONTEXT_REGEX.test(tail)) {
        return fullMatch;
      }

      const lowerPlaceholder = resolveAmountPlaceholder({
        description: String(fullDescription),
        stepKind: args.stepKind,
        matchStart: Number(offset),
        matchEnd: Number(offset) + String(lowerNumericValue).length,
        value: lowerValue,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
      });
      const upperPlaceholder = resolveAmountPlaceholder({
        description: String(fullDescription),
        stepKind: args.stepKind,
        matchStart: Number(offset),
        matchEnd: Number(offset) + fullMatch.length,
        value: upperValue,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
      });

      if (!lowerPlaceholder || lowerPlaceholder !== upperPlaceholder) {
        return fullMatch;
      }

      const baseAmount = lowerPlaceholder === "<final_coffee_amount>"
        ? args.coffeeAmount
        : args.waterAmount;

      if (baseAmount === null || baseAmount <= 0) {
        return fullMatch;
      }

      const normalizedUnit = normalizeExpressionUnit(String(unit));
      return `(${
        formatMultiplier(lowerValue / baseAmount)
      } x ${lowerPlaceholder})-(${
        formatMultiplier(upperValue / baseAmount)
      } x ${upperPlaceholder})${normalizedUnit}`;
    },
  );

  return withRanges.replace(
    NUMERIC_SCALABLE_AMOUNT_REGEX,
    (fullMatch, numericValue, unit, offset, fullDescription) => {
      const value = Number(numericValue);
      if (!Number.isFinite(value) || value < 0.1) {
        return fullMatch;
      }

      if (
        isInsideExpressionLikeMultiplier({
          description: String(fullDescription),
          matchStart: Number(offset),
        })
      ) {
        return fullMatch;
      }

      const tail = String(fullDescription).slice(
        Number(offset) + fullMatch.length,
        Number(offset) + fullMatch.length + 24,
      );
      if (RATE_CONTEXT_REGEX.test(tail)) {
        return fullMatch;
      }

      const placeholder = resolveAmountPlaceholder({
        description: String(fullDescription),
        stepKind: args.stepKind,
        matchStart: Number(offset),
        matchEnd: Number(offset) + fullMatch.length,
        value,
        coffeeAmount: args.coffeeAmount,
        waterAmount: args.waterAmount,
      });

      if (!placeholder) {
        return fullMatch;
      }

      const baseAmount = placeholder === "<final_coffee_amount>"
        ? args.coffeeAmount
        : args.waterAmount;

      if (baseAmount === null || baseAmount <= 0) {
        return fullMatch;
      }

      return `(${formatMultiplier(value / baseAmount)} x ${placeholder})${
        normalizeExpressionUnit(String(unit))
      }`;
    },
  );
}

function isInsideExpressionLikeMultiplier(args: {
  description: string;
  matchStart: number;
}): boolean {
  const prefix = args.description.slice(0, args.matchStart);
  const lastOpenParen = prefix.lastIndexOf("(");
  const lastCloseParen = prefix.lastIndexOf(")");
  if (lastOpenParen <= lastCloseParen) {
    return false;
  }

  const currentParenthetical = prefix.slice(lastOpenParen + 1);
  return /(?:^|\s)[\d.]+\s*(?:x|×)\s*$/i.test(currentParenthetical);
}

function normalizeExpressionLikeMath(args: {
  description: string;
  coffeeAmount: number | null;
  waterAmount: number | null;
}): string {
  if (!args.description.trim().length) {
    return args.description;
  }

  const collapsedNestedExpressions = args.description.replace(
    NESTED_PLACEHOLDER_EXPRESSION_REGEX,
    (
      _fullMatch,
      outerMultiplierValue,
      innerMultiplierValue,
      placeholderValue,
      unitValue,
    ) => {
      const outerMultiplier = Number(outerMultiplierValue);
      const innerMultiplier = Number(innerMultiplierValue);
      if (
        !Number.isFinite(outerMultiplier) || !Number.isFinite(innerMultiplier)
      ) {
        return _fullMatch;
      }

      return `(${formatMultiplier(outerMultiplier * innerMultiplier)} x <${
        String(placeholderValue).toLowerCase()
      }>)${normalizeExpressionUnit(String(unitValue ?? ""))}`;
    },
  );

  return collapsedNestedExpressions.replace(
    MULTIPLIER_LITERAL_AMOUNT_REGEX,
    (
      fullMatch,
      multiplierValue,
      literalAmountValue,
      unitValue,
    ) => {
      const multiplier = Number(multiplierValue);
      const literalAmount = Number(literalAmountValue);
      if (!Number.isFinite(multiplier) || !Number.isFinite(literalAmount)) {
        return fullMatch;
      }

      if (
        args.waterAmount !== null &&
        Math.abs(literalAmount - args.waterAmount) < 0.01
      ) {
        return `(${formatMultiplier(multiplier)} x <final_water_amount>)${
          normalizeExpressionUnit(String(unitValue))
        }`;
      }

      if (
        args.coffeeAmount !== null &&
        Math.abs(literalAmount - args.coffeeAmount) < 0.01
      ) {
        return `(${formatMultiplier(multiplier)} x <final_coffee_amount>)${
          normalizeExpressionUnit(String(unitValue))
        }`;
      }

      return `${formatCompactNumber(multiplier * literalAmount) ?? fullMatch}${
        normalizeExpressionUnit(String(unitValue))
      }`;
    },
  );
}

function createOpenAiCompatibleProvider(args: {
  name: "groq" | "cerebras" | "openai";
  apiKey: string;
  model: string;
  endpoint: string;
  fetchImpl: typeof fetch;
}): RecipeDraftAiProvider {
  return {
    name: args.name,
    model: args.model,
    async invokeJson<T>(
      input: ProviderInvocation<T>,
    ): Promise<{ result: T; tokensUsed: number }> {
      const response = await args.fetchImpl(args.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: args.model,
          messages: [
            {
              role: "system",
              content: input.systemPrompt,
            },
            {
              role: "user",
              content: input.userPrompt,
            },
          ],
          response_format: {
            type: "json_object",
          },
          temperature: 0.1,
          max_completion_tokens: 2500,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `${args.name}:${args.model} HTTP ${response.status} ${
            errorBody.slice(0, 300)
          }`,
        );
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error(`${args.name}:${args.model} returned empty content`);
      }

      const parsed = parseJsonPayload(content);
      return {
        result: input.schema.parse(parsed),
        tokensUsed: data.usage?.total_tokens ?? 0,
      };
    },
  };
}

function createVertexAccessTokenProvider(args: {
  serviceAccountKeyJson: string;
  fetchImpl: typeof fetch;
}) {
  let cachedAccessToken: string | null = null;
  let cachedTokenExpiresAtMs = 0;

  return async function getAccessToken(): Promise<string> {
    const nowMs = Date.now();
    if (
      cachedAccessToken &&
      cachedTokenExpiresAtMs > nowMs + 60_000
    ) {
      return cachedAccessToken;
    }

    const serviceAccount = JSON.parse(args.serviceAccountKeyJson);
    const issuedAt = Math.floor(nowMs / 1000);
    const expiresAt = issuedAt + 3600;
    const encodeBase64Url = (value: string) =>
      btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const header = encodeBase64Url(JSON.stringify({
      alg: "RS256",
      typ: "JWT",
    }));
    const payload = encodeBase64Url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: expiresAt,
    }));
    const unsignedToken = `${header}.${payload}`;

    const privateKeyBinary = Uint8Array.from(
      atob(
        String(serviceAccount.private_key)
          .replace(/-----\w+ PRIVATE KEY-----/g, "")
          .replace(/\s+/g, ""),
      ),
      (char) => char.charCodeAt(0),
    );

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBinary,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(unsignedToken),
    );
    const signedToken = `${unsignedToken}.${
      encodeBase64Url(String.fromCharCode(...new Uint8Array(signature)))
    }`;

    const response = await args.fetchImpl(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signedToken,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `gemini:oauth HTTP ${response.status} ${errorBody.slice(0, 300)}`,
      );
    }

    const tokenResponse = await response.json();
    if (
      typeof tokenResponse.access_token !== "string" ||
      tokenResponse.access_token.length === 0
    ) {
      throw new Error("gemini:oauth returned an empty access token");
    }

    const accessToken = tokenResponse.access_token;
    cachedAccessToken = accessToken;
    cachedTokenExpiresAtMs = nowMs +
      Number(tokenResponse.expires_in ?? 3600) * 1000;
    return accessToken;
  };
}

function createGeminiProvider(args: {
  serviceAccountKeyJson: string;
  projectId: string;
  region: string;
  model: string;
  fetchImpl: typeof fetch;
}): RecipeDraftAiProvider {
  const getAccessToken = createVertexAccessTokenProvider({
    serviceAccountKeyJson: args.serviceAccountKeyJson,
    fetchImpl: args.fetchImpl,
  });
  const isPreviewModel = args.model.includes("preview");
  const location = isPreviewModel ? "global" : args.region;
  const host = isPreviewModel
    ? "aiplatform.googleapis.com"
    : `${args.region}-aiplatform.googleapis.com`;
  const endpoint =
    `https://${host}/v1/projects/${args.projectId}/locations/${location}/publishers/google/models/${args.model}:generateContent`;

  return {
    name: "gemini",
    model: args.model,
    async invokeJson<T>(
      input: ProviderInvocation<T>,
    ): Promise<{ result: T; tokensUsed: number }> {
      const accessToken = await getAccessToken();
      const response = await args.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: input.systemPrompt,
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: input.userPrompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `gemini:${args.model} HTTP ${response.status} ${
            errorBody.slice(0, 300)
          }`,
        );
      }

      const data = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error(`gemini:${args.model} returned empty content`);
      }

      const parsed = parseJsonPayload(content);
      return {
        result: input.schema.parse(parsed),
        tokensUsed: data.usageMetadata?.totalTokenCount ?? 0,
      };
    },
  };
}

function buildProviders(
  config: RecipeDraftParserConfig,
): RecipeDraftAiProvider[] {
  if (config.providers && config.providers.length > 0) {
    return config.providers;
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const providers: RecipeDraftAiProvider[] = [];

  if (config.openAiApiKey) {
    providers.push(
      createOpenAiCompatibleProvider({
        name: "openai",
        apiKey: config.openAiApiKey,
        model: "gpt-5.4-mini",
        endpoint: OPENAI_CHAT_COMPLETIONS_URL,
        fetchImpl,
      }),
    );
  }

  if (config.groqApiKey) {
    providers.push(
      createOpenAiCompatibleProvider({
        name: "groq",
        apiKey: config.groqApiKey,
        model: "groq/compound-mini",
        endpoint: GROQ_CHAT_COMPLETIONS_URL,
        fetchImpl,
      }),
    );

    providers.push(
      createOpenAiCompatibleProvider({
        name: "groq",
        apiKey: config.groqApiKey,
        model: "openai/gpt-oss-20b",
        endpoint: GROQ_CHAT_COMPLETIONS_URL,
        fetchImpl,
      }),
    );
  }

  if (config.cerebrasApiKey) {
    providers.push(
      createOpenAiCompatibleProvider({
        name: "cerebras",
        apiKey: config.cerebrasApiKey,
        model: "qwen-3-235b-a22b-instruct-2507",
        endpoint: CEREBRAS_CHAT_COMPLETIONS_URL,
        fetchImpl,
      }),
    );
  }

  if (
    config.geminiServiceAccountKeyJson &&
    config.geminiProjectId &&
    config.geminiRegion
  ) {
    providers.push(
      createGeminiProvider({
        serviceAccountKeyJson: config.geminiServiceAccountKeyJson,
        projectId: config.geminiProjectId,
        region: config.geminiRegion,
        model: config.geminiModel ?? DEFAULT_GEMINI_MODEL,
        fetchImpl,
      }),
    );
  }

  return providers;
}

function buildBrewingMethodsPrompt(methods: BrewingMethodOption[]): string {
  return methods
    .map((method) => `- ${method.brewing_method_id}: ${method.brewing_method}`)
    .join("\n");
}

function buildExtractionSystemPrompt(): string {
  return [
    "You extract coffee recipes for Timer.Coffee.",
    "Return only valid JSON.",
    "Do not translate or rewrite source text.",
    "Preserve literal amounts, units, and timings from the source recipe.",
    "Normalize all temperatures to Celsius before returning them.",
    "If the source text uses Fahrenheit, convert it to Celsius.",
    "Temperature fields must be bare JSON numbers only, never strings, never include units like C, F, °C, or °F.",
    "Use null for anything not clearly stated or safely inferable.",
    "Separate untimed preparation/setup content from timed brew steps.",
    "Notes are optional and should only contain parser-relevant caveats such as ambiguity, inference, conversion, or repair concerns.",
    "Do not put generic brewing advice or recipe commentary in notes.",
    "All timed brew steps must use integer seconds when explicit or strongly inferable from local context; otherwise use null.",
    "If a step starts with a timestamp like 0:45 or 1:30, that timestamp is elapsed brew time from recipe start; preserve it in raw_text and do not treat it as the step duration unless the interval to the next action is explicit.",
    "Final coffee_amount_grams and water_amount should represent the overall recipe target, not a single pour.",
  ].join(" ");
}

function buildExtractionUserPrompt(input: {
  text: string;
  brewingMethodHint?: string;
  sourceLanguageHint?: string;
}): string {
  return [
    "Extract the recipe into this JSON shape:",
    JSON.stringify(
      {
        detected_input_language: "string|null",
        likely_brewing_method: "string|null",
        name: "string|null",
        short_description: "string|null",
        grind_size: "string|null",
        water_temp_celsius: "number|null",
        coffee_amount_grams: "number|null",
        water_amount: "number|null",
        preparation: "string|null",
        steps: [
          {
            title: "string|null",
            raw_text: "string",
            duration_seconds: "number|null",
          },
        ],
        notes: ["string"],
      },
      null,
      2,
    ),
    input.brewingMethodHint
      ? `Client brewing_method_id hint: ${input.brewingMethodHint}`
      : "Client brewing_method_id hint: none",
    input.sourceLanguageHint
      ? `Source language hint: ${input.sourceLanguageHint}`
      : "Source language hint: none",
    "Return water_temp_celsius as a bare JSON number in Celsius only. Example: 96 or 96.1, not '96C'.",
    "Recipe text:",
    input.text,
  ].join("\n\n");
}

function buildNormalizationSystemPrompt(): string {
  return [
    "You normalize extracted coffee recipes for Timer.Coffee user recipes.",
    "Return only valid JSON.",
    "Storage locale is always 'en', but do not translate source text.",
    "All temperatures must be normalized to Celsius.",
    "If the source text used Fahrenheit, convert it to Celsius before returning JSON.",
    "Temperature fields must be bare JSON numbers only, never strings, never include units like C, F, °C, or °F.",
    "If any step description mentions temperature, normalize that mention to Celsius too.",
    "short_description must be one concise recipe-level sentence, not a mini step list.",
    "Keep setup details, hardware modifications, filter prep, rinsing, and accessory instructions in the preparation step, not short_description.",
    "description_template must be concise timer-ready brewing instructions, not transcript prose.",
    "Use imperative wording. Remove commentary, marketing copy, explanations, and teaching asides such as why blooming happens or why filter orientation matters.",
    "Preparation should be at most two compact sentences. Each brew step should normally be one compact sentence under 140 characters unless essential details would be lost.",
    "The first step must be kind 'preparation' with duration_seconds 0.",
    `All later steps must be kind 'brew' with integer duration_seconds at least ${MIN_BREW_STEP_DURATION_SECONDS}.`,
    "duration_seconds is the interval until the next action or completion of that step, not an elapsed timestamp label such as 0:45 or 1:30.",
    "For multi-pour brew steps, prefer cumulative water totals after the first pour, e.g. 'pour up to 200g' rather than 'pour another 100g'.",
    "Use only these scalable quantity placeholders when helpful:",
    "(1 x <final_coffee_amount>)g",
    "(0.2 x <final_water_amount>)g",
    "(0.2 x <final_water_amount>)ml",
    "The multiplier must always be numeric, never a symbol or variable like N.",
    "Never nest scalable expressions; use either a plain numeric amount or one complete expression like (1 x <final_coffee_amount>)g.",
    "If a quantity scales with recipe coffee or water, do not leave it as a fixed literal number in description_template.",
    "Never emit <t1>..<t8> or any other time placeholder.",
    "Do not invent missing values; use null.",
    "brewing_method_id must be exactly one of the allowed ids or null, never a display label.",
    "Preserve concrete amounts and units in meaning even when converting to expressions.",
  ].join(" ");
}

function buildNormalizationUserPrompt(input: {
  extraction: ExtractionResult;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): string {
  return [
    "Normalize the extracted recipe into this JSON shape:",
    JSON.stringify(
      {
        detected_input_language: "string|null",
        warnings: ["string"],
        recipe: {
          brewing_method_id: "string|null",
          brewing_method_confidence: "high|medium|low|none",
          coffee_amount: "number|null",
          water_amount: "number|null",
          water_temp: "number|null",
        },
        localization: {
          name: "string|null",
          grind_size: "string|null",
          short_description: "string|null",
        },
        steps: [
          {
            kind: "preparation|brew",
            description_source: "string",
            description_template: "string",
            duration_seconds: "number",
          },
        ],
      },
      null,
      2,
    ),
    input.brewingMethodHint
      ? `Client brewing_method_id hint (hard constraint): ${input.brewingMethodHint}`
      : "Client brewing_method_id hint (hard constraint): none",
    "Return recipe.water_temp as a bare JSON number in Celsius only. Example: 96 or 96.1, not '96C'.",
    "Allowed brewing methods:",
    buildBrewingMethodsPrompt(input.brewingMethods),
    "Extracted recipe JSON:",
    JSON.stringify(input.extraction, null, 2),
  ].join("\n\n");
}

function buildRepairSystemPrompt(): string {
  return [
    "You repair incomplete normalized coffee recipes for Timer.Coffee user recipes.",
    "Return only valid JSON.",
    "You must return the same normalized JSON shape as the normalization stage.",
    "Re-read the original source text carefully and fill required fields that were missed.",
    "Keep already-correct values stable unless they clearly contradict the source text.",
    "Storage locale is always 'en', but do not translate source text.",
    "All temperatures must be normalized to Celsius.",
    "If the source text used Fahrenheit, convert it to Celsius before returning JSON.",
    "Temperature fields must be bare JSON numbers only, never strings, never include units like C, F, °C, or °F.",
    "If any step description mentions temperature, normalize that mention to Celsius too.",
    "If recipe.water_temp is not mentioned in the source text, infer a sensible default from the brewing method: use 93 for most filter methods (pour-over, drip, Aeropress, Chemex, Moka), 96 for espresso, 100 for French press or immersion, 93 as a safe fallback for any other method.",
    "If localization.grind_size is not mentioned in the source text, infer from the brewing method: 'fine' for espresso or Moka, 'medium-fine' for pour-over or V60, 'medium' for drip or Aeropress, 'coarse' for French press or cold brew, 'medium' as a safe fallback for any other method.",
    "Never return null for recipe.water_temp or localization.grind_size — always provide an inferred value if the source text is silent.",
    "short_description must be one concise recipe-level sentence, not a mini step list.",
    "Keep setup details, hardware modifications, filter prep, rinsing, and accessory instructions in the preparation step, not short_description.",
    "description_template must be concise timer-ready brewing instructions, not transcript prose.",
    "Use imperative wording. Remove commentary, marketing copy, explanations, and teaching asides such as why blooming happens or why filter orientation matters.",
    "Preparation should be at most two compact sentences. Each brew step should normally be one compact sentence under 140 characters unless essential details would be lost.",
    "The first step must be kind 'preparation' with duration_seconds 0.",
    `All later steps must be kind 'brew' with integer duration_seconds at least ${MIN_BREW_STEP_DURATION_SECONDS}.`,
    "duration_seconds is the interval until the next action or completion of that step, not an elapsed timestamp label such as 0:45 or 1:30.",
    "For multi-pour brew steps, prefer cumulative water totals after the first pour, e.g. 'pour up to 200g' rather than 'pour another 100g'.",
    "Use only these scalable quantity placeholders when helpful:",
    "(1 x <final_coffee_amount>)g",
    "(0.2 x <final_water_amount>)g",
    "(0.2 x <final_water_amount>)ml",
    "The multiplier must always be numeric, never a symbol or variable like N.",
    "Never nest scalable expressions; use either a plain numeric amount or one complete expression like (1 x <final_coffee_amount>)g.",
    "Never emit <t1>..<t8> or any other time placeholder.",
    "brewing_method_id must be exactly one of the allowed ids or null, never a display label.",
  ].join(" ");
}

function buildRepairUserPrompt(input: {
  text: string;
  extraction: ExtractionResult;
  normalized: NormalizedDraft;
  missingFields: string[];
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): string {
  return [
    "Repair the normalized recipe. Return the full normalized JSON shape, not a patch.",
    `Missing or unresolved required fields: ${input.missingFields.join(", ")}`,
    input.brewingMethodHint
      ? `Client brewing_method_id hint (hard constraint): ${input.brewingMethodHint}`
      : "Client brewing_method_id hint (hard constraint): none",
    "Return recipe.water_temp as a bare JSON number in Celsius only. Example: 96 or 96.1, not '96C'.",
    "Allowed brewing methods:",
    buildBrewingMethodsPrompt(input.brewingMethods),
    "Original source text:",
    input.text,
    "Extraction JSON:",
    JSON.stringify(input.extraction, null, 2),
    "Current incomplete normalized JSON:",
    JSON.stringify(input.normalized, null, 2),
  ].join("\n\n");
}

function buildCumulativeRewriteSystemPrompt(): string {
  return [
    "You rewrite coffee recipe brew-step wording for Timer.Coffee.",
    "Return only valid JSON.",
    "Preserve the original language of the step descriptions. Do not translate.",
    "Keep step count, step order, kind, duration_seconds, and description_source unchanged.",
    "Only rewrite brew-step description_template fields when needed.",
    "For multi-pour brew recipes, the first water-addition step may stay as the amount added in that step.",
    "For later water-addition brew steps, prefer cumulative total water after the pour, such as 'pour up to 200g' rather than 'pour another 100g'.",
    "Treat wording such as 'pour to 200g', 'pour until 200g', 'reach 200g', or '200g total' as already cumulative; do not add it to earlier pours.",
    "If a step already uses cumulative total wording correctly, leave it unchanged.",
    "Preserve all valid scalable quantity placeholders and keep numeric multipliers valid.",
    "Never emit <t1>..<t8> or any other time placeholder.",
  ].join(" ");
}

function buildCumulativeRewriteUserPrompt(input: {
  detectedInputLanguage: string | null;
  normalized: NormalizedDraft;
  draftSteps: DraftStep[];
}): string {
  return [
    "Rewrite later brew steps to cumulative total water wording only when needed.",
    input.detectedInputLanguage
      ? `Detected recipe language: ${input.detectedInputLanguage}`
      : "Detected recipe language: unknown",
    "Return this JSON shape:",
    JSON.stringify(
      {
        warnings: ["string"],
        steps: [
          {
            kind: "preparation|brew",
            description_source: "string",
            description_template: "string",
            duration_seconds: "number",
          },
        ],
      },
      null,
      2,
    ),
    "Current normalized steps:",
    JSON.stringify(input.normalized.steps, null, 2),
    "Current rendered draft steps for reference:",
    JSON.stringify(input.draftSteps, null, 2),
  ].join("\n\n");
}

function renderPreviewText(
  template: string,
  coffeeAmount: number | null,
  waterAmount: number | null,
): string {
  return template.replaceAll(
    cloneRegex(EXPRESSION_REGEX),
    (
      fullMatch,
      multiplierValue: string,
      placeholderValue: string,
      unitValue: string,
    ) => {
      const multiplier = Number(multiplierValue);
      if (!Number.isFinite(multiplier)) {
        return fullMatch;
      }

      const normalizedPlaceholder = String(placeholderValue).toLowerCase();
      const baseAmount = normalizedPlaceholder === "final_coffee_amount"
        ? coffeeAmount
        : waterAmount;
      if (baseAmount === null || !Number.isFinite(baseAmount)) {
        return fullMatch;
      }

      const computed = multiplier * baseAmount;
      const formatted = Number.isInteger(computed)
        ? String(computed)
        : computed.toFixed(1).replace(/\.0$/, "");
      const unit = unitValue ?? "";
      const separator = unit.length > 1 ? " " : "";
      return `${formatted}${separator}${unit}`;
    },
  );
}

function usesCumulativeWaterLanguage(template: string): boolean {
  const normalized = normalizeKeywordText(template);
  return /\b(?:up to|total|pour to|pour until|pour till|reach|reaching)\b/i
    .test(normalized);
}

function normalizeLeadingTimestampLabel(template: string): string {
  return template
    .replace(/^\s*(?:at\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*,?\s*/i, "")
    .replace(/^([a-z])/, (match) => match.toUpperCase());
}

function normalizeTemplateTextPolish(template: string): string {
  return template
    .replace(
      /\bheat\s+(?:about\s+)?(?:a\s+)?(?:full\s+)?kettle\s+of\s+water\s+to\s+between\s+(\d+(?:\.\d+)?)\s+(?:and|to|-)\s+\1C\b/gi,
      (_match, numericValue) => `heat water to ${numericValue}C`,
    )
    .replace(
      /\b(heat\s+water\s+to\s+)(\d+(?:\.\d+)?)(?!\.\d)(?=\s*[,.;:]|\s|$)(?!\s*[°º]?\s*c\b)/gi,
      (_match, prefix, numericValue) => `${prefix}${numericValue}C`,
    )
    .replace(
      /^(\s*)([a-z])/,
      (_match, prefix, firstLetter) =>
        `${prefix}${String(firstLetter).toUpperCase()}`,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function simplifyVerboseChemexPreparation(template: string): string {
  const normalized = normalizeKeywordText(template);
  if (
    !normalized.includes("6 cup chemex") ||
    !normalized.includes("trifold") ||
    !normalized.includes("level coffee bed")
  ) {
    return template;
  }

  const coffeeExpression = template.match(
    cloneRegex(EXPRESSION_REGEX),
  )?.[0] ?? "coffee";
  const tempMatch = template.match(/\bheat water to (\d+(?:\.\d+)?)C\b/i);
  const heatClause = tempMatch
    ? `heat water to ${tempMatch[1]}C`
    : "heat water";

  return `Prepare a 6 cup Chemex with a Chemex filter, ${heatClause}, place and rinse the filter with the trifold facing the spout, grind ${coffeeExpression} coffee medium coarse, level the bed, and tare the scale.`;
}

function simplifyVerboseBrewTemplate(template: string): string {
  const waterExpression = template.match(cloneRegex(EXPRESSION_REGEX))?.[0] ??
    null;
  if (!waterExpression) {
    return template;
  }

  const normalized = normalizeKeywordText(template);
  if (
    normalized.includes("first pour") &&
    normalized.includes("coffee is completely saturated")
  ) {
    return `Start the timer and pour up to ${waterExpression}, spiraling from the center out and back.`;
  }

  if (
    normalized.includes("second pour") &&
    normalized.includes("avoid") &&
    normalized.includes("filter")
  ) {
    return `Pour up to ${waterExpression} using the same spiral pattern, avoiding the filter, and let it drain almost completely.`;
  }

  if (
    normalized.includes("third pour") &&
    normalized.includes("same pouring pattern")
  ) {
    return `Pour up to ${waterExpression} using the same pouring pattern, then pause and let it drain.`;
  }

  if (
    normalized.includes("fourth and final pour") ||
    normalized.includes("final pour")
  ) {
    return `Pour up to ${waterExpression} with a consistent pour pattern.`;
  }

  return template;
}

function simplifyVerboseStepTemplate(args: {
  template: string;
  kind: "preparation" | "brew";
}): string {
  return args.kind === "preparation"
    ? simplifyVerboseChemexPreparation(args.template)
    : simplifyVerboseBrewTemplate(args.template);
}

function normalizeCumulativeWaterWording(template: string): string {
  return template
    .replace(/\bpour\s+to\s+/gi, "pour up to ")
    .replace(/\bpour\s+until\s+/gi, "pour up to ")
    .replace(/\bpour\s+till\s+/gi, "pour up to ")
    .replace(/\breach(?:ing)?\s+/gi, "reach ");
}

function normalizeExpressionUnit(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (normalized === "gram" || normalized === "grams") {
    return "g";
  }
  if (
    normalized === "milliliter" ||
    normalized === "milliliters" ||
    normalized === "millilitre" ||
    normalized === "millilitres"
  ) {
    return "ml";
  }
  return unit;
}

function replaceFirstWaterExpression(
  template: string,
  replacement: string,
): string {
  let replaced = false;

  return template.replace(
    cloneRegex(EXPRESSION_REGEX),
    (fullMatch, multiplierValue: string, placeholderValue: string) => {
      if (replaced) {
        return fullMatch;
      }

      const multiplier = Number(multiplierValue);
      if (!Number.isFinite(multiplier)) {
        return fullMatch;
      }

      if (String(placeholderValue).toLowerCase() !== "final_water_amount") {
        return fullMatch;
      }

      replaced = true;
      return replacement;
    },
  );
}

function rewriteWaterPhraseToCumulative(
  template: string,
  expression: string,
): string {
  const escapedExpression = escapeRegExp(expression);
  const phrasePatterns = [
    new RegExp(
      `\\b(?:pour|add)\\s+(?:another\\s+|the\\s+final\\s+|final\\s+)?${escapedExpression}(\\s+of\\s+water)?`,
      "i",
    ),
    new RegExp(
      `\\b(?:pour|add)\\s+${escapedExpression}(\\s+of\\s+water)?`,
      "i",
    ),
  ];

  for (const pattern of phrasePatterns) {
    if (pattern.test(template)) {
      return template.replace(
        pattern,
        (_, waterSuffix = "") => `pour up to ${expression}${waterSuffix}`,
      );
    }
  }

  return template;
}

function extractExpressions(
  template: string,
  coffeeAmount: number | null,
  waterAmount: number | null,
): DraftExpression[] {
  const expressions: DraftExpression[] = [];
  for (const match of template.matchAll(EXPRESSION_REGEX)) {
    const multiplier = Number(match[1]);
    const placeholder = `<${match[2]}>` as
      | "<final_coffee_amount>"
      | "<final_water_amount>";
    const unit = (match[3] ?? "").trim();
    const baseAmount = placeholder === "<final_coffee_amount>"
      ? coffeeAmount
      : waterAmount;
    const previewValue = baseAmount === null ? null : Number(
      (multiplier * baseAmount).toFixed(2),
    );

    expressions.push({
      placeholder,
      multiplier: Number(formatMultiplier(multiplier)),
      unit,
      preview_value: previewValue,
    });
  }

  return expressions;
}

function collectUnsupportedPlaceholders(template: string): string[] {
  const placeholders: string[] = [];
  for (const match of template.matchAll(UNSUPPORTED_PLACEHOLDER_REGEX)) {
    const placeholder = match[1];
    if (
      placeholder !== "final_coffee_amount" &&
      placeholder !== "final_water_amount"
    ) {
      placeholders.push(`<${placeholder}>`);
    }
  }
  return placeholders;
}

function collectMalformedSupportedPlaceholders(template: string): string[] {
  const strippedValidExpressions = template.replaceAll(
    cloneRegex(EXPRESSION_REGEX),
    "",
  );
  const placeholders: string[] = [];

  for (
    const match of strippedValidExpressions.matchAll(
      SUPPORTED_PLACEHOLDER_REGEX,
    )
  ) {
    placeholders.push(`<${String(match[1]).toLowerCase()}>`);
  }

  return uniqueStrings(placeholders);
}

function hasBalancedParentheses(template: string): boolean {
  let depth = 0;
  for (const char of template) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0;
}

function hasDanglingExpressionMultiplier(template: string): boolean {
  const strippedValidExpressions = template.replaceAll(
    cloneRegex(EXPRESSION_REGEX),
    "",
  );
  return /(?:^|[(\s])[\d.]+\s*(?:x|×)\s*(?=$|[),.;:]|\s)/i.test(
    strippedValidExpressions,
  );
}

function hasInvalidExpressionSyntax(template: string): boolean {
  return collectUnsupportedPlaceholders(template).length > 0 ||
    collectMalformedSupportedPlaceholders(template).length > 0 ||
    !hasBalancedParentheses(template) ||
    hasDanglingExpressionMultiplier(template);
}

function normalizeStepDescriptionTemplate(args: {
  step: NormalizedDraft["steps"][number];
  coffeeAmount: number | null;
  waterAmount: number | null;
}): string {
  const normalizeCandidate = (candidate: string) => {
    const normalizedExpressionMathTemplate = normalizeExpressionLikeMath({
      description: candidate,
      coffeeAmount: args.coffeeAmount,
      waterAmount: args.waterAmount,
    });
    const normalizedTemperatureTemplate = normalizeTemperatureMentionsInText(
      normalizedExpressionMathTemplate,
    ).text;
    const normalizedTemplate = convertNumericValuesToExpressions({
      description: normalizedTemperatureTemplate,
      stepKind: args.step.kind,
      coffeeAmount: args.coffeeAmount,
      waterAmount: args.waterAmount,
    });

    return normalizeTemplateTextPolish(
      simplifyVerboseStepTemplate({
        template: normalizeCumulativeWaterWording(
          normalizeLeadingTimestampLabel(normalizedTemplate),
        ),
        kind: args.step.kind,
      }),
    );
  };

  const normalizedTemplate = normalizeCandidate(args.step.description_template);
  if (!hasInvalidExpressionSyntax(normalizedTemplate)) {
    return normalizedTemplate;
  }

  const sourceTemplate = normalizeCandidate(args.step.description_source);
  return hasInvalidExpressionSyntax(sourceTemplate)
    ? normalizedTemplate
    : sourceTemplate;
}

function buildDraftSteps(input: {
  steps: NormalizedDraft["steps"];
  coffeeAmount: number | null;
  waterAmount: number | null;
}): DraftStep[] {
  return input.steps.map((step, index) => {
    const normalizedTemplate = normalizeStepDescriptionTemplate({
      step,
      coffeeAmount: input.coffeeAmount,
      waterAmount: input.waterAmount,
    });

    return {
      step_order: index + 1,
      kind: step.kind,
      description_source: step.description_source,
      description_template: normalizedTemplate,
      preview_text: renderPreviewText(
        normalizedTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
      duration_seconds: step.duration_seconds,
      expressions: extractExpressions(
        normalizedTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
    };
  });
}

function convertWaterStepsToRunningTotals(input: {
  steps: DraftStep[];
  coffeeAmount: number | null;
  waterAmount: number | null;
}): DraftStep[] {
  if (input.waterAmount === null || input.waterAmount <= 0) {
    return input.steps;
  }

  const finalWaterAmount = input.waterAmount;
  let runningWaterAmount = 0;

  return input.steps.map((step) => {
    if (step.kind !== "brew") {
      return step;
    }

    const waterExpression = step.expressions.find((expression) =>
      expression.placeholder === "<final_water_amount>" &&
      expression.preview_value !== null
    );

    if (!waterExpression || waterExpression.preview_value === null) {
      return step;
    }

    const stepWaterAmount = waterExpression.preview_value;

    if (usesCumulativeWaterLanguage(step.description_template)) {
      runningWaterAmount = Math.max(runningWaterAmount, stepWaterAmount);
      return step;
    }

    const nextRunningTotal = runningWaterAmount + stepWaterAmount;
    if (runningWaterAmount <= 0 || nextRunningTotal > finalWaterAmount + 0.5) {
      runningWaterAmount = nextRunningTotal;
      return step;
    }

    const cumulativeExpression = `(${
      formatMultiplier(nextRunningTotal / finalWaterAmount)
    } x <final_water_amount>)${waterExpression.unit}`;
    const rewrittenTemplate = rewriteWaterPhraseToCumulative(
      replaceFirstWaterExpression(
        step.description_template,
        cumulativeExpression,
      ),
      cumulativeExpression,
    );

    runningWaterAmount = nextRunningTotal;

    return {
      ...step,
      description_template: rewrittenTemplate,
      preview_text: renderPreviewText(
        rewrittenTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
      expressions: extractExpressions(
        rewrittenTemplate,
        input.coffeeAmount,
        input.waterAmount,
      ),
    };
  });
}

function enforceMinimumStepDurations(input: {
  steps: DraftStep[];
}): { steps: DraftStep[]; warnings: string[] } {
  let adjustedPreparation = false;
  let adjustedBrew = false;

  const steps = input.steps.map((step) => {
    if (step.kind === "preparation") {
      if (step.duration_seconds === 0) {
        return step;
      }

      adjustedPreparation = true;
      return {
        ...step,
        duration_seconds: 0,
      };
    }

    if (step.duration_seconds >= MIN_BREW_STEP_DURATION_SECONDS) {
      return step;
    }

    adjustedBrew = true;
    return {
      ...step,
      duration_seconds: MIN_BREW_STEP_DURATION_SECONDS,
    };
  });

  const warnings: string[] = [];
  if (adjustedPreparation) {
    warnings.push("Preparation step duration was normalized to 0 seconds.");
  }
  if (adjustedBrew) {
    warnings.push(
      `Brew step durations below ${MIN_BREW_STEP_DURATION_SECONDS} seconds were normalized to ${MIN_BREW_STEP_DURATION_SECONDS} seconds.`,
    );
  }

  return {
    steps,
    warnings,
  };
}

function parseLeadingTimestampSeconds(text: string): number | null {
  const match = text.match(
    /^\s*(?:at\s*)?(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/i,
  );
  if (!match) {
    return null;
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] === undefined ? null : Number(match[3]);
  if (
    !Number.isFinite(first) || !Number.isFinite(second) ||
    (third !== null && !Number.isFinite(third))
  ) {
    return null;
  }

  return third === null
    ? first * 60 + second
    : first * 3600 + second * 60 + third;
}

const NUMBER_WORD_VALUES = new Map<string, number>([
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);

function parseSmallNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeKeywordText(value).replace(/[^a-z0-9.]+/g, "");
  if (!normalized.length) {
    return null;
  }

  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  return NUMBER_WORD_VALUES.get(normalized) ?? null;
}

function parseNaturalElapsedSeconds(text: string): number | null {
  const normalized = normalizeKeywordText(text);

  const minuteSecondMatch = normalized.match(
    /\b(?:at|after|in|around|about)\s+(?:(\d+(?:\.\d+)?)|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+minutes?\s+(?:and\s+)?(?:(\d+(?:\.\d+)?)|one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?\b/i,
  );
  if (minuteSecondMatch) {
    const minuteText = minuteSecondMatch[1] ??
      minuteSecondMatch[0].match(
        /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+minutes?\b/i,
      )?.[1];
    const secondText = minuteSecondMatch[2] ??
      minuteSecondMatch[0].match(
        /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?\b/i,
      )?.[1];
    const minutes = parseSmallNumber(minuteText);
    const seconds = parseSmallNumber(secondText);
    if (minutes !== null && seconds !== null) {
      return Math.round(minutes * 60 + seconds);
    }
  }

  const minuteMatch = normalized.match(
    /\b(?:at|after|in|around|about)\s+(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+minutes?\b/i,
  );
  if (minuteMatch) {
    const minutes = parseSmallNumber(minuteMatch[1]);
    if (minutes !== null) {
      return Math.round(minutes * 60);
    }
  }

  const secondMatch = normalized.match(
    /\b(?:at|after|in|around|about)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+seconds?\b/i,
  );
  if (secondMatch) {
    const seconds = parseSmallNumber(secondMatch[1]);
    if (seconds !== null) {
      return Math.round(seconds);
    }
  }

  return null;
}

const SMALL_NUMBER_SOURCE = String
  .raw`\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten`;

function parseDurationQuantitySeconds(
  amountText: string | undefined,
  unitText: string | undefined,
): number | null {
  const amount = parseSmallNumber(amountText);
  if (amount === null || !unitText) {
    return null;
  }

  return /^min/i.test(unitText) ? Math.round(amount * 60) : Math.round(amount);
}

function parseClockDurationSeconds(text: string): number | null {
  const match = text.match(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/);
  if (!match) {
    return null;
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] === undefined ? null : Number(match[3]);
  if (
    !Number.isFinite(first) || !Number.isFinite(second) ||
    (third !== null && !Number.isFinite(third))
  ) {
    return null;
  }

  return third === null
    ? first * 60 + second
    : first * 3600 + second * 60 + third;
}

function parseTotalBrewTimeTargetSeconds(text: string): number | null {
  const candidates: number[] = [];
  const sentences = normalizeKeywordText(text).split(/(?<=[.!?])\s+/);
  const rangePattern = new RegExp(
    String
      .raw`\b(${SMALL_NUMBER_SOURCE})\s*(?:-|–|—|\bto\b)\s*(${SMALL_NUMBER_SOURCE})\s+(minutes?|seconds?)\b`,
    "gi",
  );
  const singlePattern = new RegExp(
    String
      .raw`\b(?:brew(?:ing)?\s+times?|total\s+brew\s+time|finish(?:es|ed)?\s+brewing|done|complete)\b.{0,80}?\b(${SMALL_NUMBER_SOURCE})\s+(minutes?|seconds?)\b`,
    "gi",
  );

  for (const sentence of sentences) {
    if (
      !/\b(?:brew(?:ing)?\s+times?|total\s+brew\s+time|finish(?:es|ed)?\s+brewing|done|complete|draw\s*down|drawdown)\b/i
        .test(sentence)
    ) {
      continue;
    }

    for (
      const match of sentence.matchAll(/\b\d{1,2}:[0-5]\d(?::[0-5]\d)?\b/g)
    ) {
      const seconds = parseClockDurationSeconds(match[0]);
      if (seconds !== null && seconds > 0) {
        candidates.push(seconds);
      }
    }

    for (const match of sentence.matchAll(rangePattern)) {
      const seconds = parseDurationQuantitySeconds(match[1], match[3]);
      if (seconds !== null && seconds > 0) {
        candidates.push(seconds);
      }
    }

    for (const match of sentence.matchAll(singlePattern)) {
      const seconds = parseDurationQuantitySeconds(match[1], match[2]);
      if (seconds !== null && seconds > 0) {
        candidates.push(seconds);
      }
    }
  }

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function parseStepElapsedTimestampSeconds(text: string): number | null {
  return parseLeadingTimestampSeconds(text) ?? parseNaturalElapsedSeconds(text);
}

function startsTimerLikeStep(step: DraftStep): boolean {
  const normalized = normalizeKeywordText(
    `${step.description_source} ${step.description_template}`,
  );
  return /\bstart(?:ing)?\s+(?:your\s+)?timer\b/i.test(normalized) ||
    /\bbegin\s+(?:your\s+)?first\s+pour\b/i.test(normalized);
}

function isDrawdownLikeStep(step: DraftStep): boolean {
  const normalized = normalizeKeywordText(
    `${step.description_source} ${step.description_template}`,
  );
  return /\b(?:draw\s*down|drawdown|drain|serve)\b/i.test(normalized);
}

function isVaguePourLikeStep(step: DraftStep): boolean {
  const normalized = normalizeKeywordText(
    `${step.description_source} ${step.description_template}`,
  );
  return /\b(?:similar\s+pouring\s+technique|pouring\s+technique|pouring\s+in\s+phases|continue\s+pouring|main\s+pour|final\s+pour|pour\s+up\s+to|reach\s+.+\btotal\s+water|until\s+you\s+reach)\b/i
    .test(normalized);
}

function hasSourceDrawdownCue(text: string): boolean {
  return /\b(?:draw\s*down|drawdown|dripping|drip\s+through|finish(?:es|ed)?\s+brewing|complete)\b/i
    .test(normalizeKeywordText(text));
}

function inferVaguePourDurationSeconds(input: {
  brewingMethodId: string | null;
  sourceText: string;
  waterAmount: number | null;
}): number {
  const normalizedSource = normalizeKeywordText(input.sourceText);
  const isChemex = input.brewingMethodId === "chemex" ||
    /\b(?:chemex|chemx|chemicx|chimics|kamex)\b/i.test(normalizedSource);
  if (isChemex && (input.waterAmount ?? 0) >= 450) {
    return LARGE_CHEMEX_VAGUE_POUR_DURATION_SECONDS;
  }

  return DEFAULT_VAGUE_POUR_DURATION_SECONDS;
}

function parseCompletionTargetSeconds(text: string): number | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const candidates = sentences
    .filter((sentence) =>
      /\b(?:finish(?:es|ed)?|done|complete|dripping|draw\s*down|drawdown)\b/i
        .test(normalizeKeywordText(sentence))
    )
    .map(parseNaturalElapsedSeconds)
    .filter((value): value is number => value !== null && value > 0);

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function normalizeVagueBrewDurationsFromTotalTarget(input: {
  steps: DraftStep[];
  sourceText: string;
  brewingMethodId: string | null;
  waterAmount: number | null;
}): { steps: DraftStep[]; warnings: string[] } {
  const completionTarget = parseCompletionTargetSeconds(input.sourceText);
  const totalBrewTarget = parseTotalBrewTimeTargetSeconds(input.sourceText);
  const targetSeconds = Math.max(completionTarget ?? 0, totalBrewTarget ?? 0);
  if (targetSeconds <= 0) {
    return { steps: input.steps, warnings: [] };
  }

  const currentBrewTotal = input.steps
    .filter((step) => step.kind === "brew")
    .reduce((sum, step) => sum + step.duration_seconds, 0);
  if (currentBrewTotal >= targetSeconds - MIN_BREW_STEP_DURATION_SECONDS) {
    return { steps: input.steps, warnings: [] };
  }

  const inferredPourDuration = inferVaguePourDurationSeconds({
    brewingMethodId: input.brewingMethodId,
    sourceText: input.sourceText,
    waterAmount: input.waterAmount,
  });
  const vaguePourIndexes = input.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) =>
      step.kind === "brew" &&
      !isDrawdownLikeStep(step) &&
      isVaguePourLikeStep(step) &&
      step.duration_seconds < inferredPourDuration
    )
    .map(({ index }) => index);
  const drawdownIndexes = input.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) =>
      step.kind === "brew" &&
      isDrawdownLikeStep(step) &&
      step.duration_seconds <= DRAWDOWN_STEP_DURATION_SECONDS
    )
    .map(({ index }) => index);

  if (vaguePourIndexes.length === 0 && drawdownIndexes.length === 0) {
    return { steps: input.steps, warnings: [] };
  }

  const adjustedSteps = input.steps.map((step) => ({ ...step }));
  const reservedDrawdownDuration = drawdownIndexes.length *
    MIN_BREW_STEP_DURATION_SECONDS;
  let assignedBrewTotal = adjustedSteps
    .filter((step, index) =>
      step.kind === "brew" &&
      !vaguePourIndexes.includes(index) &&
      !drawdownIndexes.includes(index)
    )
    .reduce((sum, step) => sum + step.duration_seconds, 0);
  let adjusted = false;

  for (const index of vaguePourIndexes) {
    const step = adjustedSteps[index];
    const remainingForPours = targetSeconds - assignedBrewTotal -
      reservedDrawdownDuration;
    if (remainingForPours < MIN_BREW_STEP_DURATION_SECONDS) {
      assignedBrewTotal += step.duration_seconds;
      continue;
    }

    const duration = Math.max(
      MIN_BREW_STEP_DURATION_SECONDS,
      Math.min(inferredPourDuration, remainingForPours),
    );
    if (step.duration_seconds !== duration) {
      adjusted = true;
      step.duration_seconds = duration;
    }
    assignedBrewTotal += duration;
  }

  if (drawdownIndexes.length > 0) {
    const drawdownTotal = targetSeconds - assignedBrewTotal;
    if (drawdownTotal >= MIN_BREW_STEP_DURATION_SECONDS) {
      drawdownIndexes.forEach((index, order) => {
        const remainingSlots = drawdownIndexes.length - order;
        const alreadyAssignedDrawdown = drawdownIndexes
          .slice(0, order)
          .reduce(
            (sum, previousIndex) =>
              sum + adjustedSteps[previousIndex].duration_seconds,
            0,
          );
        const remainingDrawdown = drawdownTotal - alreadyAssignedDrawdown;
        const duration = order === drawdownIndexes.length - 1
          ? remainingDrawdown
          : Math.max(
            MIN_BREW_STEP_DURATION_SECONDS,
            Math.floor(remainingDrawdown / remainingSlots),
          );
        if (adjustedSteps[index].duration_seconds !== duration) {
          adjusted = true;
          adjustedSteps[index].duration_seconds = duration;
        }
      });
    }
  } else {
    const drawdownDuration = targetSeconds - assignedBrewTotal;
    if (
      drawdownDuration >= MIN_BREW_STEP_DURATION_SECONDS &&
      hasSourceDrawdownCue(input.sourceText)
    ) {
      adjusted = true;
      adjustedSteps.push({
        step_order: adjustedSteps.length + 1,
        kind: "brew",
        description_source: "manual",
        description_template: "Wait for the complete drawdown.",
        preview_text: "Wait for the complete drawdown.",
        duration_seconds: drawdownDuration,
        expressions: [],
      });
    }
  }

  return {
    steps: adjusted ? adjustedSteps : input.steps,
    warnings: adjusted
      ? [
        "Vague brew step durations were inferred from the stated total brew time.",
      ]
      : [],
  };
}

function normalizeAbsoluteTimestampDurations(input: {
  steps: DraftStep[];
  sourceText: string;
}): { steps: DraftStep[]; warnings: string[] } {
  const detectedTimestamped = input.steps
    .map((step, index) => ({
      index,
      timestampSeconds: step.kind === "brew"
        ? parseStepElapsedTimestampSeconds(step.description_source) ??
          parseStepElapsedTimestampSeconds(step.description_template)
        : null,
    }))
    .filter((item): item is { index: number; timestampSeconds: number } =>
      item.timestampSeconds !== null
    );
  const firstBrewIndex = input.steps.findIndex((step) => step.kind === "brew");
  const timestamped = detectedTimestamped.length > 0 &&
      firstBrewIndex >= 0 &&
      firstBrewIndex < detectedTimestamped[0].index &&
      startsTimerLikeStep(input.steps[firstBrewIndex])
    ? [
      { index: firstBrewIndex, timestampSeconds: 0 },
      ...detectedTimestamped,
    ]
    : detectedTimestamped;

  if (timestamped.length < 2) {
    return {
      steps: input.steps,
      warnings: [],
    };
  }

  const isMonotonic = timestamped.every((item, index) =>
    index === 0 ||
    item.timestampSeconds >= timestamped[index - 1].timestampSeconds
  );
  if (!isMonotonic) {
    return {
      steps: input.steps,
      warnings: [],
    };
  }

  const lastTimestamped = timestamped.at(-1)!;
  let adjusted = false;
  const timestampByIndex = new Map(
    timestamped.map((item, index) => [item.index, { ...item, order: index }]),
  );
  const completionTargetSeconds = parseCompletionTargetSeconds(
    input.sourceText,
  );

  const steps = input.steps.map((step, index) => {
    const timestamp = timestampByIndex.get(index);
    if (timestamp) {
      const nextTimestamp = timestamped[timestamp.order + 1];
      const duration = nextTimestamp
        ? nextTimestamp.timestampSeconds - timestamp.timestampSeconds
        : FINAL_TIMESTAMPED_STEP_DURATION_SECONDS;

      if (
        duration >= MIN_BREW_STEP_DURATION_SECONDS &&
        step.duration_seconds !== duration
      ) {
        adjusted = true;
        return {
          ...step,
          duration_seconds: duration,
        };
      }

      return step;
    }

    if (
      index > lastTimestamped.index &&
      step.kind === "brew" &&
      isDrawdownLikeStep(step) &&
      step.duration_seconds > DRAWDOWN_STEP_DURATION_SECONDS
    ) {
      adjusted = true;
      return {
        ...step,
        duration_seconds: DRAWDOWN_STEP_DURATION_SECONDS,
      };
    }

    return step;
  });

  const normalizedLastTimestamped = steps[lastTimestamped.index];
  const finalTimestampedEndsAt = lastTimestamped.timestampSeconds +
    normalizedLastTimestamped.duration_seconds;
  const hasDrawdownStep = steps.some((step, index) =>
    index > lastTimestamped.index && step.kind === "brew" &&
    isDrawdownLikeStep(step)
  );
  if (
    completionTargetSeconds !== null &&
    completionTargetSeconds >
      finalTimestampedEndsAt + MIN_BREW_STEP_DURATION_SECONDS &&
    !hasDrawdownStep
  ) {
    adjusted = true;
    steps.push({
      step_order: steps.length + 1,
      kind: "brew",
      description_source: "manual",
      description_template: "Wait for the complete drawdown.",
      preview_text: "Wait for the complete drawdown.",
      duration_seconds: completionTargetSeconds - finalTimestampedEndsAt,
      expressions: [],
    });
  }

  return {
    steps,
    warnings: adjusted
      ? ["Elapsed-time brew steps were converted to step durations."]
      : [],
  };
}

function applyExtractionFallbacks(args: {
  normalized: NormalizedDraft;
  extraction: ExtractionResult;
}): NormalizedDraft {
  return {
    ...args.normalized,
    recipe: {
      ...args.normalized.recipe,
      coffee_amount: args.normalized.recipe.coffee_amount ??
        args.extraction.coffee_amount_grams,
      water_amount: args.normalized.recipe.water_amount ??
        args.extraction.water_amount,
      water_temp: args.normalized.recipe.water_temp ??
        args.extraction.water_temp_celsius,
    },
    localization: {
      ...args.normalized.localization,
      name: args.normalized.localization.name ?? args.extraction.name,
      grind_size: args.normalized.localization.grind_size ??
        args.extraction.grind_size,
      short_description: args.normalized.localization.short_description ??
        args.extraction.short_description,
    },
  };
}

function getMissingRequiredRepairFields(args: {
  normalized: NormalizedDraft;
  extraction: ExtractionResult;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): string[] {
  const normalizedWithFallbacks = applyExtractionFallbacks({
    normalized: args.normalized,
    extraction: args.extraction,
  });
  const resolvedBrewingMethod = resolveBrewingMethodId({
    brewingMethods: args.brewingMethods,
    brewingMethodHint: args.brewingMethodHint,
    normalizedBrewingMethodId: normalizedWithFallbacks.recipe.brewing_method_id,
    extractedLikelyBrewingMethod: args.extraction.likely_brewing_method,
  });

  const missingFields: string[] = [];

  if (!normalizedWithFallbacks.localization.name) {
    missingFields.push("localization.name");
  }
  if (!normalizedWithFallbacks.localization.grind_size) {
    missingFields.push("localization.grind_size");
  }
  if (!normalizedWithFallbacks.localization.short_description) {
    missingFields.push("localization.short_description");
  }
  if (!normalizedWithFallbacks.recipe.coffee_amount) {
    missingFields.push("recipe.coffee_amount");
  }
  if (!normalizedWithFallbacks.recipe.water_amount) {
    missingFields.push("recipe.water_amount");
  }
  if (!normalizedWithFallbacks.recipe.water_temp) {
    missingFields.push("recipe.water_temp");
  }
  if (!resolvedBrewingMethod.brewingMethodId) {
    missingFields.push("recipe.brewing_method_id");
  }

  return missingFields;
}

function getMalformedStepTemplateRepairFields(
  normalized: NormalizedDraft,
): string[] {
  const malformedFields: string[] = [];

  normalized.steps.forEach((step, index) => {
    if (
      collectMalformedSupportedPlaceholders(step.description_template).length &&
      hasInvalidExpressionSyntax(step.description_source)
    ) {
      malformedFields.push(`steps[${index}].description_template`);
    }
  });

  return malformedFields;
}

function shouldAttemptCumulativeRewritePass(args: {
  sourceLanguageHint?: string;
  detectedInputLanguage: string | null;
  draftSteps: DraftStep[];
}): boolean {
  const languageSignal = getPrimaryLanguageSignal([
    args.sourceLanguageHint,
    args.detectedInputLanguage,
  ]);
  if (!languageSignal || isEnglishLikeLanguage(languageSignal)) {
    return false;
  }

  const normalizedStepText = normalizeKeywordText(
    args.draftSteps.map((step) => step.description_template).join(" "),
  ).replace(/<[^>]+>/g, " ");
  const englishHintCount =
    ENGLISH_STEP_HINTS.filter((hint) =>
      new RegExp(`\\b${escapeRegExp(hint)}\\b`, "i").test(normalizedStepText)
    ).length;
  if (englishHintCount >= 2) {
    return false;
  }

  const waterBrewStepCount =
    args.draftSteps.filter((step) =>
      step.kind === "brew" &&
      step.expressions.some((expression) =>
        expression.placeholder === "<final_water_amount>"
      )
    ).length;

  return waterBrewStepCount >= 2;
}

function validateCumulativeRewriteSteps(args: {
  original: NormalizedDraft["steps"];
  rewritten: NormalizedDraft["steps"];
}): string | null {
  if (args.original.length !== args.rewritten.length) {
    return "cumulative rewrite changed step count";
  }

  for (let index = 0; index < args.original.length; index += 1) {
    const originalStep = args.original[index];
    const rewrittenStep = args.rewritten[index];

    if (originalStep.kind !== rewrittenStep.kind) {
      return `cumulative rewrite changed kind for step ${index}`;
    }

    if (originalStep.duration_seconds !== rewrittenStep.duration_seconds) {
      return `cumulative rewrite changed duration for step ${index}`;
    }

    if (originalStep.description_source !== rewrittenStep.description_source) {
      return `cumulative rewrite changed description_source for step ${index}`;
    }
  }

  return null;
}

function validateRewrittenStepTemplates(
  steps: NormalizedDraft["steps"],
): string | null {
  for (let index = 0; index < steps.length; index += 1) {
    const template = steps[index].description_template;
    if (FORBIDDEN_TIME_PLACEHOLDER_REGEX.test(template)) {
      return `cumulative rewrite introduced time placeholders in step ${index}`;
    }

    if (collectUnsupportedPlaceholders(template).length > 0) {
      return `cumulative rewrite introduced unsupported placeholders in step ${index}`;
    }

    if (collectMalformedSupportedPlaceholders(template).length > 0) {
      return `cumulative rewrite introduced malformed scalable expressions in step ${index}`;
    }
  }

  return null;
}

function scoreBrewingMethodCandidate(args: {
  candidate: string;
  method: BrewingMethodOption;
}): number {
  const candidateRaw = args.candidate.trim();
  const candidateNormalized = normalizeBrewingMethodToken(candidateRaw);
  const methodId = args.method.brewing_method_id.trim();
  const methodName = args.method.brewing_method.trim();
  const methodIdNormalized = normalizeBrewingMethodToken(methodId);
  const methodNameNormalized = normalizeBrewingMethodToken(methodName);

  if (candidateRaw === methodId) {
    return 120;
  }

  if (candidateRaw === methodName) {
    return 110;
  }

  if (candidateNormalized === methodIdNormalized) {
    return 100;
  }

  if (candidateNormalized === methodNameNormalized) {
    return 95;
  }

  if (
    candidateNormalized.length > 0 &&
    (candidateNormalized.includes(methodIdNormalized) ||
      methodIdNormalized.includes(candidateNormalized))
  ) {
    return 80;
  }

  if (
    candidateNormalized.length > 0 &&
    (candidateNormalized.includes(methodNameNormalized) ||
      methodNameNormalized.includes(candidateNormalized))
  ) {
    return 75;
  }

  return -1;
}

function resolveBrewingMethodId(args: {
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
  normalizedBrewingMethodId: string | null;
  extractedLikelyBrewingMethod: string | null;
}): {
  brewingMethodId: string | null;
  warnings: string[];
} {
  if (args.brewingMethodHint) {
    return {
      brewingMethodId: args.brewingMethodHint,
      warnings: [],
    };
  }

  const candidates = uniqueStrings([
    args.normalizedBrewingMethodId ?? "",
    args.extractedLikelyBrewingMethod ?? "",
  ]);

  for (const candidate of candidates) {
    const scoredMatches = args.brewingMethods
      .map((method) => ({
        method,
        score: scoreBrewingMethodCandidate({
          candidate,
          method,
        }),
      }))
      .filter((match) => match.score >= 0)
      .sort((left, right) => right.score - left.score);

    if (scoredMatches.length === 0) {
      continue;
    }

    const [bestMatch] = scoredMatches;
    const competingMatches = scoredMatches.filter((match) =>
      match.method.brewing_method_id !== bestMatch.method.brewing_method_id &&
      match.score === bestMatch.score
    );

    if (competingMatches.length > 0) {
      continue;
    }

    const warnings = candidate === bestMatch.method.brewing_method_id ? [] : [
      `Brewing method '${candidate}' was normalized to supported id '${bestMatch.method.brewing_method_id}'.`,
    ];

    return {
      brewingMethodId: bestMatch.method.brewing_method_id,
      warnings,
    };
  }

  return {
    brewingMethodId: null,
    warnings: candidates.length > 0
      ? [
        "Brewing method could not be matched to a supported brewing_method_id.",
      ]
      : [],
  };
}

function validateDraft(input: {
  draftSteps: DraftStep[];
  normalized: NormalizedDraft;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
}): {
  issues: ValidationIssue[];
  warnings: string[];
} {
  const issues: ValidationIssue[] = [];
  const warnings = [...input.normalized.warnings];
  const methodIds = new Set(
    input.brewingMethods.map((method) => method.brewing_method_id),
  );

  if (!input.normalized.localization.name) {
    issues.push({
      code: "missing_name",
      field: "localization.name",
      message: "Recipe name is required to publish a user recipe.",
    });
  }

  if (!input.normalized.localization.grind_size) {
    issues.push({
      code: "missing_grind_size",
      field: "localization.grind_size",
      message: "Grind size is required to publish a user recipe.",
    });
  }

  if (!input.normalized.localization.short_description) {
    issues.push({
      code: "missing_short_description",
      field: "localization.short_description",
      message: "Short description is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.coffee_amount) {
    issues.push({
      code: "missing_coffee_amount",
      field: "recipe.coffee_amount",
      message: "Coffee amount is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.water_amount) {
    issues.push({
      code: "missing_water_amount",
      field: "recipe.water_amount",
      message: "Water amount is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.water_temp) {
    issues.push({
      code: "missing_water_temp",
      field: "recipe.water_temp",
      message: "Water temperature is required to publish a user recipe.",
    });
  }

  if (!input.normalized.recipe.brewing_method_id) {
    issues.push({
      code: "missing_brewing_method",
      field: "recipe.brewing_method_id",
      message: "Brewing method could not be resolved confidently.",
    });
  } else if (!methodIds.has(input.normalized.recipe.brewing_method_id)) {
    issues.push({
      code: "invalid_brewing_method",
      field: "recipe.brewing_method_id",
      message:
        "Brewing method id is not part of the current supported methods.",
    });
  }

  if (
    !input.brewingMethodHint &&
    input.normalized.recipe.brewing_method_id &&
    input.normalized.recipe.brewing_method_confidence !== "high"
  ) {
    warnings.push(
      `Brewing method inference confidence is ${input.normalized.recipe.brewing_method_confidence}. Review before publishing.`,
    );
  }

  if (input.draftSteps.length === 0) {
    issues.push({
      code: "missing_steps",
      field: "steps",
      message: "At least one preparation step and one brew step are required.",
    });
    return {
      issues,
      warnings: uniqueStrings(warnings),
    };
  }

  const firstStep = input.draftSteps[0];
  if (firstStep.kind !== "preparation") {
    issues.push({
      code: "invalid_preparation_step",
      field: "steps[0].kind",
      message: "The first step must be the untimed preparation step.",
    });
  }

  if (firstStep.duration_seconds !== 0) {
    issues.push({
      code: "invalid_preparation_time",
      field: "steps[0].duration_seconds",
      message: "Preparation step duration must be 0 seconds.",
    });
  }

  const brewSteps = input.draftSteps.filter((step) => step.kind === "brew");
  if (brewSteps.length === 0) {
    issues.push({
      code: "missing_brew_steps",
      field: "steps",
      message: "At least one timed brew step is required.",
    });
  }

  input.draftSteps.forEach((step, index) => {
    if (index > 0 && step.kind !== "brew") {
      issues.push({
        code: "invalid_step_kind",
        field: `steps[${index}].kind`,
        message: "Only the first step may be a preparation step.",
      });
    }

    if (
      step.kind === "brew" &&
      step.duration_seconds < MIN_BREW_STEP_DURATION_SECONDS
    ) {
      issues.push({
        code: "invalid_step_duration",
        field: `steps[${index}].duration_seconds`,
        message:
          `All brew steps must have a concrete duration of at least ${MIN_BREW_STEP_DURATION_SECONDS} seconds.`,
      });
    }

    if (FORBIDDEN_TIME_PLACEHOLDER_REGEX.test(step.description_template)) {
      issues.push({
        code: "forbidden_time_placeholder",
        field: `steps[${index}].description_template`,
        message: "User recipes must not contain <tN> timer placeholders.",
      });
    }

    const unsupportedPlaceholders = collectUnsupportedPlaceholders(
      step.description_template,
    );
    if (unsupportedPlaceholders.length > 0) {
      issues.push({
        code: "unsupported_placeholder",
        field: `steps[${index}].description_template`,
        message: `Unsupported placeholders found: ${
          unsupportedPlaceholders.join(", ")
        }`,
      });
    }

    const malformedSupportedPlaceholders =
      collectMalformedSupportedPlaceholders(
        step.description_template,
      );
    if (malformedSupportedPlaceholders.length > 0) {
      issues.push({
        code: "invalid_scalable_expression",
        field: `steps[${index}].description_template`,
        message:
          `Supported quantity placeholders must use a numeric multiplier expression like (0.2 x <final_water_amount>)g. Malformed placeholders found: ${
            malformedSupportedPlaceholders.join(", ")
          }`,
      });
    }

    if (
      malformedSupportedPlaceholders.length === 0 &&
      (hasDanglingExpressionMultiplier(step.description_template) ||
        !hasBalancedParentheses(step.description_template))
    ) {
      issues.push({
        code: "invalid_scalable_expression",
        field: `steps[${index}].description_template`,
        message:
          "Step description contains incomplete scalable expression syntax.",
      });
    }
  });

  return {
    issues,
    warnings: uniqueStrings(warnings),
  };
}

function buildPublishProjection(input: {
  userId: string;
  normalized: NormalizedDraft;
  draftSteps: DraftStep[];
  brewTimeSeconds: number;
  nowMs: number;
}): PublishProjection {
  const recipeId = `usr-${input.userId}-${input.nowMs}`;
  const lastModified = new Date(input.nowMs).toISOString();

  return {
    user_recipe: {
      id: recipeId,
      brewing_method_id: input.normalized.recipe.brewing_method_id!,
      coffee_amount: input.normalized.recipe.coffee_amount!,
      water_amount: input.normalized.recipe.water_amount!,
      water_temp: input.normalized.recipe.water_temp!,
      brew_time: input.brewTimeSeconds,
      vendor_id: `usr-${input.userId}`,
      last_modified: lastModified,
      import_id: null,
      is_imported: false,
      ispublic: false,
      is_deleted: false,
      needs_moderation_review: false,
    },
    user_recipe_localization: {
      id: crypto.randomUUID(),
      recipe_id: recipeId,
      locale: "en",
      name: input.normalized.localization.name!,
      grind_size: input.normalized.localization.grind_size!,
      short_description: input.normalized.localization.short_description!,
    },
    user_steps: input.draftSteps.map((step) => ({
      id: crypto.randomUUID(),
      recipe_id: recipeId,
      step_order: step.step_order,
      description: step.description_template,
      time: String(step.duration_seconds),
      locale: "en" as const,
    })),
  };
}

function finalizeDraftResponse(input: {
  extraction: ExtractionResult;
  normalized: NormalizedDraft;
  userId: string;
  brewingMethods: BrewingMethodOption[];
  brewingMethodHint?: string;
  providerUsed: LlmProviderName;
  providerModelUsed: string;
  tokensUsed: number;
  openaiTokensUsed: number;
  skipDeterministicWaterTotals?: boolean;
  sourceText: string;
  nowMs: number;
}): ParseUserRecipeDraftResponse {
  const resolvedBrewingMethod = resolveBrewingMethodId({
    brewingMethods: input.brewingMethods,
    brewingMethodHint: input.brewingMethodHint,
    normalizedBrewingMethodId: input.normalized.recipe.brewing_method_id,
    extractedLikelyBrewingMethod: input.extraction.likely_brewing_method,
  });
  const normalizedWithHint: NormalizedDraft = {
    ...input.normalized,
    warnings: uniqueStrings([
      ...input.normalized.warnings,
      ...resolvedBrewingMethod.warnings,
    ]),
    recipe: {
      ...input.normalized.recipe,
      brewing_method_id: resolvedBrewingMethod.brewingMethodId,
    },
  };
  const normalizedWithBalancedCopy: NormalizedDraft = {
    ...normalizedWithHint,
    localization: {
      ...normalizedWithHint.localization,
      short_description: rebalanceShortDescription({
        normalized: normalizedWithHint,
        brewingMethods: input.brewingMethods,
      }),
    },
  };

  const builtDraftSteps = buildDraftSteps({
    steps: normalizedWithBalancedCopy.steps,
    coffeeAmount: normalizedWithBalancedCopy.recipe.coffee_amount,
    waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
  });
  const waterNormalizedDraftSteps = input.skipDeterministicWaterTotals
    ? builtDraftSteps
    : convertWaterStepsToRunningTotals({
      steps: builtDraftSteps,
      coffeeAmount: normalizedWithBalancedCopy.recipe.coffee_amount,
      waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
    });
  const timestampNormalizedDraftSteps = normalizeAbsoluteTimestampDurations({
    steps: waterNormalizedDraftSteps,
    sourceText: input.sourceText,
  });
  const totalTargetNormalizedDraftSteps =
    normalizeVagueBrewDurationsFromTotalTarget(
      {
        steps: timestampNormalizedDraftSteps.steps,
        sourceText: input.sourceText,
        brewingMethodId: normalizedWithBalancedCopy.recipe.brewing_method_id,
        waterAmount: normalizedWithBalancedCopy.recipe.water_amount,
      },
    );
  const durationNormalizedDraftSteps = enforceMinimumStepDurations({
    steps: totalTargetNormalizedDraftSteps.steps,
  });
  const draftSteps = durationNormalizedDraftSteps.steps;
  const brewSteps = draftSteps.filter((step) => step.kind === "brew");
  const brewTimeSeconds = brewSteps.length > 0 &&
      brewSteps.every((step) =>
        step.duration_seconds >= MIN_BREW_STEP_DURATION_SECONDS
      )
    ? brewSteps.reduce((sum, step) => sum + step.duration_seconds, 0)
    : null;

  const validation = validateDraft({
    draftSteps,
    normalized: normalizedWithBalancedCopy,
    brewingMethods: input.brewingMethods,
    brewingMethodHint: input.brewingMethodHint,
  });

  const response: ParseUserRecipeDraftResponse = {
    detected_input_language:
      normalizedWithBalancedCopy.detected_input_language ??
        input.extraction.detected_input_language,
    provider_used: input.providerUsed,
    provider_model_used: input.providerModelUsed,
    tokens_used: input.tokensUsed,
    openai_tokens_used: input.openaiTokensUsed,
    warnings: uniqueStrings([
      ...filterDiagnosticNotes(input.extraction.notes),
      ...timestampNormalizedDraftSteps.warnings,
      ...totalTargetNormalizedDraftSteps.warnings,
      ...durationNormalizedDraftSteps.warnings,
      ...validation.warnings,
    ]),
    validation: {
      is_publishable: validation.issues.length === 0,
      issues: validation.issues,
    },
    extraction: input.extraction,
    draft: {
      recipe: {
        brewing_method_id: normalizedWithBalancedCopy.recipe.brewing_method_id,
        coffee_amount: normalizedWithBalancedCopy.recipe.coffee_amount,
        water_amount: normalizedWithBalancedCopy.recipe.water_amount,
        water_temp: normalizedWithBalancedCopy.recipe.water_temp,
        brew_time_seconds: brewTimeSeconds,
        vendor_id: `usr-${input.userId}`,
      },
      localization: {
        locale: "en",
        name: normalizedWithBalancedCopy.localization.name,
        grind_size: normalizedWithBalancedCopy.localization.grind_size,
        short_description:
          normalizedWithBalancedCopy.localization.short_description,
      },
      steps: draftSteps,
    },
  };

  if (validation.issues.length === 0 && brewTimeSeconds !== null) {
    response.publish_projection = buildPublishProjection({
      userId: input.userId,
      normalized: normalizedWithBalancedCopy,
      draftSteps,
      brewTimeSeconds,
      nowMs: input.nowMs,
    });
  }

  return response;
}

export function createRecipeDraftParser(
  config: RecipeDraftParserConfig,
): RecipeDraftParser {
  const providers = buildProviders(config);
  const logger = config.logger ?? console;
  const now = config.now ?? (() => Date.now());

  if (providers.length === 0) {
    throw new Error(
      "No AI providers configured for parse-user-recipe-draft.",
    );
  }

  return {
    async parseDraft(
      input: RecipeDraftParserInput,
    ): Promise<ParseUserRecipeDraftResponse> {
      const activeProviders = input.disabledProviders?.length
        ? providers.filter((p) => !input.disabledProviders!.includes(p.name))
        : providers;

      let totalTokensUsed = 0;
      let openaiTokensUsed = 0;

      let extraction: ExtractionResult | null = null;
      let extractionProviderIndex = -1;

      for (let index = 0; index < activeProviders.length; index += 1) {
        const provider = activeProviders[index];
        try {
          const { result, tokensUsed } = await provider.invokeJson<
            ExtractionResult
          >({
            requestId: input.requestId,
            stage: "extraction",
            systemPrompt: buildExtractionSystemPrompt(),
            userPrompt: buildExtractionUserPrompt({
              text: input.text,
              brewingMethodHint: input.brewingMethodHint,
              sourceLanguageHint: input.sourceLanguageHint,
            }),
            schema: extractionSchema,
          });
          extraction = result;
          totalTokensUsed += tokensUsed;
          if (provider.name === "openai") openaiTokensUsed += tokensUsed;
          extractionProviderIndex = index;
          break;
        } catch (error) {
          logger.warn(
            `[parse-user-recipe-draft] extraction_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} error=${
              summarizeError(error)
            }`,
          );
        }
      }

      if (!extraction || extractionProviderIndex === -1) {
        throw new Error("All providers failed during recipe extraction.");
      }

      extraction = normalizeExtractionTemperatures(extraction);

      let normalized: NormalizedDraft | null = null;
      let normalizationProviderIndex = -1;

      for (
        let index = extractionProviderIndex;
        index < activeProviders.length;
        index += 1
      ) {
        const provider = activeProviders[index];
        try {
          const { result, tokensUsed } = await provider.invokeJson<
            NormalizedDraft
          >({
            requestId: input.requestId,
            stage: "normalization",
            systemPrompt: buildNormalizationSystemPrompt(),
            userPrompt: buildNormalizationUserPrompt({
              extraction,
              brewingMethods: input.brewingMethods,
              brewingMethodHint: input.brewingMethodHint,
            }),
            schema: normalizedDraftSchema,
          });
          normalized = result;
          totalTokensUsed += tokensUsed;
          if (provider.name === "openai") openaiTokensUsed += tokensUsed;
          normalizationProviderIndex = index;
          break;
        } catch (error) {
          logger.warn(
            `[parse-user-recipe-draft] normalization_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} error=${
              summarizeError(error)
            }`,
          );
        }
      }

      if (!normalized || normalizationProviderIndex === -1) {
        throw new Error("All providers failed during recipe normalization.");
      }

      normalized = normalizeDraftTemperatures(normalized);
      normalized = applyExtractionFallbacks({
        normalized,
        extraction,
      });

      let finalProviderIndex = normalizationProviderIndex;
      const repairFields = uniqueStrings([
        ...getMissingRequiredRepairFields({
          normalized,
          extraction,
          brewingMethods: input.brewingMethods,
          brewingMethodHint: input.brewingMethodHint,
        }),
        ...getMalformedStepTemplateRepairFields(normalized),
      ]);

      const REPAIR_MAX_ATTEMPTS_PER_PROVIDER = 2;

      if (repairFields.length > 0) {
        for (
          let index = normalizationProviderIndex;
          index < activeProviders.length;
          index += 1
        ) {
          const provider = activeProviders[index];
          let repairSucceeded = false;

          for (
            let attempt = 0;
            attempt < REPAIR_MAX_ATTEMPTS_PER_PROVIDER;
            attempt += 1
          ) {
            try {
              const { result: repaired, tokensUsed } = await provider
                .invokeJson<NormalizedDraft>({
                  requestId: input.requestId,
                  stage: "repair",
                  systemPrompt: buildRepairSystemPrompt(),
                  userPrompt: buildRepairUserPrompt({
                    text: input.text,
                    extraction,
                    normalized,
                    missingFields: repairFields,
                    brewingMethods: input.brewingMethods,
                    brewingMethodHint: input.brewingMethodHint,
                  }),
                  schema: normalizedDraftSchema,
                });
              totalTokensUsed += tokensUsed;
              if (provider.name === "openai") openaiTokensUsed += tokensUsed;

              const repairedWithNormalizedTemperatures =
                normalizeDraftTemperatures(
                  repaired,
                );
              const repairedWithFallbacks = applyExtractionFallbacks({
                normalized: repairedWithNormalizedTemperatures,
                extraction,
              });
              const remainingRepairFields = uniqueStrings([
                ...getMissingRequiredRepairFields({
                  normalized: repairedWithFallbacks,
                  extraction,
                  brewingMethods: input.brewingMethods,
                  brewingMethodHint: input.brewingMethodHint,
                }),
                ...getMalformedStepTemplateRepairFields(repairedWithFallbacks),
              ]);

              if (remainingRepairFields.length > 0) {
                throw new Error(
                  `repair still missing or malformed fields: ${
                    remainingRepairFields.join(", ")
                  }`,
                );
              }

              normalized = {
                ...repairedWithFallbacks,
                warnings: uniqueStrings([
                  ...repairedWithFallbacks.warnings,
                  "Missing or malformed fields were repaired after re-reading the original text.",
                ]),
              };
              finalProviderIndex = index;
              repairSucceeded = true;
              break;
            } catch (error) {
              logger.warn(
                `[parse-user-recipe-draft] repair_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} attempt=${
                  attempt + 1
                }/${REPAIR_MAX_ATTEMPTS_PER_PROVIDER} missing_fields=${
                  repairFields.join(",")
                } error=${summarizeError(error)}`,
              );
            }
          }

          if (repairSucceeded) break;
        }
      }

      let skipDeterministicWaterTotals = false;
      const provisionalDraftSteps = buildDraftSteps({
        steps: normalized.steps,
        coffeeAmount: normalized.recipe.coffee_amount,
        waterAmount: normalized.recipe.water_amount,
      });
      const detectedInputLanguage = getPrimaryLanguageSignal([
        input.sourceLanguageHint,
        normalized.detected_input_language,
        extraction.detected_input_language,
      ]);

      if (
        shouldAttemptCumulativeRewritePass({
          sourceLanguageHint: input.sourceLanguageHint,
          detectedInputLanguage,
          draftSteps: provisionalDraftSteps,
        })
      ) {
        for (
          let index = finalProviderIndex;
          index < activeProviders.length;
          index += 1
        ) {
          const provider = activeProviders[index];
          try {
            const {
              result: rewritten,
              tokensUsed,
            }: { result: CumulativeRewriteResult; tokensUsed: number } =
              await provider.invokeJson<CumulativeRewriteResult>({
                requestId: input.requestId,
                stage: "cumulative_rewrite",
                systemPrompt: buildCumulativeRewriteSystemPrompt(),
                userPrompt: buildCumulativeRewriteUserPrompt({
                  detectedInputLanguage,
                  normalized,
                  draftSteps: provisionalDraftSteps,
                }),
                schema: cumulativeRewriteSchema,
              });
            totalTokensUsed += tokensUsed;
            if (provider.name === "openai") openaiTokensUsed += tokensUsed;

            const rewriteValidationError = validateCumulativeRewriteSteps({
              original: normalized.steps,
              rewritten: rewritten.steps,
            });
            if (rewriteValidationError) {
              throw new Error(rewriteValidationError);
            }

            const rewrittenTemplateValidationError =
              validateRewrittenStepTemplates(rewritten.steps);
            if (rewrittenTemplateValidationError) {
              throw new Error(rewrittenTemplateValidationError);
            }

            normalized = {
              ...normalized,
              warnings: uniqueStrings([
                ...normalized.warnings,
                ...rewritten.warnings,
              ]),
              steps: rewritten.steps,
            };
            finalProviderIndex = index;
            skipDeterministicWaterTotals = true;
            break;
          } catch (error) {
            logger.warn(
              `[parse-user-recipe-draft] cumulative_rewrite_failed requestId=${input.requestId} provider=${provider.name} model=${provider.model} error=${
                summarizeError(error)
              }`,
            );
          }
        }
      }

      return finalizeDraftResponse({
        extraction,
        normalized,
        userId: input.userId,
        brewingMethods: input.brewingMethods,
        brewingMethodHint: input.brewingMethodHint,
        providerUsed: activeProviders[finalProviderIndex].name,
        providerModelUsed: activeProviders[finalProviderIndex].model,
        tokensUsed: totalTokensUsed,
        openaiTokensUsed,
        skipDeterministicWaterTotals,
        sourceText: input.text,
        nowMs: now(),
      });
    },
  };
}
