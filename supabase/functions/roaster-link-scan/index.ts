// roaster-link-scan: daily Google Web Risk re-check of roaster page links.
// Invoked only by pg_cron (public.roaster_link_scan_cron, see
// 20261029120000_roaster_link_scan_cron.sql). Thin wiring; the logic and its
// failure policy live in handler.ts.

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
import { createWebRiskClient } from "../_shared/web-risk.ts";
import {
  authorizeSchedulerRequest,
  createRoasterLinkScanHandler,
  type ScanPage,
} from "./handler.ts";

const FUNCTION_NAME = "roaster-link-scan";
const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Optional, as in export-user-data: the new-style key the cron wrapper sends
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

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseBatch(data: unknown): ScanPage[] {
  if (!Array.isArray(data)) return [];
  const pages: ScanPage[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.roaster_profile_id !== "string") continue;
    pages.push({
      roaster_profile_id: r.roaster_profile_id,
      website_url: asNullableString(r.website_url),
      description: asNullableString(r.description),
      admin_user_id: asNullableString(r.admin_user_id),
    });
  }
  return pages;
}

const handler = createRoasterLinkScanHandler({
  authorize: (req) =>
    authorizeSchedulerRequest(req, serviceRoleKey, edgeFunctionsApiKey),
  getWebRiskApiKey: () => Deno.env.get("GOOGLE_WEB_RISK_API_KEY"),
  createLookUp(apiKey) {
    const client = createWebRiskClient({ apiKey });
    return (uri) => client.lookUp(uri);
  },
  async fetchBatch(limit) {
    const { data, error } = await supabase.schema("service").rpc(
      "roaster_link_scan_batch",
      { p_limit: limit },
    );
    if (error) throw new Error(error.message);
    return parseBatch(data);
  },
  async quarantineLink({ roasterProfileId, field, url, threatTypes }) {
    const { data, error } = await supabase.schema("service").rpc(
      "quarantine_roaster_link",
      {
        p_roaster_profile_id: roasterProfileId,
        p_field: field,
        p_url: url,
        p_threat_types: threatTypes,
      },
    );
    if (error) throw new Error(error.message);
    return typeof data === "string" ? data : null;
  },
  async markChecked(ids) {
    const { error } = await supabase.schema("service").rpc(
      "mark_roaster_links_checked",
      { p_roaster_profile_ids: ids },
    );
    if (error) throw new Error(error.message);
  },
  async getRoasterPages(ids) {
    const { data, error } = await supabase
      .from("roaster_profiles")
      .select("id, slug, roaster_name")
      .in("id", ids);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      id: String(row.id),
      slug: asNullableString(row.slug),
      roaster_name: asNullableString(row.roaster_name),
    }));
  },
  async getUserEmail(userId) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) throw new Error(error.message);
    return data.user?.email ?? null;
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
