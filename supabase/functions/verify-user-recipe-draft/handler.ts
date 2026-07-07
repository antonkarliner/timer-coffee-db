import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import {
  type BrewingMethodOption,
  type LlmProviderName,
  type ParseUserRecipeDraftResponse,
  type RecipeDraftParser,
} from "../parse-user-recipe-draft/parser.ts";

const OPENAI_DAILY_TOKEN_BUDGET = 10_000_000;
const HOURLY_USER_REQUEST_LIMIT = 10;

type AuthenticatedUser = {
  id: string;
  isAnonymous: boolean;
};

const recipeSchema = z.object({
  name: z.string().trim().min(1),
  brewing_method_id: z.string().trim().min(1),
  coffee_amount: z.number().positive(),
  water_amount: z.number().positive(),
  water_temp: z.number().positive().nullable().optional(),
  brew_time_seconds: z.number().int().nonnegative(),
  grind_size: z.string().trim().min(1),
  short_description: z.string().trim().min(1),
});

const stepSchema = z.object({
  order: z.number().int().positive(),
  kind: z.enum(["preparation", "brew"]),
  description: z.string().trim().min(1),
  duration_seconds: z.number().int().nonnegative(),
});

export const verifyUserRecipeDraftRequestSchema = z.object({
  app_locale: z.string().trim().min(1),
  source_language_hint: z.string().trim().min(1).nullable().optional(),
  consent_to_diagnostics: z.boolean().default(false),
  recipe: recipeSchema,
  steps: z.array(stepSchema).min(1),
});

export type VerifyUserRecipeDraftRequest = z.infer<
  typeof verifyUserRecipeDraftRequestSchema
>;

export type VerifyUserRecipeDraftHandlerDeps = {
  parser: RecipeDraftParser;
  getUserFromToken(token: string): Promise<AuthenticatedUser | null>;
  getBrewingMethods(): Promise<BrewingMethodOption[]>;
  getOpenAiDailyTokensUsed(): Promise<number>;
  getRecentInvocationCount(userId: string, sinceIso: string): Promise<number>;
  logInvocation(data: {
    userId: string;
    tokensUsed: number;
    openaiTokensUsed: number;
    providerUsed: string;
    providerModelUsed: string;
  }): Promise<{ id: number | null }>;
  logDiagnostic(data: {
    invocationId: number | null;
    userId: string;
    request: VerifyUserRecipeDraftRequest;
    result: ParseUserRecipeDraftResponse;
    correctedSteps: Array<Record<string, unknown>>;
  }): Promise<void>;
  getCorsHeaders(origin?: string): Record<string, string>;
  createResponse(
    body: string,
    init: ResponseInit & { headers?: Record<string, string> },
  ): Response;
  now?: () => Date;
};

function jsonResponse(
  deps: VerifyUserRecipeDraftHandlerDeps,
  cors: Record<string, string>,
  status: number,
  body: unknown,
): Response {
  return deps.createResponse(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.join(".") || "body") + ": " + issue.message)
    .join("; ");
}

function buildVerifierText(request: VerifyUserRecipeDraftRequest): string {
  const recipe = request.recipe;
  const stepLines = request.steps
    .map((step) =>
      String(step.order) + ". [" + step.kind + ", " +
      String(step.duration_seconds) + "s] " + step.description
    )
    .join("\n");

  return [
    "Verify this user-created coffee recipe.",
    "Correct only scalable coffee and water amount expressions in step text.",
    "Preserve the source language and wording wherever possible.",
    "App locale: " + request.app_locale,
    "Source language hint: " +
    (request.source_language_hint ?? request.app_locale),
    "Recipe name: " + recipe.name,
    "Short description: " + recipe.short_description,
    "Brewing method id: " + recipe.brewing_method_id,
    "Coffee amount: " + String(recipe.coffee_amount) + " g",
    "Water amount: " + String(recipe.water_amount) + " ml",
    "Water temperature: " + String(recipe.water_temp ?? "unknown") + " C",
    "Grind size: " + recipe.grind_size,
    "Total brew time: " + String(recipe.brew_time_seconds) + " seconds",
    "Steps:",
    stepLines,
  ].join("\n");
}

const NUMERIC_RANGE_REGEX = /\d+\s*[-‐-―]\s*\d+/;

const WATER_NOUN_TOKENS = [
  "water",
  "eau",
  "wasser",
  "acqua",
  "agua",
  "água",
  "вода",
  "воды",
  "воду",
  "води",
  "ماء",
  "آب",
  "su",
  "물",
  "お湯",
  "水",
  "水量",
  "woda",
  "wody",
];

const COFFEE_NOUN_TOKENS = [
  "coffee",
  "grounds",
  "beans",
  "café",
  "cafe",
  "kaffee",
  "koffie",
  "caffè",
  "caffe",
  "кофе",
  "кава",
  "قهوة",
  "قهوه",
  "kahve",
  "커피",
  "コーヒー",
  "咖啡",
  "kawa",
];

const GENERIC_PREPARATION_PLACEHOLDERS = new Set([
  "preparation",
  "prep",
  "setup",
  "prepara",
  "préparation",
  "preparación",
  "preparazione",
  "vorbereitung",
  "voorbereiding",
  "подготовка",
  "підготовка",
  "준비",
  "준비하기",
  "準備",
  "준비",
  "hazırlık",
  "przygotowanie",
  "preparare",
  "förberedelse",
  "klargøring",
  "valmistelu",
  "klargjøring",
  "",
]);

function containsTokenIgnoringCase(text: string, token: string): boolean {
  if (!token) return false;
  return text.toLowerCase().includes(token.toLowerCase());
}

function inputContainsAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => containsTokenIgnoringCase(text, token));
}

function revertLossyRewrites(
  request: VerifyUserRecipeDraftRequest,
  result: ParseUserRecipeDraftResponse,
): void {
  if (result.draft.steps.length !== request.steps.length) {
    return;
  }

  for (let index = 0; index < result.draft.steps.length; index += 1) {
    const inputStep = request.steps[index];
    const outputStep = result.draft.steps[index];
    const inputDescription = inputStep.description;
    const outputDescription = outputStep.description_template;

    const inputHasRange = NUMERIC_RANGE_REGEX.test(inputDescription);
    const outputHasRange = NUMERIC_RANGE_REGEX.test(outputDescription);

    const inputHasWaterNoun = inputContainsAnyToken(
      inputDescription,
      WATER_NOUN_TOKENS,
    );
    const outputHasWaterNoun = inputContainsAnyToken(
      outputDescription,
      WATER_NOUN_TOKENS,
    );

    const inputHasCoffeeNoun = inputContainsAnyToken(
      inputDescription,
      COFFEE_NOUN_TOKENS,
    );
    const outputHasCoffeeNoun = inputContainsAnyToken(
      outputDescription,
      COFFEE_NOUN_TOKENS,
    );

    const trimmedLowerInput = inputDescription.trim().toLowerCase();
    const inputIsGenericPreparation = inputStep.order === 1 &&
      GENERIC_PREPARATION_PLACEHOLDERS.has(trimmedLowerInput);
    const preparationWasRewritten = inputIsGenericPreparation &&
      outputDescription.trim() !== inputDescription.trim();

    const lostRange = inputHasRange && !outputHasRange;
    const lostWaterNoun = inputHasWaterNoun && !outputHasWaterNoun;
    const lostCoffeeNoun = inputHasCoffeeNoun && !outputHasCoffeeNoun;

    if (
      lostRange ||
      lostWaterNoun ||
      lostCoffeeNoun ||
      preparationWasRewritten
    ) {
      outputStep.description_template = inputDescription;
      outputStep.preview_text = inputDescription;
    }
  }
}

function mapCorrectedSteps(
  request: VerifyUserRecipeDraftRequest,
  result: ParseUserRecipeDraftResponse,
): Array<Record<string, unknown>> | null {
  if (result.draft.steps.length !== request.steps.length) {
    return null;
  }

  return result.draft.steps.map((step, index) => ({
    order: request.steps[index].order,
    kind: request.steps[index].kind,
    description_template: step.description_template,
    duration_seconds: request.steps[index].duration_seconds,
  }));
}

export function createVerifyUserRecipeDraftHandler(
  deps: VerifyUserRecipeDraftHandlerDeps,
) {
  return async function handleRequest(req: Request): Promise<Response> {
    const cors = deps.getCorsHeaders(req.headers.get("origin") ?? undefined);

    if (req.method === "OPTIONS") {
      return deps.createResponse("ok", {
        headers: cors,
      });
    }

    if (req.method !== "POST") {
      return jsonResponse(deps, cors, 405, {
        error: "Method Not Allowed",
      });
    }

    const token = getBearerToken(req);
    if (!token) {
      return jsonResponse(deps, cors, 401, {
        error: "Unauthorized",
        message: "Missing or invalid Authorization header.",
      });
    }

    const user = await deps.getUserFromToken(token);
    if (!user) {
      return jsonResponse(deps, cors, 401, {
        error: "Unauthorized",
        message: "Could not resolve the authenticated user.",
      });
    }

    if (user.isAnonymous) {
      return jsonResponse(deps, cors, 403, {
        error: "Forbidden",
        message: "AI recipe review is available only to signed-in users.",
      });
    }

    const now = deps.now?.() ?? new Date();
    const sinceIso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const recentInvocationCount = await deps.getRecentInvocationCount(
      user.id,
      sinceIso,
    );
    if (recentInvocationCount >= HOURLY_USER_REQUEST_LIMIT) {
      return jsonResponse(deps, cors, 429, {
        error: "Too Many Requests",
        message: "AI recipe review rate limit exceeded.",
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(deps, cors, 400, {
        error: "Bad Request",
        message: "Request body must be valid JSON.",
      });
    }

    let parsedBody: VerifyUserRecipeDraftRequest;
    try {
      parsedBody = verifyUserRecipeDraftRequestSchema.parse(body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return jsonResponse(deps, cors, 400, {
          error: "Bad Request",
          message: formatValidationError(error),
        });
      }

      return jsonResponse(deps, cors, 400, {
        error: "Bad Request",
        message: "Invalid request payload.",
      });
    }

    try {
      const [brewingMethods, openAiDailyTokens] = await Promise.all([
        deps.getBrewingMethods(),
        deps.getOpenAiDailyTokensUsed(),
      ]);

      if (
        !brewingMethods.some((method) =>
          method.brewing_method_id === parsedBody.recipe.brewing_method_id
        )
      ) {
        return jsonResponse(deps, cors, 400, {
          error: "Bad Request",
          message: "Unknown brewing_method_id '" +
            parsedBody.recipe.brewing_method_id + "'.",
        });
      }

      const disabledProviders: LlmProviderName[] =
        openAiDailyTokens >= OPENAI_DAILY_TOKEN_BUDGET ? ["openai"] : [];

      const result = await deps.parser.parseDraft({
        text: buildVerifierText(parsedBody),
        userId: user.id,
        brewingMethods,
        brewingMethodHint: parsedBody.recipe.brewing_method_id,
        sourceLanguageHint: parsedBody.source_language_hint ??
          parsedBody.app_locale,
        requestId: crypto.randomUUID(),
        disabledProviders,
        mode: "verify",
      });

      revertLossyRewrites(parsedBody, result);

      const correctedSteps = mapCorrectedSteps(parsedBody, result);
      if (!correctedSteps) {
        return jsonResponse(deps, cors, 502, {
          error: "Provider Error",
          message: "AI correction changed the recipe step count.",
        });
      }

      const invocation = await deps.logInvocation({
        userId: user.id,
        tokensUsed: result.tokens_used,
        openaiTokensUsed: result.openai_tokens_used,
        providerUsed: result.provider_used,
        providerModelUsed: result.provider_model_used,
      });

      if (parsedBody.consent_to_diagnostics) {
        deps.logDiagnostic({
          invocationId: invocation.id,
          userId: user.id,
          request: parsedBody,
          result,
          correctedSteps,
        }).catch(() => {});
      }

      return jsonResponse(deps, cors, 200, {
        detected_input_language: result.detected_input_language,
        provider_used: result.provider_used,
        provider_model_used: result.provider_model_used,
        tokens_used: result.tokens_used,
        openai_tokens_used: result.openai_tokens_used,
        warnings: result.warnings,
        issues: result.validation.issues,
        corrected_steps: correctedSteps,
      });
    } catch (error) {
      return jsonResponse(deps, cors, 502, {
        error: "Provider Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
