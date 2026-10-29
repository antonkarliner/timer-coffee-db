import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { extractBearerToken } from "./caller-auth.ts";
import { isConnectedAppToken } from "./connected-app.ts";
import { authorizeServiceRequest } from "./service-role-auth.ts";

export type PrivilegedCaller =
  | { ok: true; kind: "service" }
  | { ok: true; kind: "admin"; userId: string }
  | { ok: false; status: 401 | 403 | 500; error: string };

type AdminAuthDeps = {
  serviceRoleKey: string;
  getUser(token: string): Promise<{ id: string } | null>;
  getAdminRole(
    userId: string,
  ): Promise<{ role: string | null } | { error: string }>;
};

export async function authorizeAdminOrService(
  req: Request,
  deps: AdminAuthDeps,
): Promise<PrivilegedCaller> {
  const service = authorizeServiceRequest(req, deps.serviceRoleKey);
  if (service.authorized) return { ok: true, kind: "service" };
  if (service.status === 500) {
    return { ok: false, status: service.status, error: service.error };
  }

  const token = extractBearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Bearer token required" };
  let user;
  try {
    user = await deps.getUser(token);
  } catch {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }
  if (!user) {
    return { ok: false, status: 401, error: "Invalid or expired token" };
  }
  if (isConnectedAppToken(token)) {
    return {
      ok: false,
      status: 403,
      error: "Connected apps can't use this function",
    };
  }

  let admin;
  try {
    admin = await deps.getAdminRole(user.id);
  } catch {
    return { ok: false, status: 500, error: "Admin check failed" };
  }
  if ("error" in admin) {
    return { ok: false, status: 500, error: "Admin check failed" };
  }
  if (admin.role !== "admin") {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, kind: "admin", userId: user.id };
}

export function createAdminAuthDeps(
  supabaseAdmin: SupabaseClient,
  serviceRoleKey: string,
): AdminAuthDeps {
  return {
    serviceRoleKey,
    async getUser(token) {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id };
    },
    async getAdminRole(userId) {
      const { data, error } = await supabaseAdmin
        .schema("service")
        .from("admin_users")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      return error ? { error: error.message } : { role: data?.role ?? null };
    },
  };
}
