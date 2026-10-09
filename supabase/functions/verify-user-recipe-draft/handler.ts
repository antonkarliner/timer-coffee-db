// Echo-only compatibility stub so released app versions keep working.
// plan 079 (timer-coffee-plans) — delete this function 6 weeks after the app
// release that removes the toggle, or when calls fall below 5/month.
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

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
  short_description: z.string().trim().max(1000).optional(),
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
  steps: z.array(stepSchema).min(1).max(50),
});

export type VerifyUserRecipeDraftRequest = z.infer<
  typeof verifyUserRecipeDraftRequestSchema
>;

export type VerifyUserRecipeDraftHandlerDeps = {
  getUserFromToken(token: string): Promise<AuthenticatedUser | null>;
  getCorsHeaders(origin?: string): Record<string, string>;
  createResponse(
    body: string,
    init: ResponseInit & { headers?: Record<string, string> },
  ): Response;
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

    // Validation guarantees this shape; use raw descriptions to preserve whitespace.
    const rawSteps = (body as { steps: Array<{ description: string }> }).steps;
    return jsonResponse(deps, cors, 200, {
      detected_input_language: null,
      provider_used: null,
      provider_model_used: null,
      tokens_used: 0,
      openai_tokens_used: 0,
      warnings: [],
      issues: [],
      corrected_steps: parsedBody.steps.map((step, index) => ({
        order: step.order,
        kind: step.kind,
        description_template: rawSteps[index].description,
        duration_seconds: step.duration_seconds,
      })),
    });
  };
}
