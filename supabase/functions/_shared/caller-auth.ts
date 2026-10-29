import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { isConnectedAppToken } from "./connected-app.ts";

export function extractBearerToken(req: Request): string | null {
  const authorization = req.headers.get("Authorization") ??
    req.headers.get("authorization");
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export type ResolveCallerOptions = {
  // Connected-app (OAuth client) tokens are refused unless the function is
  // meant to serve agents.
  allowConnectedApps?: boolean;
};

export async function resolveCaller(
  req: Request,
  supabaseAdmin: SupabaseClient,
  options: ResolveCallerOptions = {},
): Promise<
  | { ok: true; user: { id: string; isAnonymous: boolean } }
  | { ok: false; status: 401 | 403; error: string }
> {
  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: "Bearer token required" };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }
  if (!options.allowConnectedApps && isConnectedAppToken(token)) {
    return {
      ok: false,
      status: 403,
      error: "Connected apps can't use this function",
    };
  }

  return {
    ok: true,
    user: {
      id: data.user.id,
      isAnonymous: data.user.is_anonymous === true,
    },
  };
}
