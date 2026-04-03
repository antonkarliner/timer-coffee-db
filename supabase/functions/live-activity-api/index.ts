import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
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
const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}
function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}
function parseDurations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item)=>asInteger(item)).filter((item)=>item !== null && item > 0);
}
function parseDescriptions(value, expectedLength) {
  if (!Array.isArray(value)) return [];
  const cleaned = value.map((item)=>typeof item === "string" ? item.trim() : "").filter((item)=>item.length > 0);
  if (cleaned.length === expectedLength) return cleaned;
  if (cleaned.length === 0) return [];
  if (cleaned.length > expectedLength) {
    return cleaned.slice(0, expectedLength);
  }
  const padded = [
    ...cleaned
  ];
  while(padded.length < expectedLength){
    padded.push(cleaned[cleaned.length - 1]);
  }
  return padded;
}
function toAction(pathname, body) {
  const bodyAction = asString(body.action).toLowerCase();
  if (bodyAction) return bodyAction;
  if (pathname.endsWith("/v1/live-activities/sessions/start")) return "start";
  if (pathname.endsWith("/v1/live-activities/sessions/token")) return "token";
  if (pathname.endsWith("/v1/live-activities/sessions/pause")) return "pause";
  if (pathname.endsWith("/v1/live-activities/sessions/resume")) return "resume";
  if (pathname.endsWith("/v1/live-activities/sessions/end")) return "end";
  if (pathname.endsWith("/v1/live-activities/sessions/status")) return "status";
  return "";
}
async function getAuthenticatedUserId(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}
function parseBrewStartDate(value) {
  const asMs = asInteger(value);
  if (asMs === null || asMs <= 0) return null;
  const date = new Date(asMs);
  return Number.isNaN(date.valueOf()) ? null : date;
}
function parseDateMs(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function computeTimelineState(durations, elapsedTotalSeconds, status) {
  const totalDurationSeconds = durations.reduce((sum, value)=>sum + value, 0);
  const clampedElapsedTotal = clamp(elapsedTotalSeconds, 0, totalDurationSeconds);
  const isFinishedByStatus = status === "ended" || status === "stale";
  const isFinishedByTime = clampedElapsedTotal >= totalDurationSeconds;
  const isFinished = isFinishedByStatus || isFinishedByTime;
  let stepIndex = durations.length - 1;
  let stepElapsedSeconds = durations[stepIndex] ?? 0;
  if (!isFinished) {
    let remaining = clampedElapsedTotal;
    stepIndex = 0;
    while(stepIndex < durations.length - 1 && remaining >= durations[stepIndex]){
      remaining -= durations[stepIndex];
      stepIndex += 1;
    }
    stepElapsedSeconds = clamp(remaining, 0, durations[stepIndex]);
  }
  return {
    totalDurationSeconds,
    elapsedTotalSeconds: clampedElapsedTotal,
    currentStep: stepIndex + 1,
    stepTotalSeconds: durations[stepIndex] ?? 0,
    stepElapsedSeconds,
    isFinished
  };
}
async function cancelPendingEvents(sessionId) {
  const { error } = await supabase.from("live_activity_events").update({
    status: "cancelled",
    last_error: "cancelled_by_client",
    updated_at: new Date().toISOString()
  }).eq("session_id", sessionId).in("status", [
    "pending",
    "processing"
  ]);
  return error?.message ?? null;
}
async function handleStart(userId, body) {
  const brewSessionId = asString(body.brew_session_id).toLowerCase();
  if (!uuidV4Regex.test(brewSessionId)) {
    return jsonResponse(400, {
      error: "Invalid brew_session_id"
    });
  }
  const recipeId = asString(body.recipe_id);
  if (!recipeId) {
    return jsonResponse(400, {
      error: "recipe_id is required"
    });
  }
  const activityId = asString(body.activity_id);
  const activityPushToken = asString(body.activity_push_token);
  const fcmToken = asString(body.fcm_token);
  if (!activityId || !activityPushToken || !fcmToken) {
    return jsonResponse(400, {
      error: "activity_id, activity_push_token, and fcm_token are required"
    });
  }
  const stepDurationsSeconds = parseDurations(body.step_durations_seconds);
  if (stepDurationsSeconds.length === 0) {
    return jsonResponse(400, {
      error: "step_durations_seconds must be non-empty"
    });
  }
  const stepDescriptions = parseDescriptions(body.step_descriptions, stepDurationsSeconds.length);
  const brewStartDate = parseBrewStartDate(body.brew_start_ms);
  if (!brewStartDate) {
    return jsonResponse(400, {
      error: "Invalid brew_start_ms"
    });
  }
  const totalDurationSeconds = stepDurationsSeconds.reduce((sum, sec)=>sum + sec, 0);
  const expectedEndAt = new Date(brewStartDate.getTime() + totalDurationSeconds * 1000);
  const { data: sessionRow, error: upsertError } = await supabase.from("live_activity_sessions").upsert({
    brew_session_id: brewSessionId,
    user_id: userId,
    recipe_id: recipeId,
    recipe_name: asString(body.recipe_name) || "Brewing",
    device_type: "ios",
    fcm_token: fcmToken,
    activity_id: activityId,
    activity_push_token: activityPushToken,
    step_durations_seconds: stepDurationsSeconds,
    step_descriptions: stepDescriptions,
    brew_started_at: brewStartDate.toISOString(),
    total_duration_seconds: totalDurationSeconds,
    expected_end_at: expectedEndAt.toISOString(),
    status: "active",
    end_reason: null,
    paused_at: null,
    paused_elapsed_seconds: null,
    last_token_refresh_at: new Date().toISOString()
  }, {
    onConflict: "brew_session_id"
  }).select("id, expected_end_at").single();
  if (upsertError || !sessionRow) {
    return jsonResponse(500, {
      error: "Failed to upsert live activity session",
      details: upsertError?.message ?? "unknown_error"
    });
  }
  const { data: queuedCount, error: enqueueError } = await supabase.rpc("enqueue_live_activity_events", {
    p_session_id: sessionRow.id
  });
  if (enqueueError) {
    return jsonResponse(500, {
      error: "Failed to enqueue live activity events",
      details: enqueueError.message
    });
  }
  return jsonResponse(200, {
    ok: true,
    session_id: sessionRow.id,
    scheduled_events_count: queuedCount ?? 0,
    expected_end_at: sessionRow.expected_end_at
  });
}
async function handleToken(userId, body) {
  const brewSessionId = asString(body.brew_session_id).toLowerCase();
  if (!uuidV4Regex.test(brewSessionId)) {
    return jsonResponse(400, {
      error: "Invalid brew_session_id"
    });
  }
  const activityId = asString(body.activity_id);
  const activityPushToken = asString(body.activity_push_token);
  if (!activityId || !activityPushToken) {
    return jsonResponse(400, {
      error: "activity_id and activity_push_token are required"
    });
  }
  const fcmToken = asString(body.fcm_token);
  const updates = {
    activity_id: activityId,
    activity_push_token: activityPushToken,
    status: "active",
    last_token_refresh_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (fcmToken) {
    updates.fcm_token = fcmToken;
  }
  const { data, error } = await supabase.from("live_activity_sessions").update(updates).eq("brew_session_id", brewSessionId).eq("user_id", userId).select("id").maybeSingle();
  if (error) {
    return jsonResponse(500, {
      error: "Failed to refresh live activity token",
      details: error.message
    });
  }
  if (!data) {
    return jsonResponse(404, {
      error: "Live activity session not found"
    });
  }
  return jsonResponse(200, {
    ok: true,
    session_id: data.id
  });
}
async function handlePause(userId, body) {
  const brewSessionId = asString(body.brew_session_id).toLowerCase();
  if (!uuidV4Regex.test(brewSessionId)) {
    return jsonResponse(400, {
      error: "Invalid brew_session_id"
    });
  }
  const elapsedTotalSeconds = asInteger(body.elapsed_total_seconds);
  if (elapsedTotalSeconds === null || elapsedTotalSeconds < 0) {
    return jsonResponse(400, {
      error: "elapsed_total_seconds must be >= 0"
    });
  }
  const { data: session, error: sessionError } = await supabase.from("live_activity_sessions").select("id, total_duration_seconds, status").eq("brew_session_id", brewSessionId).eq("user_id", userId).maybeSingle();
  if (sessionError) {
    return jsonResponse(500, {
      error: "Failed to fetch live activity session",
      details: sessionError.message
    });
  }
  if (!session) {
    return jsonResponse(404, {
      error: "Live activity session not found"
    });
  }
  if (asString(session.status) === "ended" || asString(session.status) === "stale") {
    return jsonResponse(200, {
      ok: true,
      paused: false,
      reason: "session_already_finished"
    });
  }
  const cancelError = await cancelPendingEvents(session.id);
  if (cancelError) {
    return jsonResponse(500, {
      error: "Failed to cancel pending live activity events",
      details: cancelError
    });
  }
  const totalDurationSeconds = Math.max(asInteger(session.total_duration_seconds) ?? 0, 0);
  const clampedElapsed = clamp(elapsedTotalSeconds, 0, totalDurationSeconds);
  const { error: updateError } = await supabase.from("live_activity_sessions").update({
    status: "paused",
    paused_at: new Date().toISOString(),
    paused_elapsed_seconds: clampedElapsed,
    updated_at: new Date().toISOString()
  }).eq("id", session.id);
  if (updateError) {
    return jsonResponse(500, {
      error: "Failed to pause live activity session",
      details: updateError.message
    });
  }
  return jsonResponse(200, {
    ok: true,
    session_id: session.id,
    paused_elapsed_seconds: clampedElapsed
  });
}
async function handleResume(userId, body) {
  const brewSessionId = asString(body.brew_session_id).toLowerCase();
  if (!uuidV4Regex.test(brewSessionId)) {
    return jsonResponse(400, {
      error: "Invalid brew_session_id"
    });
  }
  const elapsedTotalSeconds = asInteger(body.elapsed_total_seconds);
  if (elapsedTotalSeconds === null || elapsedTotalSeconds < 0) {
    return jsonResponse(400, {
      error: "elapsed_total_seconds must be >= 0"
    });
  }
  const { data: session, error: sessionError } = await supabase.from("live_activity_sessions").select("id, step_durations_seconds, status").eq("brew_session_id", brewSessionId).eq("user_id", userId).maybeSingle();
  if (sessionError) {
    return jsonResponse(500, {
      error: "Failed to fetch live activity session",
      details: sessionError.message
    });
  }
  if (!session) {
    return jsonResponse(404, {
      error: "Live activity session not found"
    });
  }
  if (asString(session.status) === "ended" || asString(session.status) === "stale") {
    return jsonResponse(200, {
      ok: true,
      resumed: false,
      reason: "session_already_finished"
    });
  }
  const stepDurationsSeconds = parseDurations(session.step_durations_seconds);
  const totalDurationSeconds = stepDurationsSeconds.reduce((sum, value)=>sum + value, 0);
  if (totalDurationSeconds <= 0) {
    return jsonResponse(500, {
      error: "Live activity session has empty step schedule"
    });
  }
  const clampedElapsed = clamp(elapsedTotalSeconds, 0, totalDurationSeconds);
  const nowMs = Date.now();
  const brewStartedAtMs = nowMs - clampedElapsed * 1000;
  const expectedEndAtMs = brewStartedAtMs + totalDurationSeconds * 1000;
  const { error: updateError } = await supabase.from("live_activity_sessions").update({
    status: "active",
    brew_started_at: new Date(brewStartedAtMs).toISOString(),
    expected_end_at: new Date(expectedEndAtMs).toISOString(),
    total_duration_seconds: totalDurationSeconds,
    paused_at: null,
    paused_elapsed_seconds: null,
    updated_at: new Date().toISOString()
  }).eq("id", session.id);
  if (updateError) {
    return jsonResponse(500, {
      error: "Failed to resume live activity session",
      details: updateError.message
    });
  }
  const { data: queuedCount, error: enqueueError } = await supabase.rpc("enqueue_live_activity_events", {
    p_session_id: session.id
  });
  if (enqueueError) {
    return jsonResponse(500, {
      error: "Failed to enqueue live activity events on resume",
      details: enqueueError.message
    });
  }
  return jsonResponse(200, {
    ok: true,
    session_id: session.id,
    resumed_elapsed_seconds: clampedElapsed,
    scheduled_events_count: queuedCount ?? 0
  });
}
async function handleEnd(userId, body) {
  const brewSessionId = asString(body.brew_session_id).toLowerCase();
  if (!uuidV4Regex.test(brewSessionId)) {
    return jsonResponse(400, {
      error: "Invalid brew_session_id"
    });
  }
  const reason = asString(body.reason) || "completed";
  const { data: session, error: sessionError } = await supabase.from("live_activity_sessions").select("id, fcm_token, activity_push_token").eq("brew_session_id", brewSessionId).eq("user_id", userId).maybeSingle();
  if (sessionError) {
    return jsonResponse(500, {
      error: "Failed to fetch live activity session",
      details: sessionError.message
    });
  }
  if (!session) {
    return jsonResponse(200, {
      ok: true,
      ended: false
    });
  }
  const cancelError = await cancelPendingEvents(session.id);
  if (cancelError) {
    return jsonResponse(500, {
      error: "Failed to cancel pending live activity events",
      details: cancelError
    });
  }
  const hasTokens = asString(session.fcm_token).length > 0 && asString(session.activity_push_token).length > 0;
  if (hasTokens) {
    const { error: sessionUpdateError } = await supabase.from("live_activity_sessions").update({
      status: "active",
      end_reason: reason,
      paused_at: null,
      paused_elapsed_seconds: null,
      updated_at: new Date().toISOString()
    }).eq("id", session.id);
    if (sessionUpdateError) {
      return jsonResponse(500, {
        error: "Failed to update live activity session for end event",
        details: sessionUpdateError.message
      });
    }
    const { error: insertEndEventError } = await supabase.from("live_activity_events").insert({
      session_id: session.id,
      event_type: "end",
      scheduled_at: new Date().toISOString(),
      payload: {
        forced: true,
        reason
      },
      status: "pending"
    });
    if (insertEndEventError) {
      return jsonResponse(500, {
        error: "Failed to enqueue live activity end event",
        details: insertEndEventError.message
      });
    }
  } else {
    const { error: endUpdateError } = await supabase.from("live_activity_sessions").update({
      status: "ended",
      end_reason: reason,
      paused_at: null,
      paused_elapsed_seconds: null,
      updated_at: new Date().toISOString()
    }).eq("id", session.id);
    if (endUpdateError) {
      return jsonResponse(500, {
        error: "Failed to end live activity session",
        details: endUpdateError.message
      });
    }
  }
  return jsonResponse(200, {
    ok: true,
    session_id: session.id
  });
}
async function handleStatus(userId, body) {
  const brewSessionId = asString(body.brew_session_id).toLowerCase();
  if (!uuidV4Regex.test(brewSessionId)) {
    return jsonResponse(400, {
      error: "Invalid brew_session_id"
    });
  }
  const { data: session, error } = await supabase.from("live_activity_sessions").select("status, recipe_name, step_durations_seconds, step_descriptions, brew_started_at, expected_end_at, total_duration_seconds, paused_elapsed_seconds").eq("brew_session_id", brewSessionId).eq("user_id", userId).maybeSingle();
  if (error) {
    return jsonResponse(500, {
      error: "Failed to fetch live activity session status",
      details: error.message
    });
  }
  if (!session) {
    return jsonResponse(404, {
      error: "Live activity session not found"
    });
  }
  const durations = parseDurations(session.step_durations_seconds);
  if (durations.length === 0) {
    return jsonResponse(500, {
      error: "Live activity session has empty step schedule"
    });
  }
  const descriptions = parseDescriptions(session.step_descriptions, durations.length);
  const sessionStatus = asString(session.status) || "active";
  const isPaused = sessionStatus === "paused";
  const computedTotalDuration = durations.reduce((sum, value)=>sum + value, 0);
  const totalDurationSeconds = Math.max(asInteger(session.total_duration_seconds) ?? computedTotalDuration, computedTotalDuration);
  const brewStartMs = parseDateMs(session.brew_started_at);
  if (brewStartMs === null) {
    return jsonResponse(500, {
      error: "Invalid brew_started_at in live activity session"
    });
  }
  const serverNowMs = Date.now();
  const pausedElapsedSecondsRaw = asInteger(session.paused_elapsed_seconds);
  const pausedElapsedSeconds = pausedElapsedSecondsRaw !== null ? clamp(pausedElapsedSecondsRaw, 0, totalDurationSeconds) : null;
  const elapsedTotalSeconds = isPaused ? clamp(pausedElapsedSeconds ?? 0, 0, totalDurationSeconds) : clamp(Math.floor((serverNowMs - brewStartMs) / 1000), 0, totalDurationSeconds);
  const timeline = computeTimelineState(durations, elapsedTotalSeconds, sessionStatus);
  const stepDescription = descriptions[timeline.currentStep - 1] ?? descriptions[descriptions.length - 1] ?? "";
  const expectedEndMs = parseDateMs(session.expected_end_at) ?? brewStartMs + totalDurationSeconds * 1000;
  return jsonResponse(200, {
    status: sessionStatus,
    is_paused: isPaused,
    paused_elapsed_seconds: pausedElapsedSeconds,
    current_step: timeline.currentStep,
    total_steps: durations.length,
    step_elapsed_seconds: timeline.stepElapsedSeconds,
    step_total_seconds: timeline.stepTotalSeconds,
    step_description: stepDescription,
    recipe_name: asString(session.recipe_name) || "Brewing",
    brew_start_ms: brewStartMs,
    expected_end_ms: expectedEndMs,
    server_now_ms: serverNowMs,
    is_finished: timeline.isFinished
  });
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, {
      error: "Method not allowed"
    });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) {
    return jsonResponse(401, {
      error: "Unauthorized"
    });
  }
  let body = {};
  try {
    body = asRecord(await req.json());
  } catch  {
    body = {};
  }
  const action = toAction(new URL(req.url).pathname, body);
  try {
    if (action === "start") {
      return await handleStart(userId, body);
    }
    if (action === "token") {
      return await handleToken(userId, body);
    }
    if (action === "pause") {
      return await handlePause(userId, body);
    }
    if (action === "resume") {
      return await handleResume(userId, body);
    }
    if (action === "end") {
      return await handleEnd(userId, body);
    }
    if (action === "status") {
      return await handleStatus(userId, body);
    }
    return jsonResponse(400, {
      error: "Unsupported action"
    });
  } catch (error) {
    return jsonResponse(500, {
      error: "Internal Server Error",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});
