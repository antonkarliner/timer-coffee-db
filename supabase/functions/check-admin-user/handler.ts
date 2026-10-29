import {
  CONNECTED_APP_FORBIDDEN_ERROR,
  CONNECTED_APP_FORBIDDEN_MESSAGE,
  isConnectedAppToken,
} from "../_shared/connected-app.ts";

type AuthenticatedUser = {
  id: string;
};

export type CheckAdminUserHandlerDeps = {
  /** Verifies the token with Supabase Auth; null when it is invalid or expired. */
  getUserFromToken(token: string): Promise<AuthenticatedUser | null>;
  /** True when service.admin_users has a non-null role for the user. Throws on query errors. */
  isAdminUser(userId: string): Promise<boolean>;
  corsHeaders: Record<string, string>;
};

function jsonResponse(
  deps: CheckAdminUserHandlerDeps,
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...deps.corsHeaders, "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string | null {
  const authorization = req.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return token ? token : null;
}

/**
 * Answers whether the caller is an admin: `{ role: "admin" | null }`.
 *
 * The caller must send their own access token, and `userId` (kept in the body
 * for existing callers) must be the id that token belongs to. Without this,
 * anyone with the anon key could ask about any user. Connected-app (OAuth)
 * tokens are refused: admin tools are never available to connected apps.
 */
export function createCheckAdminUserHandler(deps: CheckAdminUserHandlerDeps) {
  return async function handleRequest(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: deps.corsHeaders });
    }

    if (req.method !== "POST") {
      return jsonResponse(deps, 405, { error: "Method not allowed" });
    }

    const token = getBearerToken(req);
    if (!token) {
      return jsonResponse(deps, 401, { error: "Bearer token required" });
    }

    let body: { userId?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse(deps, 400, { error: "Invalid JSON body" });
    }

    const userId = body.userId;
    if (!userId || typeof userId !== "string") {
      return jsonResponse(deps, 400, { error: "Missing or invalid userId" });
    }

    try {
      const user = await deps.getUserFromToken(token);
      if (!user) {
        return jsonResponse(deps, 401, { error: "Invalid or expired token" });
      }

      if (isConnectedAppToken(token)) {
        return jsonResponse(deps, 403, {
          error: CONNECTED_APP_FORBIDDEN_ERROR,
          message: CONNECTED_APP_FORBIDDEN_MESSAGE,
        });
      }

      if (user.id !== userId) {
        return jsonResponse(deps, 403, {
          error: "userId must match the authenticated user",
        });
      }

      const isAdmin = await deps.isAdminUser(user.id);
      return jsonResponse(deps, 200, { role: isAdmin ? "admin" : null });
    } catch {
      return jsonResponse(deps, 500, { error: "Internal server error" });
    }
  };
}
