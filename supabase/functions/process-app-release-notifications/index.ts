import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { sendFcmNotification } from "../check-new-version/sendFcmNotification.ts";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const cronSecret = Deno.env.get("CRON_JOB_SECRET");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured");
}
if (!cronSecret) {
  throw new Error("CRON_JOB_SECRET must be configured");
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
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return jsonResponse({
      ok: true
    }, 200);
  }
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Method not allowed"
    }, 405);
  }
  const token = req.headers.get("x-system-token");
  if (token !== cronSecret) {
    return jsonResponse({
      error: "Unauthorized"
    }, 403);
  }
  try {
    const { data, error } = await supabase.rpc("lock_due_app_release_notifications", {
      p_limit: 1
    });
    if (error) {
      throw new Error(`Failed to lock app release notifications: ${error.message}`);
    }
    const jobs = data ?? [];
    if (jobs.length === 0) {
      return jsonResponse({
        success: true,
        processed: 0,
        results: []
      }, 200);
    }
    const results = [];
    for (const job of jobs){
      try {
        const sendResult = await sendFcmNotification(job.platform, job.version, job.delivery_state ?? {});
        await markJobAfterSend(job.id, sendResult);
        results.push({
          id: job.id,
          platform: job.platform,
          version: job.version,
          status: sendResult.completed || sendResult.noTokens ? "sent" : "pending",
          locale: sendResult.chunk?.locale ?? null,
          offset: sendResult.chunk?.offset ?? null,
          tokenCount: sendResult.chunk?.tokenCount ?? 0,
          completed: sendResult.completed,
          noTokens: sendResult.noTokens
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[process-app-release-notifications] Failed job ${job.id} (${job.platform} ${job.version}):`, error);
        await markJobFailed(job.id, message);
        results.push({
          id: job.id,
          platform: job.platform,
          version: job.version,
          status: "failed",
          error: message
        });
      }
    }
    return jsonResponse({
      success: true,
      processed: results.length,
      results
    }, 200);
  } catch (error) {
    console.error("[process-app-release-notifications] Unexpected error:", error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});
async function markJobAfterSend(id, result) {
  const completed = result.noTokens || result.completed;
  const update = {
    status: completed ? "sent" : "pending",
    delivery_state: result.nextState,
    failure_reason: null,
    sent_at: completed ? new Date().toISOString() : null
  };
  const { error } = await supabase.from("app_release_notifications").update(update).eq("id", id);
  if (error) {
    throw new Error(`Failed to update app release notification ${id}: ${error.message}`);
  }
}
async function markJobFailed(id, failureReason) {
  const { error } = await supabase.from("app_release_notifications").update({
    status: "failed",
    failure_reason: truncateFailureReason(failureReason)
  }).eq("id", id);
  if (error) {
    console.error(`[process-app-release-notifications] Failed to persist failure for job ${id}: ${error.message}`);
  }
}
function truncateFailureReason(failureReason) {
  const normalized = failureReason.trim();
  return normalized.length > 1000 ? normalized.slice(0, 1000) : normalized;
}
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json"
    },
    status
  });
}
