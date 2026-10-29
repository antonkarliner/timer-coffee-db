import {
  CONNECTED_APP_FORBIDDEN_ERROR,
  CONNECTED_APP_FORBIDDEN_MESSAGE,
  isConnectedAppToken,
} from "../_shared/connected-app.ts";

type AuthenticatedUser = {
  id: string;
};

type RecipeDraftLabTesterRow = {
  user_id: string;
  role: "tester";
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
  email: string | null;
};

export type ManageRecipeDraftLabAccessHandlerDeps = {
  getUserFromToken(token: string): Promise<AuthenticatedUser | null>;
  isServiceAdmin(userId: string): Promise<boolean>;
  listTesters(): Promise<RecipeDraftLabTesterRow[]>;
  grantTesterAccess(args: {
    identifier: string;
    expiresAt: string | null;
    createdBy: string;
  }): Promise<RecipeDraftLabTesterRow | null>;
  updateTesterAccess(args: {
    userId: string;
    isActive?: boolean;
    expiresAt?: string | null;
  }): Promise<RecipeDraftLabTesterRow | null>;
  deleteTesterAccess(userId: string): Promise<boolean>;
  getTokenStats(
    userIds: string[],
  ): Promise<Record<string, { tokens_used: number; openai_tokens_used: number }>>;
  getCorsHeaders(origin?: string): Record<string, string>;
  createResponse(
    body: string,
    init: ResponseInit & { headers?: Record<string, string> },
  ): Response;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(
  deps: ManageRecipeDraftLabAccessHandlerDeps,
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

function parseExpiresAt(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("expires_at must be an ISO timestamp or null");
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("expires_at must be a valid timestamp");
  }

  return date.toISOString();
}

function parseBodyField(body: unknown, field: string) {
  if (!body || typeof body !== "object" || !(field in body)) {
    return undefined;
  }

  return (body as Record<string, unknown>)[field];
}

export function createManageRecipeDraftLabAccessHandler(
  deps: ManageRecipeDraftLabAccessHandlerDeps,
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

    if (isConnectedAppToken(token)) {
      return jsonResponse(deps, cors, 403, {
        error: CONNECTED_APP_FORBIDDEN_ERROR,
        message: CONNECTED_APP_FORBIDDEN_MESSAGE,
      });
    }

    let isServiceAdmin: boolean;
    try {
      isServiceAdmin = await deps.isServiceAdmin(user.id);
    } catch (error) {
      return jsonResponse(deps, cors, 500, {
        error: "Admin check failed",
        message: error instanceof Error
          ? error.message
          : "Unable to verify admin access.",
      });
    }

    if (!isServiceAdmin) {
      return jsonResponse(deps, cors, 403, {
        error: "Forbidden",
        message: "Only full service admins can manage lab testers.",
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(deps, cors, 400, {
        error: "Invalid JSON body",
      });
    }

    const action = parseBodyField(body, "action");

    try {
      if (action === "list") {
        const testers = await deps.listTesters();
        const tokenStats = await deps.getTokenStats(
          testers.map((t) => t.user_id),
        );
        return jsonResponse(deps, cors, 200, {
          users: testers.map((t) => ({
            ...t,
            tokens_used: tokenStats[t.user_id]?.tokens_used ?? 0,
            openai_tokens_used: tokenStats[t.user_id]?.openai_tokens_used ?? 0,
          })),
        });
      }

      if (action === "grant") {
        const identifier = parseBodyField(body, "identifier");
        if (typeof identifier !== "string" || !identifier.trim()) {
          return jsonResponse(deps, cors, 400, {
            message: "Email address or auth user ID is required",
          });
        }

        const tester = await deps.grantTesterAccess({
          identifier: identifier.trim(),
          expiresAt: parseExpiresAt(parseBodyField(body, "expires_at")),
          createdBy: user.id,
        });

        if (!tester) {
          return jsonResponse(deps, cors, 404, {
            message: "Supabase Auth user was not found",
          });
        }

        return jsonResponse(deps, cors, 200, {
          user: tester,
        });
      }

      if (action === "update") {
        const userId = parseBodyField(body, "user_id");
        if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
          return jsonResponse(deps, cors, 400, {
            message: "Valid user_id is required",
          });
        }

        const updates: {
          userId: string;
          isActive?: boolean;
          expiresAt?: string | null;
        } = {
          userId,
        };
        const isActive = parseBodyField(body, "is_active");

        if (typeof isActive === "boolean") {
          updates.isActive = isActive;
        }

        if (
          body && typeof body === "object" &&
          Object.hasOwn(body, "expires_at")
        ) {
          updates.expiresAt = parseExpiresAt(
            parseBodyField(body, "expires_at"),
          );
        }

        if (
          updates.isActive === undefined && updates.expiresAt === undefined
        ) {
          return jsonResponse(deps, cors, 400, {
            message: "No updates provided",
          });
        }

        const tester = await deps.updateTesterAccess(updates);
        if (!tester) {
          return jsonResponse(deps, cors, 404, {
            message: "Tester access row was not found",
          });
        }

        return jsonResponse(deps, cors, 200, {
          user: tester,
        });
      }

      if (action === "delete") {
        const userId = parseBodyField(body, "user_id");
        if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
          return jsonResponse(deps, cors, 400, {
            message: "Valid user_id is required",
          });
        }

        const deleted = await deps.deleteTesterAccess(userId);
        if (!deleted) {
          return jsonResponse(deps, cors, 404, {
            message: "Tester access row was not found",
          });
        }

        return jsonResponse(deps, cors, 200, {
          success: true,
          user_id: userId,
        });
      }
    } catch (error) {
      return jsonResponse(deps, cors, 400, {
        message: error instanceof Error ? error.message : "Invalid request",
      });
    }

    return jsonResponse(deps, cors, 400, {
      message: "Unknown Recipe Draft Lab access action",
    });
  };
}
