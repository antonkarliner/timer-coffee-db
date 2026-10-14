// deno-lint-ignore no-import-prefix -- Match the pinned client used by existing shared utilities.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../cors.ts";
import { validateEnvironment } from "../env-validation.ts";
import { createSecureResponse } from "../security-headers.ts";
import { authorizeServiceRole } from "../service-role-auth.ts";
import { CollectionError, type Store } from "./model.ts";

// Follow shared validation conventions. Each collector also enforces its own
// required variables before use; the shared CORS module retains its existing
// project-wide environment requirements.
validateEnvironment();

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value?.trim()) throw new CollectionError("missing_configuration");
  return value;
}
export function database() {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req.headers.get("Origin") ?? undefined),
      "Content-Type": "application/json",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-system-token",
    },
  }, extra);
}
export function collectorGate(req: Request): Response | null {
  if (req.method === "OPTIONS") return jsonResponse(req, {});
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "method_not_allowed" }, 405, {
      Allow: "POST, OPTIONS",
    });
  }
  const cronSecret = Deno.env.get("CRON_JOB_SECRET");
  const systemToken = req.headers.get("X-System-Token");
  if (
    cronSecret && systemToken &&
    authorizeServiceRole(`Bearer ${systemToken}`, cronSecret).authorized
  ) return null;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (
    serviceKey &&
    authorizeServiceRole(req.headers.get("Authorization"), serviceKey)
      .authorized
  ) return null;
  return jsonResponse(req, { error: "unauthorized" }, 401);
}
export async function claimRun(
  store: Store,
  appId: string,
  countries: readonly string[],
) {
  const db = database();
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await db.schema("service").rpc(
    "claim_store_ratings_run",
    {
      p_store: store,
      p_date: date,
      p_app_id: appId,
      p_countries: [...countries],
    },
  );
  if (error) throw new CollectionError("database_claim_failed");
  return {
    db,
    date,
    lease: data as {
      status: string;
      lease_token?: string;
      countries?: string[];
    },
  };
}
