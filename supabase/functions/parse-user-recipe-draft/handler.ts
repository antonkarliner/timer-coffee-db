import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import type { RecipeDraftLabAccessResult } from "../_shared/recipe-draft-lab-access.ts";
import {
  type BrewingMethodOption,
  type LlmProviderName,
  type ParseUserRecipeDraftRequest,
  parseUserRecipeDraftRequestSchema,
  type ParseUserRecipeDraftResponse,
  type RecipeDraftParser,
} from "./parser.ts";

const OPENAI_DAILY_TOKEN_BUDGET = 10_000_000;

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

      const result: ParseUserRecipeDraftResponse = await deps.parser.parseDraft(
        {
          text: parsedBody.text,
          userId: user.id,
          brewingMethods,
          brewingMethodHint: parsedBody.brewing_method_id,
          sourceLanguageHint: parsedBody.source_language_hint,
          requestId: crypto.randomUUID(),
          disabledProviders,
        },
      );

      deps.logInvocation({
        userId: user.id,
        tokensUsed: result.tokens_used,
        openaiTokensUsed: result.openai_tokens_used,
        providerUsed: result.provider_used,
        providerModelUsed: result.provider_model_used,
      }).catch(() => {});

      return jsonResponse(deps, cors, 200, result);
    } catch (error) {
      return jsonResponse(deps, cors, 502, {
        error: "Provider Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
