// global-stats-insert-watchdog: pg_cron check (every 30 minutes) that brews
// still reach public.global_stats. Invoked only by pg_cron
// (public.global_stats_insert_watchdog_cron, see
// 20261109130000_global_stats_insert_watchdog_cron.sql). Thin wiring; the
// logic and its failure policy live in handler.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { fetchWithTimeout } from "../_shared/fetch-with-timeout.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  flushLogsOnExit,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  authorizeSchedulerRequest,
  createGlobalStatsInsertWatchdogHandler,
} from "./handler.ts";

const FUNCTION_NAME = "global-stats-insert-watchdog";
const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Optional, as in roaster-link-scan: the new-style key the cron wrapper sends
// in the `apikey` header once `edge_functions_api_key` is provisioned in
// Vault. Until then the wrapper falls back to the service-role bearer.
const edgeFunctionsApiKey = Deno.env.get("EDGE_FUNCTIONS_API_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const adminEmail = Deno.env.get("ADMIN_EMAIL") ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const handler = createGlobalStatsInsertWatchdogHandler({
  authorize: (req) =>
    authorizeSchedulerRequest(req, serviceRoleKey, edgeFunctionsApiKey),
  // The lte bound matters: authenticated clients can set created_at, so one
  // future-dated row must not blind the watchdog.
  async getLatestInsertAt(nowIso) {
    const { data, error } = await supabase
      .from("global_stats")
      .select("created_at")
      .lte("created_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? data : [];
    const first = rows[0] as { created_at?: unknown } | undefined;
    return typeof first?.created_at === "string" ? first.created_at : null;
  },
  async sendEmail(message) {
    if (!resendApiKey) throw new Error("RESEND_API_KEY is not configured");
    const response = await fetchWithTimeout(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify(message),
    }, RESEND_TIMEOUT_MS);
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`Resend responded with HTTP ${response.status}`);
    }
  },
  adminEmail: adminEmail || undefined,
  getCorsHeaders,
  createResponse: (body, init) => createSecureResponse(body, init),
  logger: {
    info: (message, details) =>
      logInfo(`[${FUNCTION_NAME}] ${message}`, details),
    warn: (message, details) =>
      logWarning(`[${FUNCTION_NAME}] ${message}`, details),
    error: (message, details) =>
      logError(
        `[${FUNCTION_NAME}] ${message}`,
        undefined,
        ErrorCategory.EXTERNAL_API,
        ErrorSeverity.MEDIUM,
        details,
      ),
  },
});

Deno.serve(async (req) => {
  try {
    return await handler(req);
  } finally {
    flushLogsOnExit();
  }
});
