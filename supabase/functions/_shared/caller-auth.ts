import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";

export function extractBearerToken(req: Request): string | null {
  const authorization = req.headers.get("Authorization") ??
    req.headers.get("authorization");
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export async function resolveCaller(
  req: Request,
  supabaseAdmin: SupabaseClient,
): Promise<
  | { ok: true; user: { id: string; isAnonymous: boolean } }
  | { ok: false; status: 401; error: string }
> {
  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: "Bearer token required" };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }

  return {
    ok: true,
    user: {
      id: data.user.id,
      isAnonymous: data.user.is_anonymous === true,
    },
  };
}
