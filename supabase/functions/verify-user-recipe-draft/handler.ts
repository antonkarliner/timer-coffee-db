import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import {
  type BrewingMethodOption,
  type LlmProviderName,
  type ParseUserRecipeDraftResponse,
  type RecipeDraftParser,
} from "../parse-user-recipe-draft/parser.ts";

export const OPENAI_DAILY_TOKEN_BUDGET = 10_000_000;
export const HOURLY_USER_REQUEST_LIMIT = 10;

// Upper bound on OpenAI tokens one verification can bill, reserved against the
// daily budget at admission and released to the actual usage afterwards.
// Attempts: 2 OpenAI models (medium, big) x 2 tries x 4 stages (extraction,
// normalization, repair, cumulative rewrite) = 16.
// Output: 2 x 2 x (8000 + 4000 + 4000 + 4000) = 80,000.
// Input per attempt, at a conservative 3 characters per token: system prompt
// (~18,200 characters, measured 2026-10-07) ~7,000 + verifier text (capped by
// the request schema below at ~54,000 characters) ~18,000 + earlier stage JSON
// fed back in (extraction 8,000 + normalized 4,000) 12,000 = ~37,000;
// 16 x 37,000 = 592,000. Total ~672,000, rounded up. Production's largest
// verification so far billed 18,207 tokens.
export const OPENAI_RESERVATION_PER_REQUEST = 700_000;

type AuthenticatedUser = {
  id: string;
  isAnonymous: boolean;
};

const recipeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  brewing_method_id: z.string().trim().min(1),
  coffee_amount: z.number().positive(),
  water_amount: z.number().positive(),
  water_temp: z.number().positive().nullable().optional(),
  brew_time_seconds: z.number().int().nonnegative(),
  grind_size: z.string().trim().min(1).max(200),
  short_description: z.string().trim().min(1).max(1000),
});

const stepSchema = z.object({
  order: z.number().int().positive(),
  kind: z.enum(["preparation", "brew"]),
  description: z.string().trim().min(1).max(1000),
  duration_seconds: z.number().int().nonnegative(),
});

export const verifyUserRecipeDraftRequestSchema = z.object({
  app_locale: z.string().trim().min(1).max(35),
  source_language_hint: z.string().trim().min(1).max(35).nullable().optional(),
  consent_to_diagnostics: z.boolean().default(false),
  recipe: recipeSchema,
  // Bounded so OPENAI_RESERVATION_PER_REQUEST is a true upper bound. The
  // largest production request so far had 21 steps and 318-character steps.
  steps: z.array(stepSchema).min(1).max(50),
});

export type VerifyUserRecipeDraftRequest = z.infer<
  typeof verifyUserRecipeDraftRequestSchema
>;

export type VerifyUserRecipeDraftHandlerDeps = {
  parser: RecipeDraftParser;
  getUserFromToken(token: string): Promise<AuthenticatedUser | null>;
  getBrewingMethods(): Promise<BrewingMethodOption[]>;
  admitInvocation(userId: string): Promise<{
    admitted: boolean;
    invocationId: number | null;
    openAiAllowed: boolean;
  }>;
  finalizeInvocation(data: {
    invocationId: number;
    status: "succeeded" | "failed";
    tokensUsed: number;
    openaiTokensUsed: number;
    providerUsed: string | null;
    providerModelUsed: string | null;
    billingUnknown: boolean;
  }): Promise<void>;
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
  // Defect 2 (Aug 2026 live pass): Arabic, Chinese (simplified — "準備"
  // above already covers traditional Chinese, shared with Japanese), and
  // Hebrew were missing entirely, so a step like the Arabic
  // "الإعداد: Filter einlegen und Dripper vorbereiten." was not recognized
  // as a generic-preparation placeholder at all and its dropped prefix
  // was never restored (see matchGenericPreparationPrefix below).
  "الإعداد",
  "إعداد",
  "تحضير",
  "准备",
  "הכנה",
  "",
]);

// Defect 2 (Aug 2026 live pass): matches punctuation/whitespace that can
// separate a generic-preparation placeholder word from real content that
// follows it (e.g. "الإعداد: Filter einlegen..." or "準備：フィルターを..."),
// covering both ASCII and fullwidth/CJK punctuation.
const GENERIC_PREPARATION_PREFIX_SEPARATOR_REGEX =
  /^[\s:：、,，\-–—]+/;

function containsTokenIgnoringCase(text: string, token: string): boolean {
  if (!token) return false;
  return text.toLowerCase().includes(token.toLowerCase());
}

function inputContainsAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => containsTokenIgnoringCase(text, token));
}

// Defect 2 (Aug 2026 live pass): previously this only matched the WHOLE
// input string against GENERIC_PREPARATION_PLACEHOLDERS, so a placeholder
// word followed by real content (a prefix, not the whole string) was never
// recognized and its dropped prefix was never restored — the AI model's
// correctly-preserved German content came back with the Arabic "الإعداد: "
// label silently missing. This checks for the placeholder as either the
// WHOLE trimmed input (hasRealContent: false — the original whole-string
// case) or a PREFIX of it followed by a separator and further content
// (hasRealContent: true). `toLowerCase()` is a no-op for scripts with no
// case concept (Arabic, Hebrew, Chinese, Korean, Japanese) and only
// affects the Latin/Cyrillic-alphabet entries above, so this is safe
// across every placeholder in the set.
function matchGenericPreparationPrefix(
  text: string,
): { prefixLength: number; hasRealContent: boolean } | null {
  const trimmed = text.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  // Longest-first so a longer placeholder (e.g. "préparation") is matched
  // in full rather than stopping at a shorter placeholder that happens to
  // be one of its prefixes (e.g. "prepara").
  const sortedPlaceholders = [...GENERIC_PREPARATION_PLACEHOLDERS]
    .filter((placeholder) => placeholder.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const placeholder of sortedPlaceholders) {
    const lowerPlaceholder = placeholder.toLowerCase();
    if (!lowerTrimmed.startsWith(lowerPlaceholder)) {
      continue;
    }

    const remainder = trimmed.slice(placeholder.length);
    if (remainder.length === 0) {
      return { prefixLength: placeholder.length, hasRealContent: false };
    }

    const separatorMatch = remainder.match(
      GENERIC_PREPARATION_PREFIX_SEPARATOR_REGEX,
    );
    if (!separatorMatch) {
      continue;
    }

    const contentStart = separatorMatch[0].length;
    if (remainder.slice(contentStart).trim().length > 0) {
      return {
        prefixLength: placeholder.length + contentStart,
        hasRealContent: true,
      };
    }
  }

  return null;
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

    const preparationPrefixMatch = inputStep.order === 1
      ? matchGenericPreparationPrefix(inputDescription)
      : null;

    // A BARE generic-preparation placeholder (no real content of its own,
    // e.g. input "Preparation") is entirely hallucinated if the model
    // changed it at all — revert the whole step, exactly as before.
    const preparationWasRewritten = preparationPrefixMatch !== null &&
      !preparationPrefixMatch.hasRealContent &&
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
      continue;
    }

    // Defect 2 (Aug 2026 live pass): a generic-preparation-word PREFIX
    // followed by real content (e.g. the Arabic "الإعداد: Filter
    // einlegen...") must keep that prefix even when the model otherwise
    // correctly preserved the real content — restore only the missing
    // prefix instead of rejecting the whole (correctly-handled) step.
    if (preparationPrefixMatch?.hasRealContent) {
      const prefix = inputDescription.trim().slice(
        0,
        preparationPrefixMatch.prefixLength,
      );
      const outputTrimmed = outputDescription.trim();
      const outputAlreadyHasPrefix = outputTrimmed
        .toLowerCase()
        .startsWith(prefix.toLowerCase());

      if (!outputAlreadyHasPrefix) {
        // `prefix` already carries whatever separator (and its own
        // whitespace, if any) the ORIGINAL input used — e.g. ": " for the
        // Arabic case above, but no space at all after the fullwidth "："
        // in a Chinese "准备：..." input, since CJK punctuation
        // conventionally has none. Concatenate directly rather than
        // inserting an extra space, so the restored prefix matches the
        // source's own formatting instead of a Latin-punctuation default.
        const restored = `${prefix}${outputTrimmed}`;
        outputStep.description_template = restored;
        outputStep.preview_text = restored;
      }
    }
  }
}

// Defect (Aug 2026 live 4-step verify run, see plans/009 §"Live browser
// robustness regression" and plans/012): a live request kept its step count
// (4 in, 4 out) and none of the lossy-rewrite guards above fired — no range,
// water noun, coffee noun, or preparation placeholder was lost — yet the
// model still rewrote wording verify mode's prompt told it to preserve
// verbatim. Step 3 lost its leading elapsed-time landmark "At 0:45," and
// amount spacing was reflowed ("50 g" -> "50g", "300 g" -> "300g"). Those two
// changes are different in kind: reflowing the space between a number and
// its unit is cosmetic (the amount is still correct and legible), but
// dropping "At 0:45," deletes information the source explicitly stated —
// when in the brew to perform the pour — which a timer app cannot recover.
//
// This guard masks out amount tokens (both plain literal amounts like
// "300g"/"300 g" and the parser's own scalable expressions like
// "(0.2 x <final_water_amount>)g") from both the submitted description and
// the corrected template before comparing them, so legitimate amount
// templating and cosmetic unit-spacing changes never trip it. Any OTHER
// wording difference — a dropped clause, a reordered phrase, a deleted
// timing landmark — still does, and is reverted to the submitted text, the
// same remedy already used by revertLossyRewrites above. A per-step revert
// was chosen over a whole-draft rejection: it is the treatment already
// established for the other lossy-rewrite cases, and blocking the entire
// draft would discard correctly-preserved steps to punish a fault localized
// to one step. It was chosen over a warning-only response because
// `is_publishable: true` and low-visibility warnings are exactly how this
// defect shipped silently in the first place — verify mode's contract is
// that nothing gets silently rewritten, so the fix must not depend on
// anyone reading a warning.
const AMOUNT_UNIT_TOKENS = [
  "milliliters",
  "milliliter",
  "millilitres",
  "millilitre",
  "grammes",
  "gramme",
  "grams",
  "gram",
  "liters",
  "liter",
  "litres",
  "litre",
  "ounces",
  "ounce",
  "onces",
  "once",
  "kg",
  "ml",
  "oz",
  "gr",
  "g",
  "l",
];

// Mirrors the shape of the scalable expressions parser.ts emits, e.g.
// "(0.24 x <final_water_amount>)g" — matched and masked as a single unit so
// legitimate literal-to-expression templating never trips the drift check.
const SCALABLE_EXPRESSION_MASK_REGEX =
  /\(\s*[\d.]+\s*(?:x|×)\s*<final_(?:coffee|water)_amount>\s*\)\s*[^\s()<>]*/gi;

// Longest-unit-first so an alternation match like "gr" or "gram" is taken in
// full rather than stopping at the shorter "g" that happens to prefix it.
const LITERAL_AMOUNT_MASK_REGEX = new RegExp(
  `\\d+(?:\\.\\d+)?\\s*(?:${
    AMOUNT_UNIT_TOKENS.join("|")
  })(?=$|[\\s,.;:!?)]|\\b)`,
  "giu",
);

// A private-use-area character: essentially guaranteed not to collide with
// real recipe text, so masking never accidentally creates a spurious match.
const AMOUNT_MASK_TOKEN = "";

function maskAmountsForDriftComparison(text: string): string {
  return text
    .replace(SCALABLE_EXPRESSION_MASK_REGEX, AMOUNT_MASK_TOKEN)
    .replace(LITERAL_AMOUNT_MASK_REGEX, AMOUNT_MASK_TOKEN)
    .replace(/\s+/g, " ")
    .trim();
}

function revertNonAmountWordingDrift(
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

    if (
      maskAmountsForDriftComparison(inputDescription) !==
        maskAmountsForDriftComparison(outputDescription)
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

    let admission;
    try {
      admission = await deps.admitInvocation(user.id);
      if (admission.admitted && admission.invocationId === null) {
        throw new Error("Admission returned no invocation id.");
      }
    } catch {
      return jsonResponse(deps, cors, 503, {
        error: "Service Unavailable",
        message: "AI recipe review is temporarily unavailable.",
      });
    }
    if (!admission.admitted) {
      return jsonResponse(deps, cors, 429, {
        error: "Too Many Requests",
        message: "AI recipe review rate limit exceeded.",
      });
    }

    const invocationId = admission.invocationId!;
    let tokensUsed = 0;
    let openaiTokensUsed = 0;
    let billingUnknown = false;
    let finalized = false;
    const finalize = async (
      status: "succeeded" | "failed",
      result?: ParseUserRecipeDraftResponse,
    ) => {
      if (finalized) return;
      finalized = true;
      try {
        await deps.finalizeInvocation({
          invocationId,
          status,
          tokensUsed,
          openaiTokensUsed,
          providerUsed: result?.provider_used ?? null,
          providerModelUsed: result?.provider_model_used ?? null,
          billingUnknown,
        });
      } catch (error) {
        console.error("Failed to finalize recipe verification:", error);
      }
    };

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      await finalize("failed");
      return jsonResponse(deps, cors, 400, {
        error: "Bad Request",
        message: "Request body must be valid JSON.",
      });
    }

    let parsedBody: VerifyUserRecipeDraftRequest;
    try {
      parsedBody = verifyUserRecipeDraftRequestSchema.parse(body);
    } catch (error) {
      await finalize("failed");
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
      const brewingMethods = await deps.getBrewingMethods();

      if (
        !brewingMethods.some((method) =>
          method.brewing_method_id === parsedBody.recipe.brewing_method_id
        )
      ) {
        await finalize("failed");
        return jsonResponse(deps, cors, 400, {
          error: "Bad Request",
          message: "Unknown brewing_method_id '" +
            parsedBody.recipe.brewing_method_id + "'.",
        });
      }

      const disabledProviders: LlmProviderName[] = admission.openAiAllowed
        ? []
        : ["openai"];

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
        onProviderUsage(usage) {
          tokensUsed += usage.totalTokens ?? 0;
          if (usage.provider === "openai") {
            openaiTokensUsed += usage.totalTokens ?? 0;
            if (usage.totalTokens === null) billingUnknown = true;
          }
          // Unknown non-OpenAI usage is reported by the hook, but does not
          // retain an OpenAI reservation; billingUnknown is OpenAI-only.
        },
      });

      revertLossyRewrites(parsedBody, result);
      revertNonAmountWordingDrift(parsedBody, result);

      const correctedSteps = mapCorrectedSteps(parsedBody, result);
      if (!correctedSteps) {
        await finalize("failed", result);
        return jsonResponse(deps, cors, 502, {
          error: "Provider Error",
          message: "AI correction changed the recipe step count.",
        });
      }

      await finalize("succeeded", result);

      if (parsedBody.consent_to_diagnostics) {
        deps.logDiagnostic({
          invocationId,
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
      await finalize("failed");
      return jsonResponse(deps, cors, 502, {
        error: "Provider Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
