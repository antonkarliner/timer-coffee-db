import { localScheduleError, defaultLocalScheduleAt } from "../_shared/local-time-schedule.ts";
import { validateAudienceFilter } from "../_shared/audience-filter.ts";
import { canManageScheduledRecipient } from "../_shared/scheduled-notification-policy.ts";
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { CONNECTED_APP_FORBIDDEN_ERROR, CONNECTED_APP_FORBIDDEN_MESSAGE, isConnectedAppToken } from "../_shared/connected-app.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { checkUserRateLimit, createRateLimitResponse } from "../_shared/rate-limiter.ts";
import { validateAndLogEnvironment, ENVIRONMENT_CONFIG } from "../_shared/env-validation.ts";
import { sendBroadcast, mapPlatformToTargetDeviceTypes } from "../_shared/broadcast-notification.ts";
import { translateNotificationBatch } from "../_shared/translation-service.ts";
import { monitoring, generateCorrelationId, createPerformanceTracker, completePerformanceTracking, logApiRequest, logApiResponse, logError, logInfo, logWarning, ErrorCategory, ErrorSeverity, getSystemHealth } from "../_shared/monitoring.ts";
// Error normalizer function to handle unknown objects
function normalizeError(error) {
  if (error instanceof Error) return error;
  try {
    return new Error(typeof error === "string" ? error : JSON.stringify(error));
  } catch  {
    return new Error(String(error));
  }
}
// Console verbose error logging helper function
function logVerboseError(operation, error, context) {
  const errorDetails = {
    operation,
    timestamp: new Date().toISOString(),
    message: error.message,
    stack: error.stack,
    context: {
      userId: context.userId,
      correlationId: context.correlationId,
      functionName: context.functionName,
      parameters: context.parameters,
      databaseQuery: context.databaseQuery,
      lineNumber: context.lineNumber,
      additionalContext: context.additionalContext
    }
  };
  console.error(`[VERBOSE ERROR] ${operation}:`, errorDetails);
}
// Console debug logging helper function
function logVerboseDebug(operation, context) {
  const debugDetails = {
    operation,
    timestamp: new Date().toISOString(),
    context: {
      userId: context.userId,
      correlationId: context.correlationId,
      functionName: context.functionName,
      parameters: context.parameters,
      data: context.data
    }
  };
  console.debug(`[DEBUG] ${operation}:`, debugDetails);
}
function validateNotificationUrl(url, linkType) {
  if (typeof url !== "string") {
    return null;
  }
  if (linkType === "internal") {
    return url.startsWith("/") ? url : null;
  }
  try {
    const parsedUrl = new URL(url);
    // Only allow http and https for external URLs
    if ([
      "http:",
      "https:"
    ].includes(parsedUrl.protocol)) {
      if (!parsedUrl.host) {
        return null;
      }
      return linkType === "external" || !linkType ? url : null;
    }
    // Allow app deep link schemes
    if ([
      "timercoffee:",
      "app:"
    ].includes(parsedUrl.protocol)) {
      return linkType === "app_deep_link" || !linkType ? url : null;
    }
    // Unknown protocol - reject
    return null;
  } catch (_error) {
    // Not a valid URL - might be an internal route
    if (url.startsWith("/")) {
      return !linkType ? url : null;
    }
    return null;
  }
}
// Validate environment variables
validateAndLogEnvironment();
const supabaseUrl = ENVIRONMENT_CONFIG.supabaseUrl;
const serviceRoleKey = ENVIRONMENT_CONFIG.supabaseServiceRoleKey;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured");
}
const sendFunctionUrl = `${supabaseUrl}/functions/v1/send-fcm-notification`;
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false
  },
  db: {
    schema: "service"
  }
});
serve(async (req)=>{
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors
    });
  }
  const url = new URL(req.url);
  // Handle multiple base path formats for flexible deployment
  const rawPath = url.pathname.replace(/\/$/, '');
  const candidateBases = [
    '/functions/v1/notification-api',
    '/notification-api'
  ];
  let pathname = rawPath;
  for (const base of candidateBases){
    if (pathname.startsWith(base)) {
      pathname = pathname.slice(base.length) || '/';
      break;
    }
  }
  pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  pathname = pathname.replace(/\/+$/, '') || '/';
  // DEBUG LOGGING
  console.log(`[EDGE DEBUG] Raw pathname: ${url.pathname}`);
  console.log(`[EDGE DEBUG] Candidate bases: ${candidateBases.join(', ')}`);
  console.log(`[EDGE DEBUG] Final pathname: ${pathname}`);
  console.log(`[EDGE DEBUG] Method: ${req.method}`);
  console.log(`[EDGE DEBUG] Full URL: ${req.url}`);
  // Generate correlation ID for request tracing
  const correlationId = generateCorrelationId();
  // Create performance tracker
  const performanceTracker = createPerformanceTracker('notification-api', 'main_handler', correlationId);
  // Log API request start
  const requestId = logApiRequest(req, undefined, correlationId);
  try {
    // Health Check Endpoint (public, no auth required)
    if (pathname === "/health" && req.method === "GET") {
      return await healthCheck(cors, correlationId);
    }
    // Apply authentication and rate limiting for all other endpoints
    const authContext = await getAuthContext(req.headers.get("authorization"));
    const { method } = req;
    if (authContext.connectedApp) {
      completePerformanceTracking(performanceTracker, req, 403);
      logApiResponse(requestId, 403, Date.now() - performanceTracker.startTime, undefined, correlationId);
      return createSecureResponse(JSON.stringify({
        error: CONNECTED_APP_FORBIDDEN_ERROR,
        message: CONNECTED_APP_FORBIDDEN_MESSAGE
      }), {
        status: 403,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    if (!authContext.user) {
      completePerformanceTracking(performanceTracker, req, 401);
      logApiResponse(requestId, 401, Date.now() - performanceTracker.startTime, undefined, correlationId);
      return _unauthorized(cors);
    }
    // Apply user-based rate limiting
    const userRateLimit = await checkUserRateLimit(authContext.user.id);
    if (!userRateLimit.allowed) {
      completePerformanceTracking(performanceTracker, req, 429, authContext.user.id);
      logApiResponse(requestId, 429, Date.now() - performanceTracker.startTime, authContext.user.id, correlationId);
      return createRateLimitResponse(userRateLimit);
    }
    if (pathname === "/v1/templates" && method === "GET") {
      return await listTemplates(authContext, url, cors);
    }
    if (pathname === "/v1/templates" && method === "POST") {
      return await createTemplate(authContext, await req.json(), cors);
    }
    if (pathname === "/v1/preferences" && method === "GET") {
      return await getPreferences(authContext, cors);
    }
    if (pathname === "/v1/preferences" && method === "PUT") {
      return await updatePreferences(authContext, await req.json(), cors);
    }
    if (pathname === "/v1/notifications" && method === "GET") {
      return await listNotifications(authContext, url, cors);
    }
    if (pathname === "/v1/notifications" && method === "POST") {
      return await createNotification(authContext, await req.json(), cors);
    }
    // Token Management Endpoints
    if (pathname === "/v1/tokens" && method === "POST") {
      return await createToken(authContext, await req.json(), cors);
    }
    if (pathname === "/v1/tokens" && method === "GET") {
      return await listTokens(authContext, url, cors);
    }
    if (pathname.startsWith("/v1/tokens/") && method === "DELETE") {
      const tokenId = pathname.split("/").pop();
      return await deleteToken(authContext, tokenId, cors);
    }
    // Scheduled Notification Management Endpoints
    if (pathname === "/v1/scheduled" && method === "GET") {
      return await listScheduledNotifications(authContext, url, cors);
    }
    if (pathname === "/v1/scheduled" && method === "POST") {
      return await createScheduledNotification(authContext, await req.json(), cors);
    }
    if (pathname.startsWith("/v1/scheduled/") && method === "PUT") {
      const scheduledId = pathname.split("/").pop();
      return await updateScheduledNotification(authContext, scheduledId, await req.json(), cors);
    }
    if (pathname.startsWith("/v1/scheduled/") && method === "DELETE") {
      const scheduledId = pathname.split("/").pop();
      return await deleteScheduledNotification(authContext, scheduledId, cors);
    }
    // Template Management Endpoints
    if (pathname.startsWith("/v1/templates/") && method === "GET") {
      const templateId = pathname.split("/").pop();
      return await getTemplate(authContext, templateId, cors);
    }
    if (pathname.startsWith("/v1/templates/") && method === "PUT") {
      const templateId = pathname.split("/").pop();
      return await updateTemplate(authContext, templateId, await req.json(), cors);
    }
    if (pathname.startsWith("/v1/templates/") && method === "DELETE") {
      const templateId = pathname.split("/").pop();
      return await deleteTemplate(authContext, templateId, cors);
    }
    // Analytics and Reporting Endpoints
    if (pathname === "/v1/analytics" && method === "GET") {
      return await getAnalytics(authContext, url, cors);
    }
    if (pathname === "/v1/analytics/export" && method === "GET") {
      return await exportAnalytics(authContext, url, cors);
    }
    // Admin Management Endpoints
    if (pathname === "/v1/admin/broadcast-reach" && method === "GET") {
      if (!authContext.isAdmin) return forbidden(cors);
      let input: unknown;
      try {
        input = {
          audience_filter: url.searchParams.has("audience_filter") ? JSON.parse(url.searchParams.get("audience_filter")!) : null,
          platform: url.searchParams.get("platform") ?? "all",
          target_user_ids: url.searchParams.has("target_user_ids") ? JSON.parse(url.searchParams.get("target_user_ids")!) : null
        };
      } catch {
        return createSecureResponse(JSON.stringify({ error: "Invalid JSON query parameter" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const validation = reachEstimateSchema.safeParse(input);
      if (!validation.success) return createSecureResponse(JSON.stringify({ error: validation.error.message }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const parsed = validation.data;
      const { data, error } = await supabase.schema("public").rpc("estimate_broadcast_reach", {
        p_audience_filter: parsed.audience_filter ?? null,
        p_platform: parsed.platform,
        p_target_user_ids: parsed.target_user_ids
      });
      if (error) throw error;
      return createSecureResponse(JSON.stringify({ data }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (pathname === "/v1/admin/users" && method === "GET") {
      return await listUsers(authContext, url, cors);
    }
    if (pathname.startsWith("/v1/admin/users/") && pathname.endsWith("/tokens") && method === "GET") {
      const userId = pathname.split("/")[3];
      return await getUserTokens(authContext, userId, cors);
    }
    if (pathname === "/v1/admin/notifications/broadcast" && method === "POST") {
      return await broadcastNotification(authContext, await req.json(), cors, correlationId);
    }
    // Monitoring Dashboard Endpoint
    if (pathname === "/monitoring" && method === "GET") {
      return await monitoringDashboard(authContext, url, cors, correlationId);
    }
    completePerformanceTracking(performanceTracker, req, 404, authContext.user.id);
    logApiResponse(requestId, 404, Date.now() - performanceTracker.startTime, authContext.user.id, correlationId);
    return createSecureResponse(JSON.stringify({
      error: "Not found"
    }), {
      status: 404,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    const normalized = normalizeError(error);
    completePerformanceTracking(performanceTracker, req, 500, undefined);
    logApiResponse(requestId, 500, Date.now() - performanceTracker.startTime, undefined, correlationId);
    logError("Internal Server Error", normalized, ErrorCategory.SYSTEM, ErrorSeverity.HIGH, {
      pathname,
      method: req.method,
      correlationId
    }, correlationId);
    return createSecureResponse(JSON.stringify({
      error: "Internal Server Error",
      message: normalized.message
    }), {
      status: 500,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  } finally{
    // Flush any remaining logs
    monitoring.flushLogsOnExit();
  }
});
const templateSchema = z.object({
  name: z.string().min(3).max(100).transform((val)=>val.trim().replace(/[<>]/g, "")),
  title_template: z.string().min(1).max(500).transform((val)=>val.trim().replace(/[<>]/g, "")),
  body_template: z.string().min(1).max(2000).transform((val)=>val.trim().replace(/[<>]/g, "")),
  data_schema: z.record(z.unknown()).optional(),
  category: z.string().max(50).default("general").transform((val)=>val.trim().replace(/[<>]/g, "")),
  is_active: z.boolean().optional().default(true)
});
const preferencesSchema = z.object({
  push_enabled: z.boolean().optional(),
  quiet_hours_start: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  quiet_hours_end: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  marketing_enabled: z.boolean().optional(),
  transactional_enabled: z.boolean().optional(),
  social_enabled: z.boolean().optional(),
  reminder_enabled: z.boolean().optional(),
  priority_threshold: z.enum([
    "low",
    "normal",
    "high"
  ]).optional(),
  batch_notifications: z.boolean().optional()
});
const notificationRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  templateName: z.string().max(100).transform((val)=>val?.trim().replace(/[<>]/g, "")).optional(),
  title: z.string().max(200).transform((val)=>val?.trim().replace(/[<>]/g, "")).optional(),
  body: z.string().max(1000).transform((val)=>val?.trim().replace(/[<>]/g, "")).optional(),
  data: z.record(z.unknown()).optional(),
  priority: z.enum([
    "low",
    "normal",
    "high"
  ]).optional(),
  category: z.string().max(50).transform((val)=>val?.trim().replace(/[<>]/g, "")).optional(),
  platform: z.enum([
    "all",
    "ios",
    "android",
    "web"
  ]).optional().default("all"),
  linkType: z.enum([
    "internal",
    "external",
    "app_deep_link"
  ]).optional()
});
// Token Management Schemas
const tokenSchema = z.object({
  token: z.string().min(1).max(500),
  device_type: z.enum([
    "android",
    "ios",
    "web"
  ]),
  locale: z.string().min(2).max(10).default("en"),
  device_model: z.string().max(100).optional(),
  app_version: z.string().max(50).optional(),
  metadata: z.record(z.unknown()).optional().default({})
});
const audienceFilterSchema = z.unknown().transform((input, ctx) => {
  const validated = validateAudienceFilter(input);
  if (!validated.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: validated.error });
    return z.NEVER;
  }
  return validated.value;
}).optional();
// Scheduled Notification Schemas
const scheduledNotificationSchema = z.object({
  deliver_local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deliver_local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  local_time_fallback: z.enum(["utc", "exclude"]).optional(),

  audience_filter: audienceFilterSchema,
  audience: z.enum(["user", "broadcast"]).optional().default("user"),
  platform: z.enum(["all", "ios", "android", "web"]).optional().default("all"),
  target_user_ids: z.array(z.string().uuid()).optional(),
  user_id: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().optional(),
  template_name: z.string().max(100).optional(),
  template_data: z.record(z.unknown()).optional().default({}),
  title: z.string().max(200).optional(),
  body: z.string().max(1000).optional(),
  data: z.record(z.unknown()).optional().default({}),
  priority: z.enum([
    "low",
    "normal",
    "high"
  ]).optional().default("normal"),
  category: z.string().max(50).optional().default("general"),
  schedule_at: z.string().datetime().transform((val)=>new Date(val)).optional(),
  recurrence: z.enum([
    "none",
    "daily",
    "weekly",
    "monthly"
  ]).optional().default("none"),
  recurrence_data: z.record(z.unknown()).optional(),
  quiet_hours_override: z.boolean().optional().default(false),
  timezone: z.string().max(50).optional().default("UTC"),
  locale: z.string().min(2).max(10).default("en").transform((val)=>val.trim().toLowerCase()),
  translate: z.boolean().optional().default(false)
});
const updateScheduledNotificationSchema = z.object({
  deliver_local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deliver_local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  local_time_fallback: z.enum(["utc", "exclude"]).optional(),

  audience_filter: audienceFilterSchema,
  audience: z.enum(["user", "broadcast"]).optional(),
  platform: z.enum(["all", "ios", "android", "web"]).optional(),
  target_user_ids: z.array(z.string().uuid()).nullable().optional(),
  user_id: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().optional(),
  template_name: z.string().max(100).optional(),
  template_data: z.record(z.unknown()).optional().default({}),
  title: z.string().max(200).optional(),
  body: z.string().max(1000).optional(),
  data: z.record(z.unknown()).optional().default({}),
  priority: z.enum([
    "low",
    "normal",
    "high"
  ]).optional().default("normal"),
  category: z.string().max(50).optional().default("general"),
  schedule_at: z.string().datetime().transform((val)=>new Date(val)).optional(),
  recurrence: z.enum([
    "none",
    "daily",
    "weekly",
    "monthly"
  ]).optional().default("none"),
  recurrence_data: z.record(z.unknown()).optional(),
  quiet_hours_override: z.boolean().optional().default(false),
  timezone: z.string().max(50).optional().default("UTC"),
  locale: z.string().min(2).max(10).optional().transform((val)=>val?.trim().toLowerCase()),
  translate: z.boolean().optional()
});
// Template Update Schema
const updateTemplateSchema = z.object({
  name: z.string().min(3).max(100).transform((val)=>val.trim().replace(/[<>]/g, "")).optional(),
  title_template: z.string().min(1).max(500).transform((val)=>val.trim().replace(/[<>]/g, "")).optional(),
  body_template: z.string().min(1).max(2000).transform((val)=>val.trim().replace(/[<>]/g, "")).optional(),
  data_schema: z.record(z.unknown()).optional(),
  category: z.string().max(50).transform((val)=>val.trim().replace(/[<>]/g, "")).optional(),
  is_active: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
});
// Analytics Query Schema
const analyticsQuerySchema = z.object({
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  template_id: z.string().uuid().optional(),
  device_type: z.enum([
    "android",
    "ios",
    "web",
    "unknown"
  ]).optional(),
  group_by: z.enum([
    "date",
    "template",
    "device_type"
  ]).optional().default("date"),
  export: z.enum([
    "csv",
    "json"
  ]).optional()
});
const reachEstimateSchema = z.object({
  audience_filter: audienceFilterSchema,
  platform: z.enum(["all", "ios", "android", "web"]),
  target_user_ids: z.array(z.string().uuid()).nullable()
});
// Broadcast Notification Schema
const broadcastNotificationSchema = z.object({
  audience_filter: audienceFilterSchema,
  title: z.string().min(1).max(200).transform((val)=>val.trim().replace(/[<>]/g, "")),
  body: z.string().min(1).max(1000).transform((val)=>val.trim().replace(/[<>]/g, "")),
  data: z.record(z.unknown()).optional().default({}),
  priority: z.enum([
    "low",
    "normal",
    "high"
  ]).optional().default("normal"),
  category: z.string().max(50).transform((val)=>val.trim().replace(/[<>]/g, "")).optional().default("general"),
  platform: z.enum([
    "all",
    "ios",
    "android",
    "web"
  ]).optional().default("all"),
  target_user_ids: z.array(z.string().uuid()).optional(),
  dry_run: z.boolean().optional().default(false),
  translate: z.boolean().optional().default(false),
  locale: z.string().min(2).max(10).default("en").transform((val)=>val.trim().toLowerCase())
});
async function getAuthContext(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      user: null,
      isAdmin: false
    };
  }
  const token = authHeader.replace("Bearer ", "").trim();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return {
      user: null,
      isAdmin: false
    };
  }
  if (isConnectedAppToken(token)) {
    return {
      user: null,
      isAdmin: false,
      connectedApp: true
    };
  }
  const isAdmin = await checkAdmin(data.user.id);
  return {
    user: data.user,
    isAdmin
  };
}
async function checkAdmin(userId) {
  const { data } = await supabase.from("admin_users").select("user_id").eq("user_id", userId).maybeSingle();
  return Boolean(data);
}
async function listTemplates(auth, url, cors) {
  const includeInactive = url.searchParams.get("include_inactive") === "true";
  const query = supabase.from("notification_templates").select("*").order("updated_at", {
    ascending: false
  }).limit(100);
  if (!includeInactive || !auth.isAdmin) {
    query.eq("is_active", true);
  }
  const { data, error } = await query;
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function createTemplate(auth, body, cors) {
  if (!auth.isAdmin) {
    return forbidden(cors);
  }
  const parsed = templateSchema.parse(body);
  const { data, error } = await supabase.from("notification_templates").insert({
    ...parsed,
    data_schema: parsed.data_schema ?? {},
    created_by: auth.user.id
  }).select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    status: 201,
    headers: responseHeaders
  });
}
async function getPreferences(auth, cors) {
  const { data, error } = await supabase.rpc("ensure_user_notification_preferences", {
    p_user_id: auth.user.id
  });
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function updatePreferences(auth, body, cors) {
  const parsed = preferencesSchema.parse(body);
  const { data, error } = await supabase.from("user_notification_preferences").update(parsed).eq("user_id", auth.user.id).select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function listNotifications(auth, url, cors) {
  const targetUserId = auth.isAdmin && url.searchParams.get("userId") ? url.searchParams.get("userId") : auth.user.id;
  // Pagination parameters
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  // Filtering parameters
  const status = url.searchParams.get("status");
  const category = url.searchParams.get("category");
  const priority = url.searchParams.get("priority");
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  // Sorting parameters
  const sortBy = url.searchParams.get("sort_by") ?? "created_at";
  const sortOrder = url.searchParams.get("sort_order") ?? "desc";
  let query = supabase.from("notifications").select("*").eq("user_id", targetUserId).order(sortBy, {
    ascending: sortOrder === "asc"
  }).range(offset, offset + Math.min(limit, 200) - 1);
  // Apply filters
  if (status) {
    query = query.eq("status", status);
  }
  if (category) {
    query = query.eq("category", category);
  }
  if (priority) {
    query = query.eq("priority", priority);
  }
  if (startDate) {
    query = query.gte("created_at", startDate);
  }
  if (endDate) {
    query = query.lte("created_at", endDate);
  }
  const { data, error, count } = await query;
  if (error) throw error;
  // Get total count for pagination metadata
  const totalCount = count || 0;
  const totalPages = Math.ceil(totalCount / limit);
  const hasNextPage = offset + limit < totalCount;
  const hasPrevPage = offset > 0;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data,
    pagination: {
      total: totalCount,
      page: Math.floor(offset / limit) + 1,
      per_page: limit,
      total_pages: totalPages,
      has_next_page: hasNextPage,
      has_prev_page: hasPrevPage,
      next_offset: hasNextPage ? offset + limit : null,
      prev_offset: hasPrevPage ? Math.max(0, offset - limit) : null
    }
  }), {
    headers: responseHeaders
  });
}
async function createNotification(auth, body, cors) {
  const correlationId = generateCorrelationId();
  const operationContext = {
    functionName: 'createNotification',
    userId: auth.user?.id,
    correlationId,
    parameters: {
      hasBody: !!body,
      userIsAdmin: auth.isAdmin
    }
  };
  try {
    logVerboseDebug('createNotification started', operationContext);
    const parsed = notificationRequestSchema.parse(body);
    const initialDataRecord = parsed.data;
    logInfo('Notification request received', {
      correlationId,
      userId: auth.user?.id,
      linkType: parsed.linkType ?? 'unspecified',
      platform: parsed.platform ?? 'all',
      hasData: !!parsed.data,
      dataLinkFields: {
        deep_link: initialDataRecord?.["deep_link"] ?? null,
        external_url: initialDataRecord?.["external_url"] ?? null,
        open_in_browser: initialDataRecord?.["open_in_browser"] ?? null,
        linkKeys: initialDataRecord ? Object.keys(initialDataRecord).filter((k)=>k.toLowerCase().includes("link")) : []
      }
    }, correlationId);
    logVerboseDebug('Notification request validated successfully', {
      ...operationContext,
      data: {
        hasUserId: !!parsed.userId,
        hasTemplateId: !!parsed.templateId,
        platform: parsed.platform,
        priority: parsed.priority
      }
    });
    if (parsed.data?.deep_link !== undefined) {
      const validatedUrl = validateNotificationUrl(parsed.data.deep_link, parsed.linkType);
      if (!validatedUrl) {
        logWarning("Invalid deep_link URL in notification request", {
          userId: auth.user?.id,
          originalUrl: parsed.data.deep_link,
          correlationId
        }, correlationId);
        parsed.data = {
          ...parsed.data,
          deep_link: null,
          url_error: "invalid_url_format"
        };
      } else {
        parsed.data = {
          ...parsed.data,
          deep_link: validatedUrl
        };
      }
      const validatedDataRecord = parsed.data;
      logInfo('Notification link fields after validation', {
        correlationId,
        deep_link: validatedDataRecord?.["deep_link"] ?? null,
        external_url: validatedDataRecord?.["external_url"] ?? null,
        open_in_browser: validatedDataRecord?.["open_in_browser"] ?? null,
        linkType: parsed.linkType ?? 'unspecified'
      }, correlationId);
    }
    if (!auth.isAdmin && auth.user.id !== parsed.userId) {
      const authError = new Error('Unauthorized: User can only create notifications for themselves');
      logVerboseError('Authorization failed in createNotification', authError, {
        ...operationContext,
        operation: 'authorization_createNotification',
        parameters: {
          requestUserId: parsed.userId,
          authenticatedUserId: auth.user?.id
        }
      });
      return forbidden(cors);
    }
    // Map platform to target_device_types for targeted notifications
    let targetDeviceTypes;
    try {
      targetDeviceTypes = mapPlatformToTargetDeviceTypes(parsed.platform || "all");
      logVerboseDebug('Platform mapping successful', {
        ...operationContext,
        data: {
          platform: parsed.platform,
          targetDeviceTypes
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid platform value";
      logVerboseError("Platform mapping failed for targeted notification", error instanceof Error ? error : new Error(message), {
        ...operationContext,
        operation: 'platform_mapping',
        parameters: {
          platform: parsed.platform,
          userId: parsed.userId
        }
      });
      const responseHeaders = {
        ...cors,
        "Content-Type": "application/json"
      };
      return createSecureResponse(JSON.stringify({
        error: message
      }), {
        status: 400,
        headers: responseHeaders
      });
    }
    // Transform the payload to include target_device_types for the FCM function
    const fcmPayload = {
      ...parsed,
      target_device_types: targetDeviceTypes
    };
    const fcmDataRecord = fcmPayload.data;
    logInfo('Forwarding notification to send-fcm-notification', {
      correlationId,
      userId: fcmPayload.userId ?? auth.user?.id,
      linkType: fcmPayload.linkType ?? 'unspecified',
      targetDeviceTypes,
      payloadLinks: {
        deep_link: fcmDataRecord?.["deep_link"] ?? null,
        external_url: fcmDataRecord?.["external_url"] ?? null,
        open_in_browser: fcmDataRecord?.["open_in_browser"] ?? null
      }
    }, correlationId);
    logVerboseDebug('Calling FCM service', {
      ...operationContext,
      data: {
        platform: fcmPayload.platform,
        targetDeviceTypes: fcmPayload.target_device_types
      }
    });
    const response = await fetch(sendFunctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify(fcmPayload)
    });
    if (!response.ok) {
      // Parse error response properly to avoid [object Object] issue
      let errorMessage;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorData.message || 'FCM service error';
      } catch  {
        errorMessage = await response.text();
      }
      const fcmError = new Error(errorMessage);
      logVerboseError('FCM service call failed', fcmError, {
        ...operationContext,
        operation: 'fcm_service_call',
        parameters: {
          url: sendFunctionUrl,
          status: response.status,
          statusText: response.statusText
        }
      });
      const responseHeaders = {
        ...cors,
        "Content-Type": "application/json"
      };
      return createSecureResponse(JSON.stringify({
        error: errorMessage
      }), {
        status: response.status,
        headers: responseHeaders
      });
    }
    logInfo('FCM service accepted notification request', {
      correlationId,
      userId: fcmPayload.userId ?? auth.user?.id,
      targetDeviceTypes
    }, correlationId);
    logVerboseDebug('createNotification completed successfully', operationContext);
    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json"
    };
    return createSecureResponse(await response.text(), {
      status: 202,
      headers: responseHeaders
    });
  } catch (error) {
    const normalized = normalizeError(error);
    logVerboseError('Unexpected error in createNotification', normalized, {
      ...operationContext,
      operation: 'createNotification_unexpected'
    });
    throw normalized; // preserves message for the top handler
  }
}
function _unauthorized(cors) {
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    error: "Unauthorized"
  }), {
    status: 401,
    headers: responseHeaders
  });
}
function forbidden(cors) {
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    error: "Forbidden"
  }), {
    status: 403,
    headers: responseHeaders
  });
}
// Token Management Functions
async function createToken(auth, body, cors) {
  const parsed = tokenSchema.parse(body);
  const { data, error } = await supabase.from("user_fcm_tokens").insert({
    ...parsed,
    user_id: auth.user.id
  }).select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    status: 201,
    headers: responseHeaders
  });
}
async function listTokens(auth, url, cors) {
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const deviceType = url.searchParams.get("device_type");
  let query = supabase.from("user_fcm_tokens").select("*").eq("user_id", auth.user.id).order("created_at", {
    ascending: false
  }).limit(Math.min(limit, 200));
  if (deviceType) {
    query = query.eq("device_type", deviceType);
  }
  const { data, error } = await query;
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function deleteToken(auth, tokenId, cors) {
  const { data, error } = await supabase.from("user_fcm_tokens").update({
    is_active: false
  }).eq("id", tokenId).eq("user_id", auth.user.id).select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
function sanitizeNotificationDataUrls(data: Record<string, unknown> | undefined) {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if ((key.endsWith("_url") || key === "deep_link" || key === "link") && !validateNotificationUrl(data[key], undefined)) delete data[key];
  }
}
// Scheduled Notification Functions
async function listScheduledNotifications(auth, url, cors) {
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const status = url.searchParams.get("status");
  let query = supabase.from("scheduled_notifications").select("*").order("schedule_at", {
    ascending: false
  }).limit(Math.min(limit, 200));
  if (!auth.isAdmin) query = query.eq("user_id", auth.user.id);
  if (status) {
    query = query.eq("status", status);
  }
  const { data, error } = await query;
  if (error) throw error;
  const localIds = (data ?? []).filter((row: { deliver_local_time: string | null }) => row.deliver_local_time != null).map((row: { id: string }) => row.id);
  if (localIds.length) {
    const { data: summaries, error: summaryError } = await supabase.rpc("scheduled_bucket_summary", { p_job_ids: localIds });
    if (summaryError) throw summaryError;
    const byId = new Map((summaries ?? []).map((row: { job_id: string; counts: Record<string, number> }) => [row.job_id, row.counts]));
    for (const row of data ?? []) if (row.deliver_local_time != null) row.bucket_summary = byId.get(row.id) ?? {};
  }

  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function createScheduledNotification(auth, body, cors) {
  const validation = scheduledNotificationSchema.safeParse(body);
  if (!validation.success) return createSecureResponse(JSON.stringify({ error: validation.error.message }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  const parsed = validation.data;
  if (!auth.isAdmin && (parsed.deliver_local_date !== undefined || parsed.deliver_local_time !== undefined || parsed.local_time_fallback !== undefined)) return forbidden(cors);
  const localError = parsed.local_time_fallback !== undefined && parsed.audience !== "broadcast" ? "local_time_fallback requires broadcast audience" : localScheduleError(parsed);
  if (localError || (!parsed.schedule_at && !parsed.deliver_local_time)) return createSecureResponse(JSON.stringify({ error: localError ?? "schedule_at is required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  if (!parsed.schedule_at && parsed.deliver_local_date && parsed.deliver_local_time) parsed.schedule_at = defaultLocalScheduleAt(parsed.deliver_local_date, parsed.deliver_local_time);
  if (parsed.audience_filter !== undefined && !auth.isAdmin) return forbidden(cors);
  if (parsed.audience_filter != null && parsed.audience !== "broadcast") return createSecureResponse(JSON.stringify({ error: "audience_filter requires broadcast audience" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  if (!canManageScheduledRecipient(auth.isAdmin, auth.user.id, parsed)) return forbidden(cors);
  if (parsed.audience === "broadcast" && parsed.user_id != null) throw new Error("Broadcast user_id must be null or omitted");
  if (parsed.audience === "user" && parsed.target_user_ids !== undefined) throw new Error("target_user_ids requires broadcast audience");
  sanitizeNotificationDataUrls(parsed.data);
  const { data, error } = await supabase.from("scheduled_notifications").insert({
    ...parsed,
    user_id: parsed.audience === "broadcast" ? null : parsed.user_id ?? auth.user.id,
    created_by: auth.user.id
  }).select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    status: 201,
    headers: responseHeaders
  });
}
async function updateScheduledNotification(auth, scheduledId, body, cors) {
  const validation = updateScheduledNotificationSchema.safeParse(body);
  if (!validation.success) return createSecureResponse(JSON.stringify({ error: validation.error.message }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  const parsed = validation.data;
  if (!auth.isAdmin && (parsed.deliver_local_date !== undefined || parsed.deliver_local_time !== undefined || parsed.local_time_fallback !== undefined)) return forbidden(cors);
  if (parsed.audience_filter !== undefined && !auth.isAdmin) return forbidden(cors);
  if (!canManageScheduledRecipient(auth.isAdmin, auth.user.id, parsed)) return forbidden(cors);
  let existingQuery = supabase.from("scheduled_notifications").select("*").eq("id", scheduledId);
  if (!auth.isAdmin) existingQuery = existingQuery.eq("user_id", auth.user.id);
  const { data: existing, error: readError } = await existingQuery.single();
  if (readError) throw readError;
  const audience = parsed.audience ?? existing.audience;
  const mergedLocal = { ...existing, ...parsed, audience };
  const localError = parsed.local_time_fallback !== undefined && audience !== "broadcast" ? "local_time_fallback requires broadcast audience" : localScheduleError(mergedLocal);
  if (localError || (mergedLocal.deliver_local_time != null && existing.status !== "pending")) return createSecureResponse(JSON.stringify({ error: localError ?? "Started local-time jobs cannot be edited; create a new job" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

  const audienceFilter = parsed.audience_filter !== undefined ? parsed.audience_filter : audience === "user" ? null : existing.audience_filter;
  if (audienceFilter != null && audience !== "broadcast") return createSecureResponse(JSON.stringify({ error: "audience_filter requires broadcast audience" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  const userId = audience === "broadcast" ? null : parsed.user_id ?? existing.user_id ?? auth.user.id;
  if (audience === "broadcast" && parsed.user_id != null) throw new Error("Broadcast user_id must be null");
  const targetUserIds = parsed.target_user_ids !== undefined ? parsed.target_user_ids : audience === "user" ? null : existing.target_user_ids;
  if (audience === "user" && parsed.target_user_ids != null) throw new Error("target_user_ids requires broadcast audience");
  sanitizeNotificationDataUrls(parsed.data);
  let query = supabase.from("scheduled_notifications").update({ ...parsed, ...(mergedLocal.deliver_local_time != null ? { translated_payloads: null } : {}), audience, audience_filter: audienceFilter, user_id: userId, target_user_ids: targetUserIds }).eq("id", scheduledId);
  if (existing.deliver_local_time != null || mergedLocal.deliver_local_time != null) query = query.eq("status", "pending");
  if (!auth.isAdmin) query = query.eq("user_id", auth.user.id);
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function deleteScheduledNotification(auth, scheduledId, cors) {
  let query = supabase.from("scheduled_notifications").update({ status: "cancelled" }).eq("id", scheduledId);
  if (!auth.isAdmin) query = query.eq("user_id", auth.user.id);
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
// Template Management Functions
async function getTemplate(auth, templateId, cors) {
  const { data, error } = await supabase.from("notification_templates").select("*").eq("id", templateId).single();
  if (error) throw error;
  // Check if user has access (admin or active template)
  if (!auth.isAdmin && !data?.is_active) {
    return forbidden(cors);
  }
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function updateTemplate(auth, templateId, body, cors) {
  if (!auth.isAdmin) {
    return forbidden(cors);
  }
  const parsed = updateTemplateSchema.parse(body);
  const { data, error } = await supabase.from("notification_templates").update(parsed).eq("id", templateId).select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function deleteTemplate(auth, templateId, cors) {
  if (!auth.isAdmin) {
    return forbidden(cors);
  }
  const { data, error } = await supabase.from("notification_templates").update({
    is_active: false
  }).eq("id", templateId).select("*").single();
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
// Analytics Functions
async function getAnalytics(auth, url, cors) {
  if (!auth.isAdmin) {
    return forbidden(cors);
  }
  const query = analyticsQuerySchema.parse(Object.fromEntries(url.searchParams));
  let dbQuery = supabase.from("notification_analytics").select("*").order("date", {
    ascending: false
  }).limit(1000);
  if (query.start_date) {
    dbQuery = dbQuery.gte("date", query.start_date.split("T")[0]);
  }
  if (query.end_date) {
    dbQuery = dbQuery.lte("date", query.end_date.split("T")[0]);
  }
  if (query.template_id) {
    dbQuery = dbQuery.eq("template_id", query.template_id);
  }
  if (query.device_type) {
    dbQuery = dbQuery.eq("device_type", query.device_type);
  }
  const { data, error } = await dbQuery;
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function exportAnalytics(auth, url, cors) {
  if (!auth.isAdmin) {
    return forbidden(cors);
  }
  const query = analyticsQuerySchema.parse(Object.fromEntries(url.searchParams));
  let dbQuery = supabase.from("notification_analytics").select("*").order("date", {
    ascending: false
  });
  if (query.start_date) {
    dbQuery = dbQuery.gte("date", query.start_date.split("T")[0]);
  }
  if (query.end_date) {
    dbQuery = dbQuery.lte("date", query.end_date.split("T")[0]);
  }
  if (query.template_id) {
    dbQuery = dbQuery.eq("template_id", query.template_id);
  }
  if (query.device_type) {
    dbQuery = dbQuery.eq("device_type", query.device_type);
  }
  const { data, error } = await dbQuery;
  if (error) throw error;
  const exportFormat = query.export || "json";
  let content;
  let contentType;
  if (exportFormat === "csv") {
    // Handle empty data case
    if (!data || data.length === 0) {
      content = "";
      contentType = "text/csv";
    } else {
      const headers = Object.keys(data[0] || {}).join(",");
      const rows = data.map((row)=>Object.values(row).join(","));
      content = [
        headers,
        ...rows
      ].join("\n");
      contentType = "text/csv";
    }
  } else {
    content = JSON.stringify(data);
    contentType = "application/json";
  }
  const responseHeaders = {
    ...cors,
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="analytics.${exportFormat}"`
  };
  return createSecureResponse(content, {
    headers: responseHeaders
  });
}
// Admin Management Functions
async function listUsers(auth, url, cors) {
  if (!auth.isAdmin) {
    return forbidden(cors);
  }
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const search = url.searchParams.get("search");
  let query = supabase.from("auth.users").select("id, email, created_at, last_sign_in_at").order("created_at", {
    ascending: false
  }).limit(Math.min(limit, 200));
  if (search) {
    query = query.ilike("email", `%${search}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function getUserTokens(auth, userId, cors) {
  if (!auth.isAdmin) {
    return forbidden(cors);
  }
  const { data, error } = await supabase.from("user_fcm_tokens").select("*").eq("user_id", userId).order("created_at", {
    ascending: false
  });
  if (error) throw error;
  const responseHeaders = {
    ...cors,
    "Content-Type": "application/json"
  };
  return createSecureResponse(JSON.stringify({
    data
  }), {
    headers: responseHeaders
  });
}
async function broadcastNotification(auth, body, cors, correlationId) {
  const opCtx = {
    correlationId,
    platform: body?.platform
  };
  try {
    if (!auth.isAdmin) {
      return forbidden(cors);
    }
    const validation = broadcastNotificationSchema.safeParse(body);
    if (!validation.success) return createSecureResponse(JSON.stringify({ error: validation.error.message }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const parsed = validation.data;
    const initialDataRecord = parsed.data;
    logInfo('Broadcast notification request received', {
      correlationId,
      platform: parsed.platform,
      translate: parsed.translate,
      locale: parsed.locale,
      targetUsers: parsed.target_user_ids?.length ?? 0,
      dataLinkFields: {
        deep_link: initialDataRecord?.["deep_link"] ?? null,
        external_url: initialDataRecord?.["external_url"] ?? null,
        open_in_browser: initialDataRecord?.["open_in_browser"] ?? null,
        linkKeys: initialDataRecord ? Object.keys(initialDataRecord).filter((k)=>k.toLowerCase().includes("link")) : []
      }
    }, correlationId);
    // Validate the data URLs
    if (parsed.data) {
      Object.keys(parsed.data).forEach((key)=>{
        if (key.endsWith("_url") || key === "deep_link" || key === "link") {
          const validatedUrl = validateNotificationUrl(parsed.data[key]);
          if (!validatedUrl) {
            logWarning("Invalid URL in broadcast notification data", {
              key,
              originalValue: parsed.data[key],
              correlationId
            }, correlationId);
            // Remove invalid URLs
            delete parsed.data[key];
          }
        }
      });
      const validatedDataRecord = parsed.data;
      logInfo('Broadcast data after URL validation', {
        correlationId,
        deep_link: validatedDataRecord?.["deep_link"] ?? null,
        external_url: validatedDataRecord?.["external_url"] ?? null,
        open_in_browser: validatedDataRecord?.["open_in_browser"] ?? null
      }, correlationId);
    }
    // Map platform to target_device_types
    let targetDeviceTypes;
    try {
      targetDeviceTypes = mapPlatformToTargetDeviceTypes(parsed.platform);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid platform value";
      logError("Platform mapping failed", error instanceof Error ? error : new Error(message), ErrorCategory.VALIDATION, ErrorSeverity.MEDIUM, {
        platform: parsed.platform,
        correlationId
      }, correlationId);
      const responseHeaders = {
        ...cors,
        "Content-Type": "application/json"
      };
      return createSecureResponse(JSON.stringify({
        error: message
      }), {
        status: 400,
        headers: responseHeaders
      });
    }
    // If dry run, return early
    if (parsed.dry_run) {
      let matchedTokenCount: number | undefined;
      if (parsed.audience_filter != null) {
        const { data: matched, error } = await supabase.rpc("get_broadcast_tokens", {
          p_target_device_types: targetDeviceTypes,
          p_target_user_ids: parsed.target_user_ids ?? null,
          p_audience_filter: parsed.audience_filter
        });
        if (error) throw error;
        matchedTokenCount = matched?.length ?? 0;
      }
      const responseHeaders = {
        ...cors,
        "Content-Type": "application/json"
      };
      return createSecureResponse(JSON.stringify({
        message: "Dry run successful",
        audience_filter: parsed.audience_filter ?? null,
        ...(matchedTokenCount !== undefined ? { matched_token_count: matchedTokenCount } : {}),
        title: parsed.title,
        body: parsed.body,
        platform: parsed.platform,
        target_device_types: targetDeviceTypes,
        priority: parsed.priority,
        category: parsed.category,
        translate: parsed.translate,
        locale: parsed.locale
      }), {
        headers: responseHeaders
      });
    }
    const result = await sendBroadcast({
      title: parsed.title, body: parsed.body, data: parsed.data,
      priority: parsed.priority, platform: parsed.platform, locale: parsed.locale,
      translate: parsed.translate, target_user_ids: parsed.target_user_ids, audienceFilter: parsed.audience_filter
    }, correlationId, { supabase, fetch, translateNotificationBatch, sendFunctionUrl, serviceRoleKey, logWarning });
    if (result.noTokens) {
      return createSecureResponse(JSON.stringify({ message: "No active tokens found", tokens_targeted: 0 }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" }
      });
    }
    if (result.httpError) {
      return createSecureResponse(JSON.stringify({ error: result.httpError.error }), {
        status: result.httpError.status, headers: { ...cors, "Content-Type": "application/json" }
      });
    }
    const { results: broadcastResults, overallSuccess, targetLocales } = result;
    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json"
    };
    const statusCode = overallSuccess ? 202 : broadcastResults.length > 0 ? 207 : 500;
    logInfo('Broadcast notification completed', {
      correlationId,
      platform: parsed.platform,
      targetDeviceTypes: targetDeviceTypes,
      translate: parsed.translate,
      sourceLocale: parsed.locale,
      targetLocales: targetLocales,
      locales: parsed.translate ? broadcastResults.map((r)=>r.locale).filter((locale)=>locale !== undefined) : undefined,
      notificationCount: broadcastResults.length,
      totalTokensTargeted: broadcastResults.reduce((sum, r)=>sum + r.tokensTargeted, 0),
      success: overallSuccess
    }, correlationId);
    return createSecureResponse(JSON.stringify({
      message: "Broadcast initiated",
      platform: parsed.platform,
      target_device_types: targetDeviceTypes,
      translate: parsed.translate,
      locale: parsed.locale,
      target_locales: targetLocales,
      results: broadcastResults,
      total_tokens_targeted: broadcastResults.reduce((sum, r)=>sum + r.tokensTargeted, 0)
    }), {
      status: statusCode,
      headers: responseHeaders
    });
  } catch (error) {
    const normalized = normalizeError(error);
    logError("Broadcast unexpected error", normalized, ErrorCategory.SYSTEM, ErrorSeverity.HIGH, {
      ...opCtx
    }, correlationId);
    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json"
    };
    return createSecureResponse(JSON.stringify({
      error: normalized.message
    }), {
      status: 500,
      headers: responseHeaders
    });
  }
}
// Health Check Function
async function healthCheck(cors, _correlationId) {
  const performanceTracker = createPerformanceTracker('notification-api', 'health_check', _correlationId || generateCorrelationId());
  try {
    const systemHealth = await getSystemHealth();
    completePerformanceTracking(performanceTracker, undefined, 200);
    logInfo('Health check completed', {
      correlationId: _correlationId,
      systemStatus: systemHealth.status,
      components: systemHealth.components.length
    }, _correlationId);
    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json"
    };
    return createSecureResponse(JSON.stringify({
      status: systemHealth.status,
      timestamp: systemHealth.timestamp,
      components: systemHealth.components,
      uptime: performance.timeOrigin ? Math.round(performance.now() / 1000) : 0
    }), {
      status: 200,
      headers: responseHeaders
    });
  } catch (error) {
    completePerformanceTracking(performanceTracker, undefined, 500);
    logError('Health check failed', error instanceof Error ? error : new Error(String(error)), ErrorCategory.SYSTEM, ErrorSeverity.HIGH, {
      correlationId: _correlationId
    }, _correlationId);
    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json"
    };
    return createSecureResponse(JSON.stringify({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    }), {
      status: 503,
      headers: responseHeaders
    });
  }
}
// Monitoring Dashboard Function
async function monitoringDashboard(auth, url, cors, _correlationId) {
  const performanceTracker = createPerformanceTracker('notification-api', 'monitoring_dashboard', _correlationId || generateCorrelationId());
  try {
    // Only admins can access monitoring dashboard
    if (!auth.isAdmin) {
      completePerformanceTracking(performanceTracker, undefined, 403, auth.user?.id);
      logError('Unauthorized access to monitoring dashboard', undefined, ErrorCategory.AUTHORIZATION, ErrorSeverity.MEDIUM, {
        userId: auth.user?.id,
        correlationId: _correlationId
      }, _correlationId);
      return forbidden(cors);
    }
    // Get query parameters
    const hours = Number(url.searchParams.get("hours") ?? "24");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const level = url.searchParams.get("level");
    const component = url.searchParams.get("component");
    // Get recent logs
    let logsQuery = supabase.from("system_logs").select("*").order("timestamp", {
      ascending: false
    }).limit(Math.min(limit, 1000));
    if (level) {
      logsQuery = logsQuery.eq("level", level);
    }
    if (component) {
      logsQuery = logsQuery.eq("service", component);
    }
    const { data: logs, error: logsError } = await logsQuery;
    if (logsError) throw logsError;
    // Get performance metrics
    const { data: performanceData, error: performanceError } = await supabase.from("performance_metrics").select("*").order("timestamp", {
      ascending: false
    }).limit(100);
    if (performanceError) throw performanceError;
    // Get health checks
    const { data: healthData, error: healthError } = await supabase.from("health_checks").select("*").order("timestamp", {
      ascending: false
    }).limit(50);
    if (healthError) throw healthError;
    // Get usage analytics
    const { data: usageData, error: usageError } = await supabase.from("usage_analytics").select("*").order("date", {
      ascending: false
    }).limit(200);
    if (usageError) throw usageError;
    // Get error statistics
    const { data: errorStats, error: errorStatsError } = await supabase.from("system_logs").select("level, error_category, COUNT(*)").gte("timestamp", new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()).order("count", {
      ascending: false
    });
    if (errorStatsError) throw errorStatsError;
    completePerformanceTracking(performanceTracker, undefined, 200, auth.user?.id);
    logInfo('Monitoring dashboard accessed', {
      correlationId: _correlationId,
      userId: auth.user?.id,
      hours,
      limit
    }, _correlationId);
    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json"
    };
    return createSecureResponse(JSON.stringify({
      summary: {
        totalLogs: logs?.length || 0,
        totalErrors: logs?.filter((log)=>log.level === 'error').length || 0,
        totalWarnings: logs?.filter((log)=>log.level === 'warn').length || 0,
        avgResponseTime: performanceData?.length ? performanceData.reduce((sum, metric)=>sum + Number(metric.avg_response_time_ms), 0) / performanceData.length : 0,
        systemStatus: healthData?.[0]?.status || 'unknown'
      },
      logs: logs || [],
      performance: performanceData || [],
      health: healthData || [],
      usage: usageData || [],
      errorStats: errorStats || [],
      filters: {
        hours,
        limit,
        level,
        component
      },
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: responseHeaders
    });
  } catch (error) {
    completePerformanceTracking(performanceTracker, undefined, 500, auth.user?.id);
    logError('Monitoring dashboard error', error instanceof Error ? error : new Error(String(error)), ErrorCategory.SYSTEM, ErrorSeverity.HIGH, {
      userId: auth.user?.id,
      correlationId: _correlationId
    }, _correlationId);
    const responseHeaders = {
      ...cors,
      "Content-Type": "application/json"
    };
    return createSecureResponse(JSON.stringify({
      error: "Failed to load monitoring data"
    }), {
      status: 500,
      headers: responseHeaders
    });
  }
}
