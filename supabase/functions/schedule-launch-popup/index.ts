import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getEnvVar } from "../_shared/env-validation.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  generateCorrelationId,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";
import { authorizeServiceRole } from "../_shared/service-role-auth.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";

function jsonResponse(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

serve(async (req) => {
  const requestId = generateCorrelationId();
  const cors = getCorsHeaders(req.headers.get("origin") || undefined);

  if (req.method === "OPTIONS") {
    return createSecureResponse("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  let supabaseUrl: string;
  let serviceRoleKey: string;
  try {
    supabaseUrl = getEnvVar("SUPABASE_URL");
    serviceRoleKey = getEnvVar("SUPABASE_SERVICE_ROLE_KEY");
  } catch {
    logError(
      "Schedule launch-popup environment validation failed",
      new Error("Required environment configuration is unavailable."),
      ErrorCategory.CONFIGURATION,
      ErrorSeverity.CRITICAL,
      { request_id: requestId, phase: "environment_validation" },
      requestId,
    );
    return jsonResponse(
      { error: "Service configuration is unavailable." },
      500,
      cors,
    );
  }

  const authorization = authorizeServiceRole(
    req.headers.get("authorization"),
    serviceRoleKey,
  );
  if (!authorization.authorized) {
    logWarning("Schedule launch-popup authorization rejected", {
      request_id: requestId,
      phase: "authorization",
      status: authorization.status,
    }, requestId);
    return jsonResponse(
      { error: authorization.error },
      authorization.status,
      cors,
    );
  }

  let body: {
    content?: string;
    locale?: string;
    platform?: string;
    publication_time?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, cors);
  }

  const { content, locale, platform, publication_time } = body;
  if (!content || !locale || !publication_time) {
    return jsonResponse({ error: "Missing required fields" }, 400, cors);
  }

  const runAt = new Date(publication_time);
  if (isNaN(runAt.valueOf())) {
    return jsonResponse({ error: "Invalid publication_time" }, 400, cors);
  }

  const platformValue = platform &&
      ["ios", "android", "web", "all", "internal_canary"].includes(platform)
    ? platform
    : "all";
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, detectSessionInUrl: false },
  });

  logInfo("Scheduling launch popup", {
    request_id: requestId,
    phase: "enqueue_popup",
    locale,
    platform: platformValue,
    publication_time: runAt.toISOString(),
  }, requestId);

  const { data, error } = await supabase.rpc("enqueue_popup", {
    _content: content,
    _locale: locale,
    _platform: platformValue,
    _run_at: runAt.toISOString(),
  });
  if (error) {
    logError(
      "Schedule launch-popup RPC failed",
      new Error("enqueue_popup RPC failed."),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      { request_id: requestId, phase: "enqueue_popup" },
      requestId,
    );
    return jsonResponse(
      {
        error: error.message,
        details: error.details,
      },
      500,
      cors,
    );
  }

  return jsonResponse({ success: true, msg_id: data }, 200, cors);
});
