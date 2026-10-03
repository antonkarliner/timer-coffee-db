import { authorizeServiceRole } from "../_shared/service-role-auth.ts";
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { checkUserRateLimit as _checkUserRateLimit, checkDailyNotificationLimit, checkIpRateLimit, getClientIP, createRateLimitResponse } from "../_shared/rate-limiter.ts";
import { validateAndLogEnvironment, ENVIRONMENT_CONFIG } from "../_shared/env-validation.ts";
import { monitoring, generateCorrelationId, createPerformanceTracker, completePerformanceTracking, logApiRequest, logApiResponse, logInfo, logWarning, logError, logFatal, ErrorCategory, ErrorSeverity } from "../_shared/monitoring.ts";
import { translateNotificationBatch } from "../_shared/translation-service.ts";
// Direct FCM HTTP v1 API client (bypassing Firebase Admin SDK)
import { sendFCMMulticast, isInvalidTokenError } from "../_shared/fcm-http-client.ts";
// Validate environment variables
validateAndLogEnvironment();
const supabaseUrl = ENVIRONMENT_CONFIG.supabaseUrl;
const serviceRoleKey = ENVIRONMENT_CONFIG.supabaseServiceRoleKey;
const firebaseServiceAccount = ENVIRONMENT_CONFIG.firebaseServiceAccount;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be provided");
}
if (!firebaseServiceAccount) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT env var is required for send-fcm-notification");
}
const serviceAccount = JSON.parse(firebaseServiceAccount);
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false
  },
  db: {
    schema: "service"
  }
});
const notificationSchema = z.object({
  userId: z.string().uuid().nullable(),
  notificationId: z.string().uuid().optional(),
  templateName: z.string().optional(),
  templateId: z.string().uuid().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  data: z.record(z.any()).optional(),
  priority: z.enum([
    "low",
    "normal",
    "high"
  ]).default("normal"),
  category: z.string().optional(),
  requestId: z.string().optional(),
  quietHoursOverride: z.boolean().optional(),
  translate: z.boolean().optional().default(false),
  locale: z.string().min(2).max(10).default("en").transform((val)=>val.trim().toLowerCase()),
  target_device_types: z.array(z.enum([
    "android",
    "ios",
    "web"
  ])).optional(),
  tokens: z.array(z.union([
    z.string().min(1),
    z.object({
      token: z.string().min(1),
      device_type: z.enum([
        "android",
        "ios",
        "web"
      ]).optional(),
      locale: z.string().min(2).max(10).optional(),
      id: z.string().uuid().optional()
    })
  ])).optional(),
  deep_link: z.string().optional()
}).superRefine((value, ctx)=>{
  if (!value.templateName && !value.templateId && (!value.title || !value.body)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide templateName/templateId or explicit title and body",
      path: [
        "title"
      ]
    });
  }
  if (!value.userId && (!value.tokens || value.tokens.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide tokens array when sending a broadcast (userId = null)",
      path: [
        "tokens"
      ]
    });
  }
});
const DEFAULT_PREFERENCES = {
  push_enabled: true,
  quiet_hours_start: null,
  quiet_hours_end: null,
  marketing_enabled: true,
  transactional_enabled: true,
  priority_threshold: "low"
};
const MAX_FCM_BATCH = ENVIRONMENT_CONFIG.fcmBatchSize;
const DEFAULT_MAX_TOKEN_AGE_DAYS = ENVIRONMENT_CONFIG.tokenMaxAgeDays;
const MAX_REQUEST_SIZE = ENVIRONMENT_CONFIG.maxRequestSize; // 1MB default
const MAX_FCM_PAYLOAD_SIZE = 4096; // FCM limit is 4KB
function summarizeLinkFields(rawDeepLink, dataPayload) {
  return {
    rawDeepLink: typeof rawDeepLink === "string" ? rawDeepLink : rawDeepLink ?? null,
    dataDeepLink: dataPayload ? dataPayload["deep_link"] ?? null : null,
    dataExternalUrl: dataPayload ? dataPayload["external_url"] ?? null : null,
    openInBrowser: dataPayload ? dataPayload["open_in_browser"] ?? null : null,
    linkType: dataPayload ? dataPayload["link_type"] ?? null : null,
    urlValidation: dataPayload ? dataPayload["url_validation"] ?? null : null,
    validatedUrl: dataPayload ? dataPayload["validated_url"] ?? null : null,
    linkKeys: dataPayload ? Object.keys(dataPayload).filter((k)=>k.toLowerCase().includes("link")) : []
  };
}
function classifyLinkType(link) {
  if (!link) {
    return {
      type: "none",
      shouldOpenInBrowser: false
    };
  }
  try {
    const url = new URL(link);
    // External HTTP/HTTPS URLs - must open in browser
    if (url.protocol === "https:" || url.protocol === "http:") {
      return {
        type: "external_url",
        parsedUrl: link,
        shouldOpenInBrowser: true
      };
    }
    // App deep links - open internally
    if (url.protocol === "timercoffee:" || url.protocol === "app:") {
      return {
        type: "app_deep_link",
        parsedUrl: link,
        shouldOpenInBrowser: false
      };
    }
    // Unknown protocol - default to external for security
    return {
      type: "unknown",
      parsedUrl: link,
      shouldOpenInBrowser: true
    };
  } catch (_error) {
    // Not a valid URL - treat as internal route if starts with /
    if (link.startsWith("/")) {
      return {
        type: "internal_route",
        shouldOpenInBrowser: false
      };
    }
    // Malformed URL - treat as external to be safe
    return {
      type: "malformed",
      shouldOpenInBrowser: true
    };
  }
}
function validateAndSanitizeDeepLink(url) {
  if (typeof url !== "string") return null;
  if (!url) return null;
  try {
    const parsedUrl = new URL(url);
    // Only allow http and https protocols for external URLs
    if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
      // Ensure the URL has a valid host
      if (!parsedUrl.host) return null;
      return url;
    }
    // Allow app deep link schemes
    if (parsedUrl.protocol === "timercoffee:" || parsedUrl.protocol === "app:") {
      return url;
    }
    // Unknown protocol - reject
    return null;
  } catch (_error) {
    // Not a valid URL - might be an internal route
    if (url.startsWith("/")) {
      return url;
    }
    console.warn("Invalid deep_link in notification data:", url);
    return null;
  }
}
function applyDeepLinkMetadata(dataPayload, deepLink, context) {
  // Add defensive check for context
  if (!context) {
    console.warn("[SFCM] applyDeepLinkMetadata called without context");
    return;
  }
  if (deepLink === undefined || deepLink === null) return;
  if (typeof deepLink === "string" && deepLink.trim().length === 0) return;
  const deepLinkString = typeof deepLink === "string" ? deepLink : undefined;
  const linkTypeInfo = classifyLinkType(deepLinkString);
  // Add explicit link type metadata
  dataPayload.link_type = linkTypeInfo.type;
  dataPayload.open_in_browser = linkTypeInfo.shouldOpenInBrowser ? "true" : "false";
  const validatedUrl = validateAndSanitizeDeepLink(deepLink);
  if (validatedUrl) {
    dataPayload.url_validation = "valid";
    // Separate external URLs from internal deep links
    if (linkTypeInfo.shouldOpenInBrowser) {
      // External URLs go ONLY to external_url field
      // This ensures the app knows to open browser, not internal navigation
      dataPayload.external_url = validatedUrl;
      // DO NOT set deep_link for external URLs to prevent internal routing attempts
      delete dataPayload.deep_link;
    } else {
      // Internal/deep links use ONLY deep_link field for app routing
      dataPayload.deep_link = validatedUrl;
      // Clear external_url field for internal links
      delete dataPayload.external_url;
    }
    if (linkTypeInfo.parsedUrl) {
      dataPayload.validated_url = validatedUrl;
    }
  } else {
    dataPayload.url_validation = "invalid";
    delete dataPayload.deep_link;
    delete dataPayload.external_url;
  }
  // Enhanced logging for link classification and field assignment
  logInfo("Notification link classification and field assignment", {
    originalLink: deepLink,
    classifiedType: linkTypeInfo.type,
    shouldOpenInBrowser: linkTypeInfo.shouldOpenInBrowser,
    targetField: linkTypeInfo.shouldOpenInBrowser ? "external_url" : "deep_link",
    finalPayload: {
      external_url: dataPayload.external_url,
      deep_link: dataPayload.deep_link
    },
    userId: context.userId,
    correlationId: context.correlationId
  }, context.correlationId);
  // Console logging for development debugging
  console.log("[SFCM] Link field assignment", {
    correlationId: context.correlationId,
    originalLink: deepLink,
    classifiedType: linkTypeInfo.type,
    shouldOpenInBrowser: linkTypeInfo.shouldOpenInBrowser,
    targetField: linkTypeInfo.shouldOpenInBrowser ? "external_url" : "deep_link",
    finalPayload: {
      external_url: dataPayload.external_url,
      deep_link: dataPayload.deep_link
    }
  });
  if (!validatedUrl) {
    logWarning("Removed invalid URL from notification", {
      originalUrl: deepLink,
      reason: "invalid_format",
      userId: context.userId,
      correlationId: context.correlationId
    }, context.correlationId);
  } else if (!linkTypeInfo.shouldOpenInBrowser && !linkTypeInfo.parsedUrl) {
    logWarning("Invalid internal deep link format", {
      originalLink: deepLink,
      reason: "invalid_format",
      userId: context.userId,
      correlationId: context.correlationId
    }, context.correlationId);
  }
}
serve(async (req)=>{
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);
  // Generate correlation ID for request tracing
  const correlationId = generateCorrelationId();
  // Create performance tracker
  const performanceTracker = createPerformanceTracker('send-fcm-notification', 'main_handler', correlationId);
  // Log API request start
  const requestId = logApiRequest(req, undefined, correlationId);
  if (req.method === "OPTIONS") {
    completePerformanceTracking(performanceTracker, req, 200);
    logApiResponse(requestId, 200, Date.now() - performanceTracker.startTime, undefined, correlationId);
    return new Response("ok", {
      headers: cors
    });
  }
  if (req.method !== "POST") {
    completePerformanceTracking(performanceTracker, req, 405);
    logApiResponse(requestId, 405, Date.now() - performanceTracker.startTime, undefined, correlationId);
    logWarning('Method not allowed', {
      method: req.method,
      url: req.url,
      correlationId
    }, correlationId);
    return createSecureResponse(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  }
  try {
    // Check request size before parsing
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REQUEST_SIZE) {
      completePerformanceTracking(performanceTracker, req, 413);
      logApiResponse(requestId, 413, Date.now() - performanceTracker.startTime, undefined, correlationId);
      logWarning('Request too large', {
        contentLength,
        maxSize: MAX_REQUEST_SIZE,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "Request too large",
        message: `Request size ${contentLength} bytes exceeds maximum allowed size of ${MAX_REQUEST_SIZE} bytes`
      }), {
        status: 413,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    const body = await req.json();
    // Validate request size after parsing (more accurate)
    const requestBodySize = JSON.stringify(body).length;
    if (requestBodySize > MAX_REQUEST_SIZE) {
      completePerformanceTracking(performanceTracker, req, 413);
      logApiResponse(requestId, 413, Date.now() - performanceTracker.startTime, undefined, correlationId);
      logWarning('Request body too large', {
        requestBodySize,
        maxSize: MAX_REQUEST_SIZE,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "Request too large",
        message: `Request body size ${requestBodySize} bytes exceeds maximum allowed size of ${MAX_REQUEST_SIZE} bytes`
      }), {
        status: 413,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    let parsed;
    try {
      parsed = notificationSchema.parse(body);
    } catch (error) {
      completePerformanceTracking(performanceTracker, req, 422);
      logApiResponse(requestId, 422, Date.now() - performanceTracker.startTime, undefined, correlationId);
      logError('Request validation failed', error instanceof Error ? error : new Error(String(error)), ErrorCategory.VALIDATION, ErrorSeverity.MEDIUM, {
        requestBody: body,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "Validation failed",
        details: error instanceof z.ZodError ? error.errors : String(error)
      }), {
        status: 422,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    logInfo("Parsed send-fcm-notification request", {
      correlationId,
      userId: parsed.userId,
      notificationId: parsed.notificationId,
      templateId: parsed.templateId,
      templateName: parsed.templateName,
      translate: parsed.translate,
      locale: parsed.locale,
      category: parsed.category,
      priority: parsed.priority,
      quietHoursOverride: parsed.quietHoursOverride,
      targetDeviceTypes: parsed.target_device_types,
      tokensProvided: Array.isArray(parsed.tokens) ? parsed.tokens.length : 0,
      hasData: !!parsed.data,
      linkFields: {
        topLevel: parsed.deep_link ?? null,
        dataDeepLink: parsed.data?.["deep_link"] ?? null,
        external_url: parsed.data?.["external_url"] ?? null,
        open_in_browser: parsed.data?.["open_in_browser"] ?? null
      }
    }, correlationId);
    console.log("[SFCM] Parsed request", {
      correlationId,
      userId: parsed.userId,
      notificationId: parsed.notificationId,
      templateId: parsed.templateId,
      templateName: parsed.templateName,
      translate: parsed.translate,
      locale: parsed.locale,
      category: parsed.category,
      priority: parsed.priority,
      quietHoursOverride: parsed.quietHoursOverride,
      targetDeviceTypes: parsed.target_device_types,
      tokensProvided: Array.isArray(parsed.tokens) ? parsed.tokens.length : 0,
      linkFields: {
        topLevel: parsed.deep_link ?? null,
        dataDeepLink: parsed.data?.["deep_link"] ?? null,
        external_url: parsed.data?.["external_url"] ?? null,
        open_in_browser: parsed.data?.["open_in_browser"] ?? null
      }
    });
    const deepLinkFromData = parsed.data?.["deep_link"];
    const rawDeepLink = parsed.deep_link ?? deepLinkFromData;
    logInfo("Incoming notification link fields", {
      rawDeepLink,
      topLevelDeepLink: parsed.deep_link,
      dataDeepLink: deepLinkFromData,
      platform: parsed.category,
      locale: parsed.locale,
      translate: parsed.translate,
      targetDeviceTypes: parsed.target_device_types,
      userId: parsed.userId,
      hasTokensArray: Array.isArray(parsed.tokens),
      correlationId
    }, correlationId);
    console.log("[SFCM] Incoming link fields", {
      correlationId,
      rawDeepLink,
      topLevelDeepLink: parsed.deep_link,
      dataDeepLink: deepLinkFromData,
      locale: parsed.locale,
      translate: parsed.translate,
      targetDeviceTypes: parsed.target_device_types,
      hasTokensArray: Array.isArray(parsed.tokens)
    });
    // Check FCM payload size
    const fcmPayload = {
      title: parsed.title || "",
      body: parsed.body || "",
      data: parsed.data || {}
    };
    const fcmPayloadSize = JSON.stringify(fcmPayload).length;
    if (fcmPayloadSize > MAX_FCM_PAYLOAD_SIZE) {
      completePerformanceTracking(performanceTracker, req, 413);
      logApiResponse(requestId, 413, Date.now() - performanceTracker.startTime, undefined, correlationId);
      logError('FCM payload too large', undefined, ErrorCategory.VALIDATION, ErrorSeverity.MEDIUM, {
        fcmPayloadSize,
        maxSize: MAX_FCM_PAYLOAD_SIZE,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "FCM payload too large",
        message: `FCM payload size ${fcmPayloadSize} bytes exceeds maximum allowed size of ${MAX_FCM_PAYLOAD_SIZE} bytes`
      }), {
        status: 413,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    // Apply rate limiting for authenticated users
    if (parsed.userId) {
      const userRateLimit = await _checkUserRateLimit(parsed.userId);
      if (!userRateLimit.allowed) {
        completePerformanceTracking(performanceTracker, req, 429, parsed.userId);
        logApiResponse(requestId, 429, Date.now() - performanceTracker.startTime, parsed.userId, correlationId);
        logWarning('User rate limit exceeded', {
          userId: parsed.userId,
          remaining: userRateLimit.remaining,
          correlationId
        }, correlationId);
        return createRateLimitResponse(userRateLimit);
      }
      const dailyLimit = await checkDailyNotificationLimit(parsed.userId);
      if (!dailyLimit.allowed) {
        completePerformanceTracking(performanceTracker, req, 429, parsed.userId);
        logApiResponse(requestId, 429, Date.now() - performanceTracker.startTime, parsed.userId, correlationId);
        logWarning('Daily notification limit exceeded', {
          userId: parsed.userId,
          remaining: dailyLimit.remaining,
          correlationId
        }, correlationId);
        return createRateLimitResponse(dailyLimit);
      }
    } else if (!authorizeServiceRole(req.headers.get("authorization"), serviceRoleKey).authorized) {
      // Only an exact match to the configured secret bypasses the anonymous IP limit.
      // Merely having a JWT or claiming service_role is insufficient.
      // Apply IP-based rate limiting for broadcast notifications (userId = null)
      const clientIP = getClientIP(req);
      const ipRateLimit = await checkIpRateLimit(clientIP);
      if (!ipRateLimit.allowed) {
        completePerformanceTracking(performanceTracker, req, 429);
        logApiResponse(requestId, 429, Date.now() - performanceTracker.startTime, undefined, correlationId);
        logWarning('IP rate limit exceeded for broadcast', {
          clientIP,
          remaining: ipRateLimit.remaining,
          correlationId
        }, correlationId);
        return createRateLimitResponse(ipRateLimit);
      }
    }
    const preferences = await getUserPreferences(parsed.userId);
    if (!preferences.push_enabled) {
      completePerformanceTracking(performanceTracker, req, 403, parsed.userId || undefined);
      logApiResponse(requestId, 403, Date.now() - performanceTracker.startTime, parsed.userId || undefined, correlationId);
      logInfo('Push notifications disabled for user', {
        userId: parsed.userId,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "Push notifications disabled for user"
      }), {
        status: 403,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    if (!parsed.quietHoursOverride && isWithinQuietHours(preferences)) {
      completePerformanceTracking(performanceTracker, req, 409, parsed.userId || undefined);
      logApiResponse(requestId, 409, Date.now() - performanceTracker.startTime, parsed.userId || undefined, correlationId);
      logInfo('Notification blocked during quiet hours', {
        userId: parsed.userId,
        quietHoursStart: preferences.quiet_hours_start,
        quietHoursEnd: preferences.quiet_hours_end,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "Notification blocked during quiet hours"
      }), {
        status: 409,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    let tokens = [];
    const derivedPlatform = parsed.target_device_types?.length === 1 ? parsed.target_device_types[0] : "all";
    if (parsed.userId) {
      tokens = await getActiveTokens(parsed.userId, parsed.target_device_types);
    } else if (parsed.tokens?.length) {
      tokens = normalizeTokensFromPayload(parsed.tokens);
      if (parsed.target_device_types?.length) {
        tokens = tokens.filter((token)=>!token.device_type || parsed.target_device_types.includes(token.device_type));
      }
    }
    const dedupedTokens = dedupeTokens(tokens);
    if (dedupedTokens.length === 0) {
      completePerformanceTracking(performanceTracker, req, 404, parsed.userId || undefined);
      logApiResponse(requestId, 404, Date.now() - performanceTracker.startTime, parsed.userId || undefined, correlationId);
      const noTokenMessage = parsed.userId ? "No active FCM tokens for user" : "No FCM tokens available for broadcast";
      logWarning(noTokenMessage, {
        userId: parsed.userId,
        totalTokens: tokens.length,
        activeTokens: dedupedTokens.length,
        tokensProvided: parsed.tokens?.length ?? 0,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: noTokenMessage
      }), {
        status: 404,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    const deviceTypeCounts = dedupedTokens.reduce((acc, t)=>{
      const key = (t.device_type ?? "unknown").toString();
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    logInfo("Token selection summary", {
      correlationId,
      totalTokensInitial: tokens.length,
      totalTokensAfterFilter: dedupedTokens.length,
      targetDeviceTypes: parsed.target_device_types,
      deviceTypeCounts,
      sampleTokens: dedupedTokens.slice(0, 3).map((t)=>({
          id: t.id,
          device_type: t.device_type,
          locale: t.locale,
          tokenSuffix: t.token.slice(-6)
        }))
    }, correlationId);
    console.log("[SFCM] Token selection", {
      correlationId,
      totalTokensInitial: tokens.length,
      totalTokensAfterFilter: dedupedTokens.length,
      deviceTypeCounts,
      targetDeviceTypes: parsed.target_device_types
    });
    let template;
    try {
      template = parsed.templateName || parsed.templateId ? await resolveTemplate(parsed) : null;
    } catch (error) {
      completePerformanceTracking(performanceTracker, req, 404, parsed.userId || undefined);
      logApiResponse(requestId, 404, Date.now() - performanceTracker.startTime, parsed.userId || undefined, correlationId);
      logError('Template resolution failed', error instanceof Error ? error : new Error(String(error)), ErrorCategory.BUSINESS_LOGIC, ErrorSeverity.MEDIUM, {
        templateId: parsed.templateId,
        templateName: parsed.templateName,
        userId: parsed.userId,
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "Notification template not found or inactive"
      }), {
        status: 404,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    const title = template ? renderTemplate(template.title_template, parsed.data ?? {}) : parsed.title;
    const bodyText = template ? renderTemplate(template.body_template, parsed.data ?? {}) : parsed.body;
    // Handle translation flow if enabled
    let notificationResults = [];
    let overallSuccess = false;
    // Get distinct target locales from tokens (skip source locale)
    let targetLocales = [];
    if (parsed.userId) {
      // For individual user notifications
      const { data: localesData, error: localesError } = await supabase.rpc("get_user_target_locales", {
        p_user_id: parsed.userId,
        p_target_device_types: parsed.target_device_types ?? null
      });
      if (localesError) {
        logWarning('Failed to get target locales for user', {
          userId: parsed.userId,
          error: localesError.message,
          correlationId
        }, correlationId);
        targetLocales = [];
      } else {
        targetLocales = (localesData || []).map((row)=>row.locale).filter((locale)=>locale && locale !== parsed.locale);
      }
    }
    const shouldTranslate = parsed.translate && targetLocales.length > 0;
    if (parsed.translate && !shouldTranslate) {
      logInfo("Translation skipped (no target locales)", {
        correlationId,
        sourceLocale: parsed.locale,
        userId: parsed.userId,
        targetDeviceTypes: parsed.target_device_types
      }, correlationId);
    }
    if (shouldTranslate) {
      logInfo("Translation flow start", {
        correlationId,
        sourceLocale: parsed.locale,
        targetLocales,
        userId: parsed.userId,
        targetDeviceTypes: parsed.target_device_types
      }, correlationId);
      console.log("[SFCM] Translation flow start", {
        correlationId,
        sourceLocale: parsed.locale,
        targetLocales,
        userId: parsed.userId
      });
      // Get tokens grouped by locale
      const tokensByLocale = await getTokensGroupedByLocale(parsed.userId, parsed.target_device_types);
      logInfo("Tokens grouped by locale", {
        correlationId,
        locales: Array.from(tokensByLocale.entries()).map(([loc, list])=>({
            locale: loc,
            count: list.length
          }))
      }, correlationId);
      console.log("[SFCM] Tokens by locale", Array.from(tokensByLocale.entries()).map(([loc, list])=>({
          locale: loc,
          count: list.length
        })));
      if (targetLocales.length === 0) {
        logWarning('No target locales for translation', {
          userId: parsed.userId,
          correlationId
        }, correlationId);
      } else {
        // Translate content for all target locales
        const translations = await translateNotificationBatch(targetLocales, title, bodyText, parsed.data ?? {}, correlationId);
        // Send notifications for each locale group
        for (const [locale, tokens] of tokensByLocale){
          if (!translations.has(locale)) {
            logWarning(`No translation available for locale: ${locale}`, {
              userId: parsed.userId,
              correlationId
            }, correlationId);
            continue;
          }
          const translation = translations.get(locale);
          const localeTokens = dedupeTokens(tokens);
          if (localeTokens.length === 0) continue;
          // Create notification record for this locale
          const notificationRecord = parsed.notificationId ? {
            id: parsed.notificationId
          } : await createNotificationRecord({
            userId: parsed.userId,
            templateId: template?.id ?? null,
            title: translation.title,
            body: translation.body,
            category: parsed.category ?? template?.category ?? "general",
            priority: parsed.priority,
            requestPayload: parsed,
            tokenCount: localeTokens.length,
            translationLocale: locale,
            platform: derivedPlatform,
            locale
          });
          const dataPayload = {
            ...translation.data ?? {},
            category: parsed.category ?? template?.category ?? "general",
            priority: parsed.priority,
            requestId: parsed.requestId ?? notificationRecord.id,
            locale
          };
          applyDeepLinkMetadata(dataPayload, rawDeepLink, {
            userId: parsed.userId,
            correlationId
          });
          logInfo("Deep link payload per-locale (translation)", {
            locale,
            rawDeepLink,
            deep_link: dataPayload.deep_link,
            external_url: dataPayload.external_url,
            open_in_browser: dataPayload.open_in_browser,
            link_type: dataPayload.link_type,
            requestId: parsed.requestId ?? notificationRecord.id,
            correlationId
          }, correlationId);
          console.log("[SFCM] Locale payload (translation)", {
            correlationId,
            locale,
            linkSummary: summarizeLinkFields(rawDeepLink, dataPayload),
            tokenCount: localeTokens.length
          });
          logInfo("Prepared FCM send (translation locale)", {
            correlationId,
            locale,
            tokenCount: localeTokens.length,
            dataKeys: Object.keys(dataPayload),
            linkSummary: summarizeLinkFields(rawDeepLink, dataPayload),
            titleLength: translation.title?.length ?? 0,
            bodyLength: translation.body?.length ?? 0,
            priority: parsed.priority
          }, correlationId);
          console.log("[SFCM] Send FCM (translation)", {
            correlationId,
            locale,
            tokenCount: localeTokens.length,
            linkSummary: summarizeLinkFields(rawDeepLink, dataPayload),
            titleLength: translation.title?.length ?? 0,
            bodyLength: translation.body?.length ?? 0
          });
          try {
            const sendResult = await sendMulticast(localeTokens, {
              title: translation.title,
              body: translation.body,
              data: toFcmData(dataPayload),
              priority: parsed.priority
            }, {
              correlationId,
              notificationId: notificationRecord.id,
              locale,
              linkSummary: summarizeLinkFields(rawDeepLink, dataPayload)
            });
            if (sendResult.invalidTokenIds.length) {
              await deactivateTokens(sendResult.invalidTokenIds);
            }
            await logDeliveryResults(notificationRecord.id, parsed.userId, sendResult.logs);
            await finalizeNotification(notificationRecord.id, {
              tokensTargeted: localeTokens.length,
              successCount: sendResult.successCount,
              failureCount: sendResult.failureCount,
              failureReasons: sendResult.failureReasons,
              messageIds: sendResult.messageIds
            }, parsed);
            notificationResults.push({
              locale,
              notificationId: notificationRecord.id,
              tokensTargeted: localeTokens.length,
              tokensSuccessful: sendResult.successCount,
              tokensFailed: sendResult.failureCount,
              success: sendResult.successCount > 0
            });
            if (sendResult.successCount > 0) {
              overallSuccess = true;
            }
            logInfo("FCM send result (translation locale)", {
              correlationId,
              locale,
              tokenCount: localeTokens.length,
              successCount: sendResult.successCount,
              failureCount: sendResult.failureCount,
              invalidTokenIds: sendResult.invalidTokenIds.length,
              failureReasons: sendResult.failureReasons
            }, correlationId);
            console.log("[SFCM] FCM result (translation)", {
              correlationId,
              locale,
              tokenCount: localeTokens.length,
              successCount: sendResult.successCount,
              failureCount: sendResult.failureCount,
              invalidTokenIds: sendResult.invalidTokenIds.length,
              failureReasons: sendResult.failureReasons
            });
          } catch (error) {
            logError(`FCM multicast failed for locale ${locale}`, error instanceof Error ? error : new Error(String(error)), ErrorCategory.EXTERNAL_API, ErrorSeverity.HIGH, {
              tokenCount: localeTokens.length,
              priority: parsed.priority,
              correlationId
            }, correlationId);
            notificationResults.push({
              locale,
              notificationId: notificationRecord.id,
              tokensTargeted: localeTokens.length,
              tokensSuccessful: 0,
              tokensFailed: localeTokens.length,
              success: false,
              error: "Failed to send notification via FCM"
            });
          }
        }
      }
    } else {
      // Original non-translation flow (backward compatibility)
      const notificationRecord = parsed.notificationId ? {
        id: parsed.notificationId
      } : await createNotificationRecord({
        userId: parsed.userId,
        templateId: template?.id ?? null,
        title,
        body: bodyText,
        category: parsed.category ?? template?.category ?? "general",
        priority: parsed.priority,
        requestPayload: parsed,
        tokenCount: dedupedTokens.length,
        platform: derivedPlatform,
        locale: parsed.locale
      });
      const dataPayload = {
        ...parsed.data ?? {},
        category: parsed.category ?? template?.category ?? "general",
        priority: parsed.priority,
        requestId: parsed.requestId ?? notificationRecord.id,
        locale: parsed.locale
      };
      applyDeepLinkMetadata(dataPayload, rawDeepLink, {
        userId: parsed.userId,
        correlationId
      });
      logInfo("Deep link payload (non-translation)", {
        rawDeepLink,
        deep_link: dataPayload.deep_link,
        external_url: dataPayload.external_url,
        open_in_browser: dataPayload.open_in_browser,
        link_type: dataPayload.link_type,
        requestId: parsed.requestId ?? notificationRecord.id,
        correlationId
      }, correlationId);
      console.log("[SFCM] Payload (non-translation)", {
        correlationId,
        locale: parsed.locale,
        linkSummary: summarizeLinkFields(rawDeepLink, dataPayload),
        tokenCount: dedupedTokens.length
      });
      logInfo("Prepared FCM send (non-translation)", {
        correlationId,
        locale: parsed.locale,
        tokenCount: dedupedTokens.length,
        dataKeys: Object.keys(dataPayload),
        linkSummary: summarizeLinkFields(rawDeepLink, dataPayload),
        titleLength: title?.length ?? 0,
        bodyLength: bodyText?.length ?? 0,
        priority: parsed.priority
      }, correlationId);
      console.log("[SFCM] Send FCM (non-translation)", {
        correlationId,
        locale: parsed.locale,
        tokenCount: dedupedTokens.length,
        linkSummary: summarizeLinkFields(rawDeepLink, dataPayload),
        titleLength: title?.length ?? 0,
        bodyLength: bodyText?.length ?? 0
      });
      let sendResult;
      try {
        sendResult = await sendMulticast(dedupedTokens, {
          title,
          body: bodyText,
          data: toFcmData(dataPayload),
          priority: parsed.priority
        }, {
          correlationId,
          notificationId: notificationRecord.id,
          locale: parsed.locale,
          linkSummary: summarizeLinkFields(rawDeepLink, dataPayload)
        });
      } catch (error) {
        completePerformanceTracking(performanceTracker, req, 500, parsed.userId || undefined);
        logApiResponse(requestId, 500, Date.now() - performanceTracker.startTime, parsed.userId || undefined, correlationId);
        logError('FCM multicast failed', error instanceof Error ? error : new Error(String(error)), ErrorCategory.EXTERNAL_API, ErrorSeverity.HIGH, {
          tokenCount: dedupedTokens.length,
          priority: parsed.priority,
          correlationId
        }, correlationId);
        return createSecureResponse(JSON.stringify({
          error: "Failed to send notification via FCM"
        }), {
          status: 500,
          headers: {
            ...cors,
            "Content-Type": "application/json"
          }
        });
      }
      if (sendResult.invalidTokenIds.length) {
        await deactivateTokens(sendResult.invalidTokenIds);
      }
      await logDeliveryResults(notificationRecord.id, parsed.userId, sendResult.logs);
      await finalizeNotification(notificationRecord.id, {
        tokensTargeted: dedupedTokens.length,
        successCount: sendResult.successCount,
        failureCount: sendResult.failureCount,
        failureReasons: sendResult.failureReasons,
        messageIds: sendResult.messageIds
      }, parsed);
      notificationResults = [
        {
          notificationId: notificationRecord.id,
          tokensTargeted: dedupedTokens.length,
          tokensSuccessful: sendResult.successCount,
          tokensFailed: sendResult.failureCount,
          success: sendResult.successCount > 0
        }
      ];
      overallSuccess = sendResult.successCount > 0;
      logInfo("FCM send result (non-translation)", {
        correlationId,
        tokenCount: dedupedTokens.length,
        successCount: sendResult.successCount,
        failureCount: sendResult.failureCount,
        invalidTokenIds: sendResult.invalidTokenIds.length,
        failureReasons: sendResult.failureReasons
      }, correlationId);
      console.log("[SFCM] FCM result (non-translation)", {
        correlationId,
        tokenCount: dedupedTokens.length,
        successCount: sendResult.successCount,
        failureCount: sendResult.failureCount,
        invalidTokenIds: sendResult.invalidTokenIds.length,
        failureReasons: sendResult.failureReasons
      });
    }
    await invokeTokenCleanup();
    const statusCode = overallSuccess ? 200 : notificationResults.length > 0 ? 207 : 500;
    completePerformanceTracking(performanceTracker, req, statusCode, parsed.userId || undefined);
    logApiResponse(requestId, statusCode, Date.now() - performanceTracker.startTime, parsed.userId || undefined, correlationId);
    const hasDeepLink = rawDeepLink !== undefined && rawDeepLink !== null && (typeof rawDeepLink !== "string" || rawDeepLink.trim().length > 0);
    const deepLinkSource = parsed.deep_link ? "top_level" : deepLinkFromData ? "data" : "none";
    logInfo('FCM notification with deep_link', {
      userId: parsed.userId,
      hasDeepLink,
      deepLink: rawDeepLink,
      deepLinkSource,
      correlationId
    }, correlationId);
    logInfo('FCM notification processing completed', {
      userId: parsed.userId,
      translate: parsed.translate,
      locale: parsed.locale,
      targetLocales: targetLocales,
      targetDeviceTypes: parsed.target_device_types,
      locales: parsed.translate ? notificationResults.map((r)=>r.locale).filter((locale)=>locale !== undefined) : undefined,
      notificationCount: notificationResults.length,
      totalTokensTargeted: notificationResults.reduce((sum, r)=>sum + r.tokensTargeted, 0),
      totalTokensSuccessful: notificationResults.reduce((sum, r)=>sum + r.tokensSuccessful, 0),
      totalTokensFailed: notificationResults.reduce((sum, r)=>sum + r.tokensFailed, 0),
      success: overallSuccess
    }, correlationId);
    return createSecureResponse(JSON.stringify({
      success: overallSuccess,
      translate: parsed.translate,
      locale: parsed.locale,
      target_locales: targetLocales,
      results: notificationResults
    }), {
      status: statusCode,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    completePerformanceTracking(performanceTracker, req, 500, undefined);
    logApiResponse(requestId, 500, Date.now() - performanceTracker.startTime, undefined, correlationId);
    if (error instanceof z.ZodError) {
      logError('Validation error in catch block', error, ErrorCategory.VALIDATION, ErrorSeverity.MEDIUM, {
        correlationId
      }, correlationId);
      return createSecureResponse(JSON.stringify({
        error: "Validation failed",
        details: error.errors
      }), {
        status: 422,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    logFatal('Unhandled error in send-fcm-notification', error instanceof Error ? error : new Error(String(error)), ErrorCategory.SYSTEM, {
      correlationId
    }, correlationId);
    console.error("[send-fcm-notification] fatal error", {
      correlationId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return createSecureResponse(JSON.stringify({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "Unknown error",
      correlationId
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
async function getUserPreferences(userId) {
  // For broadcast notifications (userId = null), return default preferences
  if (!userId) {
    return DEFAULT_PREFERENCES;
  }
  const { data, error } = await supabase.from("user_notification_preferences").select("push_enabled, quiet_hours_start, quiet_hours_end, marketing_enabled, transactional_enabled, priority_threshold").eq("user_id", userId).maybeSingle();
  if (error) {
    console.warn("user_notification_preferences unavailable, defaulting", error.message);
    return DEFAULT_PREFERENCES;
  }
  if (!data) return DEFAULT_PREFERENCES;
  return data;
}
function isWithinQuietHours(preferences, referenceDate = new Date()) {
  if (!preferences.quiet_hours_start || !preferences.quiet_hours_end) {
    return false;
  }
  const startMinutes = toMinutes(preferences.quiet_hours_start);
  const endMinutes = toMinutes(preferences.quiet_hours_end);
  const currentMinutes = referenceDate.getUTCHours() * 60 + referenceDate.getUTCMinutes();
  if (startMinutes === null || endMinutes === null) return false;
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}
function toMinutes(value) {
  const [hours, minutes] = value.split(":").map((part)=>Number(part));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}
async function getActiveTokens(userId, deviceTypes) {
  // For broadcast notifications (userId = null), return empty array
  // Broadcast notifications should not call this function directly
  if (!userId) {
    return [];
  }
  let query = supabase.from("user_fcm_tokens").select("id, token, device_type, locale").eq("user_id", userId).eq("is_active", true);
  if (deviceTypes && deviceTypes.length > 0) {
    query = query.in("device_type", deviceTypes);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch user tokens: ${error.message}`);
  }
  return data ?? [];
}
async function getTokensGroupedByLocale(userId, deviceTypes) {
  // For broadcast notifications (userId = null), return empty map
  // Broadcast notifications should not call this function directly
  if (!userId) {
    return new Map();
  }
  const tokens = await getActiveTokens(userId, deviceTypes);
  const grouped = new Map();
  for (const token of tokens){
    const locale = token.locale || 'en'; // Default to 'en' if no locale specified
    if (!grouped.has(locale)) {
      grouped.set(locale, []);
    }
    grouped.get(locale).push(token);
  }
  return grouped;
}
function normalizeTokensFromPayload(tokens) {
  return tokens.map((token)=>{
    if (typeof token === "string") {
      return {
        token,
        id: null,
        device_type: null,
        locale: null
      };
    }
    return {
      token: token.token,
      id: token.id ?? null,
      device_type: token.device_type ?? null,
      locale: token.locale ?? null
    };
  });
}
function dedupeTokens(tokens) {
  const seen = new Map();
  for (const token of tokens){
    if (!seen.has(token.token)) {
      seen.set(token.token, token);
    }
  }
  return Array.from(seen.values());
}
async function resolveTemplate(payload) {
  let builder = supabase.from("notification_templates").select("id, name, title_template, body_template, data_schema, category").eq("is_active", true).limit(1);
  if (payload.templateId) {
    builder = builder.eq("id", payload.templateId);
  } else if (payload.templateName) {
    builder = builder.eq("name", payload.templateName);
  }
  const { data, error } = await builder.maybeSingle();
  if (error || !data) {
    throw new Error("Notification template not found or inactive");
  }
  return data;
}
function renderTemplate(template, data) {
  return template.replace(/{{\s*([^}\s]+)(?:\s*\|\s*([^}]+))?\s*}}/g, (_, path, defaultValue)=>{
    const value = resolvePath(data, path);
    if (value === undefined || value === null || value === "") {
      return defaultValue ?? "";
    }
    return String(value);
  });
}
function resolvePath(data, path) {
  return path.split(".").reduce((acc, key)=>{
    if (acc && typeof acc === "object" && key in acc) {
      return acc[key];
    }
    return undefined;
  }, data);
}
async function createNotificationRecord(params) {
  const { data, error } = await supabase.from("notifications").insert({
    user_id: params.userId,
    template_id: params.templateId,
    title: params.title,
    body: params.body,
    category: params.category,
    priority: params.priority,
    platform: params.platform ?? null,
    locale: params.locale ?? null,
    status: "pending",
    tokens_targeted: params.tokenCount,
    metadata: {
      request: params.requestPayload,
      translation: params.translationLocale ? {
        locale: params.translationLocale
      } : params.requestPayload.locale ? {
        locale: params.requestPayload.locale
      } : undefined
    }
  }).select("id").single();
  if (error || !data) {
    throw new Error(`Failed to insert notification record: ${error?.message}`);
  }
  return data;
}
async function finalizeNotification(notificationId, result, requestPayload) {
  const nowIso = new Date().toISOString();
  const status = result.successCount > 0 ? "sent" : "failed";
  const { error } = await supabase.from("notifications").update({
    status,
    sent_at: nowIso,
    delivered_at: result.successCount > 0 ? nowIso : null,
    failed_at: result.failureCount > 0 && result.successCount === 0 ? nowIso : null,
    failure_reason: result.failureCount > 0 ? Object.keys(result.failureReasons)[0] ?? null : null,
    tokens_targeted: result.tokensTargeted,
    tokens_successful: result.successCount,
    tokens_failed: result.failureCount,
    fcm_message_id: result.messageIds[0] ?? null,
    metadata: {
      request: requestPayload,
      delivery: {
        messageIds: result.messageIds,
        failureReasons: result.failureReasons
      }
    }
  }).eq("id", notificationId);
  if (error) {
    console.error("Failed to finalize notification", {
      notificationId,
      error
    });
  }
}
async function deactivateTokens(tokenIds) {
  if (tokenIds.length === 0) return;
  const { error } = await supabase.from("user_fcm_tokens").update({
    is_active: false
  }).in("id", tokenIds);
  if (error) {
    console.error("Failed to deactivate tokens", error);
  }
}
async function sendMulticast(tokens, payload, logContext) {
  const chunks = [];
  for(let i = 0; i < tokens.length; i += MAX_FCM_BATCH){
    chunks.push(tokens.slice(i, i + MAX_FCM_BATCH));
  }
  let successCount = 0;
  let failureCount = 0;
  const invalidTokenIds = [];
  const failureReasons = {};
  const messageIds = [];
  const logs = [];
  const saveProgress = async () => {
    if (!logContext?.notificationId) return;
    const { error } = await supabase.from("notifications").update({
      tokens_successful: successCount,
      tokens_failed: failureCount
    }).eq("id", logContext.notificationId);
    if (error) logError("Failed to save partial FCM progress", new Error(error.message), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {
      notificationId: logContext.notificationId, successCount, failureCount
    }, logContext.correlationId);
  };
  let chunkIndex = 0;
  for (const chunk of chunks){
    const chunkId = `${chunkIndex + 1}/${chunks.length}`;
    logInfo("FCM chunk dispatch", {
      correlationId: logContext?.correlationId,
      locale: logContext?.locale,
      chunkId,
      tokenCount: chunk.length,
      deviceTypes: chunk.reduce((acc, t)=>{
        const key = (t.device_type ?? "unknown").toString();
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      linkSummary: logContext?.linkSummary,
      titleLength: payload.title?.length ?? 0,
      bodyLength: payload.body?.length ?? 0,
      dataKeys: Object.keys(payload.data),
      priority: payload.priority
    }, logContext?.correlationId);
    console.log("[SFCM] Chunk dispatch", {
      correlationId: logContext?.correlationId,
      locale: logContext?.locale,
      chunkId,
      tokenCount: chunk.length,
      deviceTypes: chunk.reduce((acc, t)=>{
        const key = (t.device_type ?? "unknown").toString();
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      linkSummary: logContext?.linkSummary,
      dataKeys: Object.keys(payload.data)
    });
    let response;
    try {
      response = await sendFCMMulticast(serviceAccount, chunk.map((t)=>t.token), {
        title: payload.title,
        body: payload.body,
        data: payload.data,
        priority: payload.priority
      });
    } catch (error) {
      // Treat an unexpected transport/auth error as a failure for the whole chunk,
      // but don’t crash the entire request (prevents 500s for broadcast calls).
      const reason = error instanceof Error ? error.message : String(error);
      logError('FCM transport error', error instanceof Error ? error : new Error(reason), ErrorCategory.EXTERNAL_API, ErrorSeverity.HIGH, {
        tokenCount: chunk.length,
        reason
      });
      failureReasons["transport_error"] = (failureReasons["transport_error"] ?? 0) + chunk.length;
      logs.push(...chunk.map((tokenRow)=>({
          tokenId: tokenRow.id ?? null,
          token: tokenRow.token,
          deviceType: tokenRow.device_type ?? null,
          status: "failure",
          errorCode: "transport_error",
          errorMessage: reason
        })));
      failureCount += chunk.length;
      await saveProgress();
      chunkIndex += 1;
      continue;
    }
    response.responses.forEach((res, index)=>{
      if (res.success) {
        successCount += 1;
        if (res.messageId) {
          messageIds.push(res.messageId);
        }
        logs.push({
          tokenId: chunk[index]?.id ?? null,
          token: chunk[index]?.token ?? null,
          deviceType: chunk[index]?.device_type ?? null,
          status: "success",
          messageId: res.messageId ?? null
        });
      } else {
        failureCount += 1;
        const errorCode = res.errorCode ?? "unknown";
        failureReasons[errorCode] = (failureReasons[errorCode] ?? 0) + 1;
        const tokenRow = chunk[index];
        if (isInvalidTokenError(errorCode) && tokenRow) {
          if (tokenRow.id) {
            invalidTokenIds.push(tokenRow.id);
          }
        }
        logs.push({
          tokenId: tokenRow?.id ?? null,
          token: tokenRow?.token ?? null,
          deviceType: tokenRow?.device_type ?? null,
          status: "failure",
          errorCode,
          errorMessage: res.error
        });
      }
    });
    await saveProgress();
    logInfo("FCM chunk completed", {
      correlationId: logContext?.correlationId,
      locale: logContext?.locale,
      chunkId,
      tokenCount: chunk.length,
      successCount: response.responses.filter((r)=>r.success).length,
      failureCount: response.responses.filter((r)=>!r.success).length,
      invalidTokenIds: invalidTokenIds.length,
      failureReasons
    }, logContext?.correlationId);
    console.log("[SFCM] Chunk completed", {
      correlationId: logContext?.correlationId,
      locale: logContext?.locale,
      chunkId,
      tokenCount: chunk.length,
      successCount: response.responses.filter((r)=>r.success).length,
      failureCount: response.responses.filter((r)=>!r.success).length,
      invalidTokenIds: invalidTokenIds.length,
      failureReasons
    });
    chunkIndex += 1;
  }
  return {
    successCount,
    failureCount,
    invalidTokenIds,
    failureReasons,
    messageIds,
    logs
  };
}
function toFcmData(data) {
  const result = {};
  for (const [key, value] of Object.entries(data)){
    if (value === undefined || value === null) continue;
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}
async function logDeliveryResults(notificationId, userId, logs) {
  if (!logs.length) return;
  // Use the secure logging function with token hashing
  const promises = logs.map((log)=>{
    return supabase.rpc("log_delivery_results_secure", {
      p_notification_id: notificationId,
      p_user_id: userId,
      p_token_id: log.tokenId,
      p_token: log.token,
      p_device_type: log.deviceType,
      p_status: log.status,
      p_error_code: log.errorCode,
      p_error_message: log.errorMessage,
      p_fcm_message_id: log.messageId ?? null
    });
  });
  try {
    // supabase-js resolves a failed rpc as { error } instead of rejecting, so a
    // rejected promise is not how an rpc failure arrives here — the catch below
    // only sees transport-level faults. Inspecting `error` on each settled result
    // is the only way these become visible. Every broadcast delivery log was lost
    // silently for months because nothing did (plan 035 §4.2).
    const results = await Promise.all(promises);
    const failures = results.filter((result)=>result?.error);
    if (failures.length) {
      const firstError = failures[0].error;
      logError("Failed to persist notification delivery logs", new Error(firstError?.message ?? String(firstError)), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {
        notificationId,
        attempted: logs.length,
        failed: failures.length,
        firstErrorCode: firstError?.code ?? null,
        firstErrorMessage: firstError?.message ?? null
      });
    }
  } catch (error) {
    logError("Failed to log delivery results securely", error instanceof Error ? error : new Error(String(error)), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {
      notificationId,
      attempted: logs.length
    });
  }
}
async function invokeTokenCleanup() {
  try {
    await supabase.rpc("cleanup_invalid_tokens", {
      p_max_age_days: DEFAULT_MAX_TOKEN_AGE_DAYS
    });
  } catch (error) {
    console.warn("cleanup_invalid_tokens rpc failed", error);
  }
}
