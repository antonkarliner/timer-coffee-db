import {
  CONNECTED_APP_FORBIDDEN_ERROR,
  CONNECTED_APP_FORBIDDEN_MESSAGE,
  isConnectedAppToken,
} from "../_shared/connected-app.ts";
import type { RecipeDraftLabAccessResult } from "../_shared/recipe-draft-lab-access.ts";

type AuthenticatedUser = {
  id: string;
};

export type CheckRecipeDraftLabAccessHandlerDeps = {
  getUserFromToken(token: string): Promise<AuthenticatedUser | null>;
  getRecipeDraftLabAccess(userId: string): Promise<RecipeDraftLabAccessResult>;
  getCorsHeaders(origin?: string): Record<string, string>;
  createResponse(
    body: string,
    init: ResponseInit & { headers?: Record<string, string> },
  ): Response;
};

function jsonResponse(
  deps: CheckRecipeDraftLabAccessHandlerDeps,
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

export function createCheckRecipeDraftLabAccessHandler(
  deps: CheckRecipeDraftLabAccessHandlerDeps,
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
        allowed: false,
        error: "Unauthorized",
        message: "Missing or invalid Authorization header.",
      });
    }

    const user = await deps.getUserFromToken(token);
    if (!user) {
      return jsonResponse(deps, cors, 401, {
        allowed: false,
        error: "Unauthorized",
        message: "Could not resolve the authenticated user.",
      });
    }

    if (isConnectedAppToken(token)) {
      return jsonResponse(deps, cors, 403, {
        allowed: false,
        error: CONNECTED_APP_FORBIDDEN_ERROR,
        message: CONNECTED_APP_FORBIDDEN_MESSAGE,
      });
    }

    const access = await deps.getRecipeDraftLabAccess(user.id);
    if (!access.allowed) {
      return jsonResponse(deps, cors, 403, {
        allowed: false,
        error: "Forbidden",
        message: "Recipe Draft Lab access is not enabled for this account.",
      });
    }

    return jsonResponse(deps, cors, 200, access);
  };
}
