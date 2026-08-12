import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import type { RecipeDraftLabAccessResult } from "../_shared/recipe-draft-lab-access.ts";
import {
  type BrewingMethodOption,
  type LlmProviderName,
  type ParseUserRecipeDraftRequest,
  parseUserRecipeDraftRequestSchema,
  type ParseUserRecipeDraftResponse,
  type ProviderTrailEntry,
  type RecipeDraftParser,
  type StageOutputs,
} from "./parser.ts";

const OPENAI_DAILY_TOKEN_BUDGET = 10_000_000;

// Every stage key must always be present on a capture row even when a stage
// never ran (e.g. cumulative_rewrite skipped, or repair never triggered) —
// this is the fallback used only if parseDraft somehow returned
// stage_outputs: null while capture_stages was true, which should not
// happen but keeps the capture insert well-typed either way.
const EMPTY_STAGE_OUTPUTS: StageOutputs = {
  extraction: [],
  normalization: [],
  repair: [],
  cumulative_rewrite: [],
};

type AuthenticatedUser = {
  id: string;
};

export type ParseUserRecipeDraftHandlerDeps = {
  parser: RecipeDraftParser;
  getUserFromToken(token: string): Promise<AuthenticatedUser | null>;
  getRecipeDraftLabAccess(userId: string): Promise<RecipeDraftLabAccessResult>;
  getBrewingMethods(): Promise<BrewingMethodOption[]>;
  getOpenAiDailyTokensUsed(): Promise<number>;
  logInvocation(data: {
    userId: string;
    tokensUsed: number;
    openaiTokensUsed: number;
    providerUsed: string;
    providerModelUsed: string;
  }): Promise<void>;
  // Opt-in per-stage diagnostic capture (capture_stages: true on the
  // request). Unlike logInvocation this is AWAITED — the response carries
  // the new row's id as capture_id — but a throw here must never cost the
  // caller a successful parse; see the try/catch around its call below.
  captureStages(data: {
    userId: string;
    requestText: string;
    requestMode: string;
    requestBrewingMethodId: string | null;
    requestSourceLanguageHint: string | null;
    providerUsed: string | null;
    providerModelUsed: string | null;
    providerTrail: ProviderTrailEntry[] | null;
    stageOutputs: StageOutputs;
    response: Record<string, unknown>;
  }): Promise<string>;
  getCorsHeaders(origin?: string): Record<string, string>;
  createResponse(
    body: string,
    init: ResponseInit & { headers?: Record<string, string> },
  ): Response;
};

function jsonResponse(
  deps: ParseUserRecipeDraftHandlerDeps,
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
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

export function createParseUserRecipeDraftHandler(
  deps: ParseUserRecipeDraftHandlerDeps,
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

    const access = await deps.getRecipeDraftLabAccess(user.id);
    if (!access.allowed) {
      return jsonResponse(deps, cors, 403, {
        error: "Forbidden",
        message:
          "Only authorized recipe draft lab users may parse recipe drafts.",
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

    let parsedBody: ParseUserRecipeDraftRequest;
    try {
      parsedBody = parseUserRecipeDraftRequestSchema.parse(body);
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
        parsedBody.brewing_method_id &&
        !brewingMethods.some((method) =>
          method.brewing_method_id === parsedBody.brewing_method_id
        )
      ) {
        return jsonResponse(deps, cors, 400, {
          error: "Bad Request",
          message:
            `Unknown brewing_method_id '${parsedBody.brewing_method_id}'.`,
        });
      }

      const disabledProviders: LlmProviderName[] =
        openAiDailyTokens >= OPENAI_DAILY_TOKEN_BUDGET ? ["openai"] : [];
      const requestId = crypto.randomUUID();

      const result: ParseUserRecipeDraftResponse = await deps.parser.parseDraft(
        {
          text: parsedBody.text,
          userId: user.id,
          brewingMethods,
          brewingMethodHint: parsedBody.brewing_method_id,
          sourceLanguageHint: parsedBody.source_language_hint,
          requestId,
          disabledProviders,
          mode: parsedBody.mode,
          captureStages: parsedBody.capture_stages,
        },
      );

      deps.logInvocation({
        userId: user.id,
        tokensUsed: result.tokens_used,
        openaiTokensUsed: result.openai_tokens_used,
        providerUsed: result.provider_used,
        providerModelUsed: result.provider_model_used,
      }).catch(() => {});

      // stage_outputs is internal-only (see its comment on
      // ParseUserRecipeDraftResponse) — it is used below to build the
      // capture row and then MUST NOT reach the HTTP response body, only
      // capture_id does. Destructuring it out here, rather than deleting it
      // from `result` in place, keeps that guarantee independent of
      // whichever fields get added to the response object next.
      const { stage_outputs, ...publicResult } = result;

      let captureId: string | null = null;
      if (parsedBody.capture_stages) {
        try {
          captureId = await deps.captureStages({
            userId: user.id,
            requestText: parsedBody.text,
            requestMode: parsedBody.mode ?? "extract",
            requestBrewingMethodId: parsedBody.brewing_method_id ?? null,
            requestSourceLanguageHint: parsedBody.source_language_hint ??
              null,
            providerUsed: result.provider_used,
            providerModelUsed: result.provider_model_used,
            providerTrail: result.provider_trail ?? null,
            stageOutputs: stage_outputs ?? EMPTY_STAGE_OUTPUTS,
            response: publicResult,
          });
        } catch (error) {
          // A capture failure must never cost the user a successful parse:
          // log it, fall back to capture_id: null, and still return 200
          // with the parse result below.
          console.error(
            `[parse-user-recipe-draft] capture_failed requestId=${requestId} error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          captureId = null;
        }
      }

      return jsonResponse(deps, cors, 200, {
        ...publicResult,
        capture_id: captureId,
      });
    } catch (error) {
      return jsonResponse(deps, cors, 502, {
        error: "Provider Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
