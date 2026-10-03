import { processLocalTimeJob, type LocalTimeJob } from "../_shared/local-time-broadcast.ts";
import { partitionScheduledJobs } from "../_shared/scheduled-notification-policy.ts";
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { sendBroadcast } from "../_shared/broadcast-notification.ts";
import { translateNotificationBatch } from "../_shared/translation-service.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { validateAndLogEnvironment, ENVIRONMENT_CONFIG } from "../_shared/env-validation.ts";
import { generateCorrelationId, createPerformanceTracker, completePerformanceTracking, logInfo, logWarning, logError, logFatal, ErrorCategory, ErrorSeverity, flushLogsOnExit } from "../_shared/monitoring.ts";
import type { AudienceFilter } from "../_shared/audience-filter.ts";
interface LockedScheduledJob {
  audience_filter?: AudienceFilter | null;
  id: string;
  audience?: "user" | "broadcast";
  user_id: string | null;
  title: string | null;
  body: string | null;
  template_id: string | null;
  template_name: string | null;
  data: Record<string, unknown> | null;
  priority: "low" | "normal" | "high";
  category: string | null;
  locale: string;
  translate: boolean;
  platform: "all" | "ios" | "android" | "web";
  target_user_ids: string[] | null;
}
// Validate environment variables
validateAndLogEnvironment();
const supabaseUrl = ENVIRONMENT_CONFIG.supabaseUrl;
const serviceRoleKey = ENVIRONMENT_CONFIG.supabaseServiceRoleKey;
const cronSecret = ENVIRONMENT_CONFIG.cronJobSecret;
const batchSize = ENVIRONMENT_CONFIG.scheduledNotificationsBatch;
const sendFunctionUrl = `${supabaseUrl}/functions/v1/send-fcm-notification`;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured");
}
if (!cronSecret) {
  throw new Error("CRON_JOB_SECRET env var is required for scheduled notification processing");
}
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
  // Generate correlation ID for request tracing
  const correlationId = generateCorrelationId();
  // Create performance tracker
  const performanceTracker = createPerformanceTracker('process-scheduled-notifications-fcm', 'main_handler', correlationId);
  if (req.method === "OPTIONS") {
    completePerformanceTracking(performanceTracker, req, 200);
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    completePerformanceTracking(performanceTracker, req, 405);
    logWarning('Method not allowed', {
      method: req.method,
      url: req.url,
      correlationId
    }, correlationId);
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const token = req.headers.get("x-system-token");
  if (token !== cronSecret) {
    completePerformanceTracking(performanceTracker, req, 403);
    logWarning('Unauthorized cron job access attempt', {
      token: token ? 'provided' : 'missing',
      correlationId
    }, correlationId);
    return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 403,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const invocationDeadline = Date.now() + 90_000;
  try {
    logInfo('Processing scheduled notifications', {
      batchSize,
      correlationId
    }, correlationId);
    const { data: jobs, error } = await supabase.rpc("lock_due_scheduled_notifications", {
      p_limit: batchSize
    });
    if (error) {
      completePerformanceTracking(performanceTracker, req, 500);
      logError('Failed to lock scheduled notifications', new Error(error.message), ErrorCategory.DATABASE, ErrorSeverity.HIGH, {
        batchSize,
        correlationId
      }, correlationId);
      throw new Error(`Failed to lock scheduled notifications: ${error.message}`);
    }
    const { data: localJobs, error: localLockError } = await supabase.rpc("lock_local_time_scheduled_notifications", { p_limit: batchSize });
    if (localLockError) throw new Error(localLockError.message);
    if ((!jobs || jobs.length === 0) && (!localJobs || localJobs.length === 0)) {
      completePerformanceTracking(performanceTracker, req, 200);
      logInfo('No scheduled notifications to process', {
        batchSize,
        correlationId
      }, correlationId);
      return new Response(JSON.stringify({
        success: true,
        processed: 0
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    logInfo('Locked scheduled notifications for processing', {
      jobCount: (jobs ?? []).length,
      correlationId
    }, correlationId);
    // Release extra broadcasts before doing any slow translation or FCM work.
    const { processJobs, deferredIds } = partitionScheduledJobs((jobs ?? []) as LockedScheduledJob[]);
    if (deferredIds.length) {
      const { error: releaseError } = await supabase.from("scheduled_notifications")
        .update({ status: "pending" }).in("id", deferredIds).eq("status", "processing");
      if (releaseError) throw new Error(`Failed to release deferred broadcasts: ${releaseError.message}`);
    }
    const results = [];
    for (const job of processJobs){
      const jobPerformanceTracker = createPerformanceTracker('process-scheduled-notifications-fcm', 'process_job', correlationId);
      try {
        logInfo('Processing scheduled notification job', {
          jobId: job.id,
          userId: job.user_id,
          templateId: job.template_id,
          templateName: job.template_name,
          priority: job.priority,
          correlationId
        }, correlationId);
        if (job.audience === "broadcast") {
          if (!job.title || !job.body) throw new Error("Scheduled broadcasts require explicit title and body; templates are not supported");
          const broadcast = await sendBroadcast({
            title: job.title, body: job.body, data: job.data ?? {},
            priority: job.priority, category: job.category ?? "general",
            locale: job.locale ?? "en", translate: job.translate ?? false,
            platform: job.platform ?? "all", target_user_ids: job.target_user_ids, audienceFilter: job.audience_filter
          }, correlationId, { supabase, fetch, translateNotificationBatch, sendFunctionUrl, serviceRoleKey, logWarning, captureLocaleErrors: true, respectDeliveryResults: true });
          const status = broadcast.overallSuccess ? "sent" : "failed";
          const failureReason = broadcast.noTokens ? "No active tokens found" : broadcast.failures.length
            ? JSON.stringify(broadcast.failures) : broadcast.overallSuccess ? null : "No broadcast locale was sent";
          await markScheduledNotification(job.id, status, failureReason, null);
          if (broadcast.overallSuccess) await maybeScheduleNext(job);
          results.push({ id: job.id, status });
          completePerformanceTracking(jobPerformanceTracker, req, broadcast.overallSuccess ? 200 : 500);
          continue;
        }
        const payload = buildSendPayload(job);
        const linkSummary = summarizeLinkFields(payload.data);
        logInfo('Dispatching scheduled payload to send-fcm-notification', {
          correlationId,
          jobId: job.id,
          userId: job.user_id,
          locale: payload.locale,
          translate: payload.translate,
          linkSummary
        }, correlationId);
        const response = await fetch(sendFunctionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-system-token": cronSecret,
            Authorization: `Bearer ${serviceRoleKey}`
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          const body = await response.text();
          completePerformanceTracking(jobPerformanceTracker, req, response.status);
          logError('send-fcm-notification failed', new Error(`HTTP ${response.status}: ${body}`), ErrorCategory.EXTERNAL_API, ErrorSeverity.HIGH, {
            jobId: job.id,
            userId: job.user_id,
            httpStatus: response.status,
            responseBody: body,
            correlationId
          }, correlationId);
          throw new Error(`send-fcm-notification failed: ${response.status} ${body}`);
        }
        const json = await response.json();
        await markScheduledNotification(job.id, "sent", null, json.notificationId);
        await maybeScheduleNext(job);
        completePerformanceTracking(jobPerformanceTracker, req, 200);
        logInfo('Successfully processed scheduled notification job', {
          jobId: job.id,
          userId: job.user_id,
          notificationId: json.notificationId,
          correlationId
        }, correlationId);
        results.push({
          id: job.id,
          status: "sent"
        });
      } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : String(jobError);
        completePerformanceTracking(jobPerformanceTracker, req, 500);
        logError('Failed to process scheduled notification job', jobError instanceof Error ? jobError : new Error(String(jobError)), ErrorCategory.BUSINESS_LOGIC, ErrorSeverity.MEDIUM, {
          jobId: job.id,
          userId: job.user_id,
          errorMessage: message,
          correlationId
        }, correlationId);
        results.push({
          id: job.id,
          status: "failed",
          error: message
        });
        await markScheduledNotification(job.id, "failed", message, null);
      }
    }
    for (const job of (localJobs ?? [])) {
      if (Date.now() >= invocationDeadline) break;
      try {
        await processLocalTimeJob({
          ...job, title: job.title ?? "", body: job.body ?? "", data: job.data ?? {},
          audienceFilter: job.audience_filter,
        } as LocalTimeJob, correlationId, {
          supabase, fetch, translateNotificationBatch, sendFunctionUrl, serviceRoleKey,
          logWarning, captureLocaleErrors: true, respectDeliveryResults: true,
        }, invocationDeadline);
        results.push({ id: job.id, status: "delivering" });
      } catch (error) {
        // Never mark a whole local-time job failed on a transient RPC error.
        logError('Local-time broadcast processing failed', error instanceof Error ? error : new Error(String(error)), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, { jobId: job.id }, correlationId);
      }
    }
    completePerformanceTracking(performanceTracker, req, 200);
    logInfo('Completed processing scheduled notifications', {
      totalJobs: (jobs ?? []).length + (localJobs ?? []).length,
      successfulJobs: results.filter((r)=>r.status === 'sent').length,
      failedJobs: results.filter((r)=>r.status === 'failed').length,
      correlationId
    }, correlationId);
    return new Response(JSON.stringify({
      success: true,
      processed: results.length,
      results
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    completePerformanceTracking(performanceTracker, req, 500);
    logFatal('Unhandled error in process-scheduled-notifications-fcm', error instanceof Error ? error : new Error(String(error)), ErrorCategory.SYSTEM, {
      correlationId
    }, correlationId);
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } finally{
    // Flush any remaining logs
    flushLogsOnExit();
  }
});
function buildSendPayload(job) {
  return {
    userId: job.user_id,
    templateId: job.template_id ?? undefined,
    templateName: job.template_name ?? undefined,
    title: job.title ?? undefined,
    body: job.body ?? undefined,
    data: job.data ?? job.template_data ?? {},
    priority: job.priority,
    category: job.category ?? undefined,
    requestId: job.id,
    quietHoursOverride: job.quiet_hours_override,
    locale: job.locale ?? 'en',
    translate: job.translate ?? false
  };
}
async function markScheduledNotification(id, status, failureReason, _notificationId) {
  try {
    const { error } = await supabase.from("scheduled_notifications").update({
      status,
      failure_reason: failureReason,
      last_attempt_at: new Date().toISOString()
    }).eq("id", id);
    if (error) {
      logError('Failed to update scheduled notification status', new Error(error.message), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {
        scheduledNotificationId: id,
        status,
        failureReason
      });
    }
  } catch (error) {
    logError('Exception in markScheduledNotification', error instanceof Error ? error : new Error(String(error)), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {
      scheduledNotificationId: id,
      status,
      failureReason
    });
  }
}
async function maybeScheduleNext(job) {
  if (job.recurrence === "none") return;
  try {
    const nextRun = computeNextRun(job.recurrence, job.schedule_at);
    if (!nextRun) return;
    logInfo('Scheduling next recurrence', {
      originalJobId: job.id,
      userId: job.user_id,
      recurrence: job.recurrence,
      nextRunAt: nextRun.toISOString()
    });
    const { error } = await supabase.from("scheduled_notifications").insert({
      user_id: job.user_id,
      audience: job.audience ?? "user",
      platform: job.platform ?? "all",
      target_user_ids: job.target_user_ids,
      audience_filter: job.audience_filter,
      created_by: job.created_by,
      template_id: job.template_id,
      template_name: job.template_name,
      template_data: job.template_data ?? {},
      title: job.title,
      body: job.body,
      data: job.data ?? {},
      priority: job.priority,
      category: job.category,
      schedule_at: nextRun.toISOString(),
      recurrence: job.recurrence,
      recurrence_data: job.recurrence_data,
      quiet_hours_override: job.quiet_hours_override,
      locale: job.locale ?? 'en',
      translate: job.translate ?? false
    });
    if (error) {
      logError('Failed to schedule recurrence', new Error(error.message), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {
        originalJobId: job.id,
        userId: job.user_id,
        recurrence: job.recurrence,
        nextRunAt: nextRun.toISOString()
      });
    }
  } catch (error) {
    logError('Exception in maybeScheduleNext', error instanceof Error ? error : new Error(String(error)), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {
      originalJobId: job.id,
      userId: job.user_id,
      recurrence: job.recurrence
    });
  }
}
function computeNextRun(recurrence, baseIso) {
  const base = new Date(baseIso);
  switch(recurrence){
    case "daily":
      return new Date(base.getTime() + 24 * 60 * 60 * 1000);
    case "weekly":
      return new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
    case "monthly":
      return new Date(base.getFullYear(), base.getMonth() + 1, base.getDate(), base.getHours(), base.getMinutes(), base.getSeconds());
    default:
      return null;
  }
}
function summarizeLinkFields(data) {
  if (!data) {
    return {
      hasData: false
    };
  }
  return {
    hasData: true,
    deep_link: data["deep_link"] ?? null,
    external_url: data["external_url"] ?? null,
    open_in_browser: data["open_in_browser"] ?? null,
    linkKeys: Object.keys(data).filter((key)=>key.toLowerCase().includes("link"))
  };
}
