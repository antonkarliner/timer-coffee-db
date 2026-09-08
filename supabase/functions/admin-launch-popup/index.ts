import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  generateCorrelationId,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const LOCALE_PATTERN = /^en(?:[-_].+)?$/i;
const PLATFORM_VALUES = ["ios", "android", "web", "all"] as const;
type PlatformValue = typeof PLATFORM_VALUES[number];

// Kept in step with MAX_TRANSLATION_TITLE_LENGTH in translate-openai: a title
// this function accepts must also survive the translation request's own
// validation, or the popup would be created and then fail to fan out.
const MAX_TITLE_LENGTH = 200;

type RequestBody = {
  content?: string;
  locale?: string;
  platform?: string;
  publication_time?: string;
  title?: string;
};

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

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

async function requireAdmin(
  req: Request,
  cors: Record<string, string>,
  requestId: string,
): Promise<Response | null> {
  const token = getBearerToken(req);
  if (!token) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }

  const { data: userData, error: authError } = await supabase.auth.getUser(
    token,
  );
  if (authError || !userData.user) {
    return jsonResponse(
      { error: "Unauthorized", message: authError?.message ?? "Invalid token" },
      401,
      cors,
    );
  }

  const { data: adminData, error: adminError } = await supabase
    .schema("service")
    .from("admin_users")
    .select("role")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (adminError) {
    logError(
      "Admin launch-popup admin lookup failed",
      new Error("admin_users lookup failed."),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      { request_id: requestId, phase: "admin_check" },
      requestId,
    );
    return jsonResponse(
      { error: "Admin check failed", message: adminError.message },
      500,
      cors,
    );
  }

  if (adminData?.role !== "admin") {
    logWarning("Admin launch-popup authorization rejected", {
      request_id: requestId,
      phase: "authorization",
      user_id: userData.user.id,
    }, requestId);
    return jsonResponse({ error: "Forbidden" }, 403, cors);
  }

  return null;
}

async function readJson(req: Request): Promise<RequestBody> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as RequestBody : {};
  } catch {
    return {};
  }
}

serve(async (req) => {
  const requestId = generateCorrelationId();
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);

  if (req.method === "OPTIONS") {
    return createSecureResponse("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, cors);
  }

  const authFailure = await requireAdmin(req, cors, requestId);
  if (authFailure) {
    return authFailure;
  }

  const body = await readJson(req);
  const { content, locale, platform, publication_time, title } = body;

  const trimmedContent = typeof content === "string" ? content.trim() : "";
  if (!trimmedContent) {
    return jsonResponse({ error: "Missing required fields" }, 400, cors);
  }

  // Source content is always English; any other locale is rejected rather than
  // stored, because the translation trigger fans out from the English row.
  const localeValue = "en";
  if (locale !== undefined && locale !== null && locale !== "") {
    if (!LOCALE_PATTERN.test(String(locale).trim())) {
      return jsonResponse(
        { error: "Launch popup source content must be written in English" },
        400,
        cors,
      );
    }
  }

  const platformValue: PlatformValue =
    platform && (PLATFORM_VALUES as readonly string[]).includes(platform)
      ? platform as PlatformValue
      : "all";

  // An optional per-popup dialog title (plan 054 Item C). An absent or blank
  // title must reach the column as SQL NULL, never as an empty string, because
  // the app renders `popup.title ?? l10n.whatsnewtitle` and an empty string
  // would satisfy that fallback and render a blank heading.
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if ([...trimmedTitle].length > MAX_TITLE_LENGTH) {
    return jsonResponse(
      { error: `Title must be at most ${MAX_TITLE_LENGTH} characters` },
      400,
      cors,
    );
  }
  const titleValue: string | null = trimmedTitle || null;

  let runAt: Date | null = null;
  if (publication_time !== undefined && publication_time !== null && publication_time !== "") {
    const parsed = new Date(publication_time);
    if (isNaN(parsed.valueOf())) {
      return jsonResponse({ error: "Invalid publication_time" }, 400, cors);
    }
    runAt = parsed;
  }

  if (runAt && runAt.getTime() > Date.now()) {
    logInfo("Scheduling launch popup", {
      request_id: requestId,
      phase: "enqueue_popup",
      locale: localeValue,
      platform: platformValue,
      publication_time: runAt.toISOString(),
    }, requestId);

    const { data, error } = await supabase.rpc("enqueue_popup", {
      _content: trimmedContent,
      _locale: "en",
      _platform: platformValue,
      _run_at: runAt.toISOString(),
      _title: titleValue,
    });

    if (error) {
      logError(
        "Admin launch-popup enqueue_popup RPC failed",
        new Error("enqueue_popup RPC failed."),
        ErrorCategory.DATABASE,
        ErrorSeverity.HIGH,
        { request_id: requestId, phase: "enqueue_popup" },
        requestId,
      );
      return jsonResponse(
        { error: error.message, details: error.details },
        500,
        cors,
      );
    }

    return jsonResponse(
      { success: true, scheduled: true, msg_id: data },
      200,
      cors,
    );
  }

  logInfo("Creating immediate launch popup", {
    request_id: requestId,
    phase: "insert_popup",
    locale: localeValue,
    platform: platformValue,
  }, requestId);

  const { data: row, error } = await supabase
    .from("launch_popup")
    .insert({
      content: trimmedContent,
      locale: "en",
      platform: platformValue,
      title: titleValue,
    })
    .select("id")
    .single();

  if (error || !row) {
    logError(
      "Admin launch-popup insert failed",
      new Error("launch_popup insert failed."),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      { request_id: requestId, phase: "insert_popup" },
      requestId,
    );
    return jsonResponse(
      { error: error?.message ?? "Failed to create source popup" },
      500,
      cors,
    );
  }

  return jsonResponse(
    {
      success: true,
      scheduled: false,
      sourcePopupId: row.id,
      translationsQueued: true,
    },
    200,
    cors,
  );
});
