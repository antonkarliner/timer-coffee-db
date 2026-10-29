import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { validateAudienceFilter } from "../_shared/audience-filter.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  CONNECTED_APP_FORBIDDEN_ERROR,
  CONNECTED_APP_FORBIDDEN_MESSAGE,
  isConnectedAppToken,
} from "../_shared/connected-app.ts";
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
  audience_filter?: unknown;
  visible_from?: string | null;
  hook_type?: string | null;
  campaign_ends_at?: string | null;
  goal_amount_usd?: number | null;
  progress_amount_usd?: number | null;
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
  if (isConnectedAppToken(token)) {
    return jsonResponse(
      {
        error: CONNECTED_APP_FORBIDDEN_ERROR,
        message: CONNECTED_APP_FORBIDDEN_MESSAGE,
      },
      403,
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

  const audience = validateAudienceFilter(body.audience_filter);
  if (!audience.ok) {
    return jsonResponse({ error: audience.error }, 400, cors);
  }

  // visible_from takes precedence; publication_time remains a compatibility alias.
  const visibilityInput = body.visible_from ?? publication_time;
  const timestamps: Record<string, string | null> = {};
  for (const [field, input] of Object.entries({
    visible_from: visibilityInput,
    campaign_ends_at: body.campaign_ends_at,
  })) {
    if (input === undefined || input === null || input === "") {
      timestamps[field] = null;
      continue;
    }
    // Require a timezone-bearing ISO datetime, rather than Date's loose parser.
    if (
      typeof input !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input) ||
      !Number.isFinite(Date.parse(input)) ||
      new Date(`${input.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
        input.slice(0, 10)
    ) {
      return jsonResponse({ error: `Invalid ${field}` }, 400, cors);
    }
    timestamps[field] = new Date(input).toISOString();
  }

  const hookTypes = [
    "license_renewal", "coffee_day", "black_friday", "feature_object", "yearly_recap",
  ];
  if (body.hook_type != null && !hookTypes.includes(body.hook_type)) {
    return jsonResponse({ error: "Invalid hook_type" }, 400, cors);
  }
  for (const field of ["goal_amount_usd", "progress_amount_usd"] as const) {
    if (body[field] != null &&
      (typeof body[field] !== "number" || !Number.isFinite(body[field]))) {
      return jsonResponse({ error: `Invalid ${field}` }, 400, cors);
    }
  }
  const scheduled = timestamps.visible_from !== null &&
    Date.parse(timestamps.visible_from) > Date.now();
  logInfo("Creating launch popup", {
    request_id: requestId,
    phase: "insert_popup",
    locale: localeValue,
    platform: platformValue,
    visible_from: timestamps.visible_from,
  }, requestId);

  const { data: row, error } = await supabase
    .from("launch_popup")
    .insert({
      content: trimmedContent,
      locale: "en",
      platform: platformValue,
      title: titleValue,
      audience_filter: audience.value,
      visible_from: timestamps.visible_from,
      hook_type: body.hook_type ?? null,
      campaign_ends_at: timestamps.campaign_ends_at,
      goal_amount_usd: body.goal_amount_usd ?? null,
      progress_amount_usd: body.progress_amount_usd ?? null,
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
      scheduled,
      sourcePopupId: row.id,
      translationsQueued: true,
    },
    200,
    cors,
  );
});
