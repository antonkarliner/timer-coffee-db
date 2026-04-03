import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-system-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const cronSecret = Deno.env.get("CRON_JOB_SECRET");
const firebaseServiceAccount = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
const apnsTopic = Deno.env.get("LIVE_ACTIVITY_APNS_TOPIC") ?? "timer.coffee.push-type.liveactivity";
const appGroupId = Deno.env.get("LIVE_ACTIVITY_APP_GROUP_ID") ?? "group.timer.coffee";
const batchLimit = Math.max(1, Math.min(500, Number(Deno.env.get("LIVE_ACTIVITY_BATCH_SIZE") ?? "120")));
const maxAttempts = Math.max(1, Math.min(10, Number(Deno.env.get("LIVE_ACTIVITY_MAX_ATTEMPTS") ?? "3")));
const maxBoundaryLateMs = Math.max(0, Math.min(120_000, Number(Deno.env.get("LIVE_ACTIVITY_MAX_BOUNDARY_LATE_MS") ?? "30000")));
// ── Apple APNs direct push credentials ──
const apnsKeyId = Deno.env.get("APPLE_APNS_KEY_ID") ?? "";
const apnsTeamId = Deno.env.get("APPLE_APNS_TEAM_ID") ?? "";
const apnsPrivateKey = Deno.env.get("APPLE_APNS_PRIVATE_KEY") ?? "";
const useDirectApns = !!(apnsKeyId && apnsTeamId && apnsPrivateKey);
const APNS_HOST = "https://api.push.apple.com";
if (!supabaseUrl || !serviceRoleKey || !cronSecret || !firebaseServiceAccount) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_JOB_SECRET, and FIREBASE_SERVICE_ACCOUNT are required");
}
const serviceAccount = JSON.parse(firebaseServiceAccount);
if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT is missing required fields");
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
let cachedAccessToken = null;
let cachedAccessTokenExpiryMs = 0;
let cachedApnsJwt = null;
let cachedApnsJwtExpiryMs = 0;
function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
function base64UrlEncode(value) {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for(let i = 0; i < input.length; i++){
    binary += String.fromCharCode(input[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function pemToArrayBuffer(pem) {
  const normalized = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++){
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
// ── Firebase OAuth2 (RS256) ──
async function getFirebaseAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiryMs - 60_000) {
    return cachedAccessToken;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const jwtHeader = {
    alg: "RS256",
    typ: "JWT"
  };
  const jwtClaimSet = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  const unsignedJwt = `${base64UrlEncode(JSON.stringify(jwtHeader))}.${base64UrlEncode(JSON.stringify(jwtClaimSet))}`;
  const cryptoKey = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(serviceAccount.private_key), {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256"
  }, false, [
    "sign"
  ]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsignedJwt));
  const assertion = `${unsignedJwt}.${base64UrlEncode(new Uint8Array(signature))}`;
  const tokenResponse = await fetch(serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const tokenData = await tokenResponse.json().catch(()=>({}));
  if (!tokenResponse.ok) {
    throw new Error(`Failed to get Firebase access token: ${tokenData.error_description ?? tokenData.error ?? tokenResponse.status}`);
  }
  const accessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
  if (!accessToken) {
    throw new Error("Firebase access token response missing access_token");
  }
  const expiresIn = Number(tokenData.expires_in ?? 3600);
  cachedAccessToken = accessToken;
  cachedAccessTokenExpiryMs = Date.now() + expiresIn * 1000;
  return accessToken;
}
// ── Apple APNs JWT (ES256) ──
/**
 * Convert a DER-encoded ECDSA signature to raw r||s (64 bytes).
 * DER format: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
 * Raw format: r (32 bytes) || s (32 bytes)
 *
 * NOTE: Deno/browser Web Crypto already outputs raw r||s (64 bytes).
 * This function is kept as a safety net in case a runtime outputs DER.
 * The caller checks signature length and only calls this for DER.
 */ function derToRaw(der) {
  const raw = new Uint8Array(64);
  let offset = 2; // skip 0x30 <totalLen>
  // Read r
  offset += 1; // skip 0x02
  const rLen = der[offset++];
  const rStart = rLen > 32 ? offset + (rLen - 32) : offset;
  const rDest = rLen < 32 ? 32 - rLen : 0;
  raw.set(der.slice(rStart, rStart + Math.min(rLen, 32)), rDest);
  offset += rLen;
  // Read s
  offset += 1; // skip 0x02
  const sLen = der[offset++];
  const sStart = sLen > 32 ? offset + (sLen - 32) : offset;
  const sDest = sLen < 32 ? 64 - sLen : 32;
  raw.set(der.slice(sStart, sStart + Math.min(sLen, 32)), sDest);
  return raw;
}
async function getApnsJwtToken() {
  // Apple APNs tokens are valid for 1 hour; refresh 5 minutes before expiry
  if (cachedApnsJwt && Date.now() < cachedApnsJwtExpiryMs - 300_000) {
    return cachedApnsJwt;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    kid: apnsKeyId
  };
  const payload = {
    iss: apnsTeamId,
    iat: nowSeconds
  };
  const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const cryptoKey = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(apnsPrivateKey), {
    name: "ECDSA",
    namedCurve: "P-256"
  }, false, [
    "sign"
  ]);
  const signatureBuffer = await crypto.subtle.sign({
    name: "ECDSA",
    hash: "SHA-256"
  }, cryptoKey, new TextEncoder().encode(unsignedToken));
  // Deno/browser Web Crypto outputs raw r||s (64 bytes for P-256).
  // Only apply DER-to-raw conversion if the signature is DER-encoded
  // (> 64 bytes and starts with 0x30 SEQUENCE tag).
  const sigBytes = new Uint8Array(signatureBuffer);
  const rawSignature = sigBytes.length === 64 ? sigBytes : sigBytes.length > 64 && sigBytes[0] === 0x30 ? derToRaw(sigBytes) : sigBytes; // fallback: use as-is
  const jwt = `${unsignedToken}.${base64UrlEncode(rawSignature)}`;
  cachedApnsJwt = jwt;
  cachedApnsJwtExpiryMs = Date.now() + 3600 * 1000;
  return jwt;
}
// ── Direct APNs push (silent, no alert) ──
async function sendDirectApnsPush(activityPushToken, contentState, eventType, alertTitle, alertBody) {
  const apnsJwt = await getApnsJwtToken();
  const apsPayload = {
    timestamp: Math.floor(Date.now() / 1000),
    event: eventType,
    "content-state": contentState
  };
  // Only add alert + sound for end events
  if (eventType === "end" && alertTitle) {
    apsPayload.alert = {
      title: alertTitle,
      body: alertBody ?? ""
    };
    apsPayload.sound = "default";
    apsPayload["dismissal-date"] = Math.floor(Date.now() / 1000) + 1;
  }
  const response = await fetch(`${APNS_HOST}/3/device/${activityPushToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${apnsJwt}`,
      "apns-push-type": "liveactivity",
      "apns-topic": apnsTopic,
      "apns-priority": "10",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      aps: apsPayload
    })
  });
  if (response.ok) {
    return {
      ok: true
    };
  }
  const errorBody = await response.text().catch(()=>"");
  return {
    ok: false,
    statusCode: response.status,
    errorMessage: `APNs ${response.status}: ${errorBody}`
  };
}
// ── Helpers ──
function asString(value) {
  return typeof value === "string" ? value : "";
}
function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}
function parseDurations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item)=>typeof item === "number" ? Math.trunc(item) : Number(item)).filter((item)=>Number.isFinite(item) && item > 0);
}
function parseDescriptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item)=>typeof item === "string" ? item : "");
}
function extractFcmErrorCode(errorData) {
  if (!errorData || typeof errorData !== "object") return null;
  const details = errorData.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details){
    if (!detail || typeof detail !== "object") continue;
    const type = detail["@type"];
    const errorCode = detail.errorCode;
    if (typeof type === "string" && type.includes("google.firebase.fcm.v1.FcmError") && typeof errorCode === "string" && errorCode.length > 0) {
      return errorCode;
    }
  }
  return null;
}
function isInvalidTokenCode(code) {
  return code === "UNREGISTERED" || code === "INVALID_ARGUMENT" || code === "SENDER_ID_MISMATCH";
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function sumBeforeIndex(values, endExclusive) {
  let sum = 0;
  for(let i = 0; i < endExclusive; i++){
    sum += values[i] ?? 0;
  }
  return sum;
}
function parseEffectiveAtMs(payload, fallback) {
  const raw = payload.effective_at_ms;
  const parsed = typeof raw === "number" ? Math.trunc(raw) : typeof raw === "string" ? Math.trunc(Number(raw)) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}
function resolveStepState(row) {
  const durations = parseDurations(row.step_durations_seconds);
  const descriptions = parseDescriptions(row.step_descriptions);
  if (durations.length === 0) {
    throw new Error("Session has empty step_durations_seconds");
  }
  const totalSteps = durations.length;
  const brewStartMs = Date.parse(row.brew_started_at);
  if (!Number.isFinite(brewStartMs)) {
    throw new Error("Invalid brew_started_at timestamp");
  }
  const payload = asRecord(row.payload);
  const nowMs = Date.now();
  let stepIndex = totalSteps - 1;
  let stepStartMs = brewStartMs;
  let effectiveAtMs = nowMs;
  if (row.event_type === "boundary") {
    const requestedStep = Math.trunc(Number(payload.step_index ?? 1));
    stepIndex = clamp(requestedStep - 1, 0, totalSteps - 1);
    const computedBoundaryMs = brewStartMs + sumBeforeIndex(durations, stepIndex) * 1000;
    effectiveAtMs = parseEffectiveAtMs(payload, computedBoundaryMs);
    stepStartMs = effectiveAtMs;
  } else if (row.event_type === "end") {
    const expectedEndMs = Date.parse(row.expected_end_at);
    effectiveAtMs = Number.isFinite(expectedEndMs) ? Math.trunc(expectedEndMs) : nowMs;
    stepIndex = totalSteps - 1;
    const stepDurationMs = (durations[stepIndex] ?? 0) * 1000;
    stepStartMs = Math.max(0, effectiveAtMs - stepDurationMs);
  } else {
    throw new Error(`Unsupported event_type ${row.event_type}`);
  }
  const stepDurationSeconds = durations[stepIndex] ?? durations[durations.length - 1];
  const stepEndMs = stepStartMs + stepDurationSeconds * 1000;
  const stepDescription = descriptions[stepIndex] ?? descriptions[descriptions.length - 1] ?? "";
  const contentState = {
    appGroupId,
    updateTimestamp: Date.now() / 1000,
    recipeName: row.recipe_name ?? "Brewing",
    stepDescription,
    currentStep: stepIndex + 1,
    totalSteps,
    stepStartDateMs: Math.trunc(stepStartMs),
    stepEndDateMs: Math.trunc(stepEndMs),
    effectiveAtMs: Math.trunc(effectiveAtMs),
    isPaused: false,
    brewStartDateMs: Math.trunc(brewStartMs),
    stepDurationsSeconds: durations,
    stepDescriptions: descriptions
  };
  const recipeName = row.recipe_name ?? "Brewing";
  let alertTitle;
  let alertBody;
  if (row.event_type === "end") {
    alertTitle = "Brew Complete";
    alertBody = `${recipeName} is done!`;
  } else {
    alertTitle = `Step ${stepIndex + 1} of ${totalSteps}`;
    alertBody = stepDescription || recipeName;
  }
  return {
    contentState,
    eventType: row.event_type === "end" ? "end" : "update",
    effectiveAtMs: Math.trunc(effectiveAtMs),
    stepIndex,
    sendLagMs: nowMs - Math.trunc(effectiveAtMs),
    alertTitle,
    alertBody
  };
}
// ── Send via FCM (used for end events, or fallback when APNs secrets not set) ──
async function sendViaFcm(fcmToken, activityPushToken, contentState, eventType, alertTitle, alertBody) {
  const apsPayload = {
    timestamp: Math.floor(Date.now() / 1000),
    event: eventType,
    "content-state": contentState,
    // FCM requires an alert object to forward Live Activity pushes to APNs.
    alert: {
      title: alertTitle,
      body: alertBody
    }
  };
  if (eventType === "end") {
    apsPayload.sound = "default";
    apsPayload["dismissal-date"] = Math.floor(Date.now() / 1000) + 1;
  }
  const message = {
    token: fcmToken,
    apns: {
      live_activity_token: activityPushToken,
      headers: {
        "apns-push-type": "liveactivity",
        "apns-priority": "10",
        "apns-topic": apnsTopic
      },
      payload: {
        aps: apsPayload
      }
    }
  };
  const accessToken = await getFirebaseAccessToken();
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message
    })
  });
  const responseBody = await response.json().catch(()=>({}));
  if (response.ok) {
    return {
      ok: true
    };
  }
  const extractedCode = extractFcmErrorCode(responseBody);
  const fallbackCode = typeof responseBody.error?.status === "string" ? responseBody.error.status : null;
  const messageText = typeof responseBody.error?.message === "string" ? responseBody.error.message : `FCM send failed with HTTP ${response.status}`;
  return {
    ok: false,
    errorMessage: messageText,
    errorCode: extractedCode ?? fallbackCode
  };
}
// ── Main event dispatcher ──
async function sendLiveActivityEvent(row) {
  if (row.event_type === "watchdog") {
    return {
      ok: true,
      skipped: true,
      skipReason: "watchdog_retired"
    };
  }
  const fcmToken = asString(row.fcm_token);
  const activityPushToken = asString(row.activity_push_token);
  if (!activityPushToken) {
    return {
      ok: false,
      errorMessage: "Missing activity_push_token",
      errorCode: "MISSING_TOKEN"
    };
  }
  if (!fcmToken && !useDirectApns) {
    return {
      ok: false,
      errorMessage: "Missing fcm_token and no direct APNs configured",
      errorCode: "MISSING_TOKEN"
    };
  }
  const { contentState, eventType, sendLagMs, effectiveAtMs, stepIndex, alertTitle, alertBody } = resolveStepState(row);
  if (row.event_type === "boundary" && sendLagMs > maxBoundaryLateMs) {
    return {
      ok: true,
      skipped: true,
      skipReason: `stale_boundary:${sendLagMs}`,
      sendLagMs,
      effectiveAtMs,
      stepIndex
    };
  }
  // ── Routing: boundary → direct APNs (silent); end → FCM (with alert + sound) ──
  const shouldUseDirectApns = useDirectApns && row.event_type === "boundary";
  if (shouldUseDirectApns) {
    const apnsResult = await sendDirectApnsPush(activityPushToken, contentState, "update");
    if (apnsResult.ok) {
      return {
        ok: true,
        sendLagMs,
        effectiveAtMs,
        stepIndex,
        via: "apns"
      };
    }
    // APNs 410 Gone = token expired/invalidated
    if (apnsResult.statusCode === 410) {
      return {
        ok: false,
        errorMessage: apnsResult.errorMessage,
        errorCode: "UNREGISTERED",
        sendLagMs,
        effectiveAtMs,
        stepIndex,
        via: "apns"
      };
    }
    return {
      ok: false,
      errorMessage: apnsResult.errorMessage,
      errorCode: `APNS_${apnsResult.statusCode ?? "UNKNOWN"}`,
      sendLagMs,
      effectiveAtMs,
      stepIndex,
      via: "apns"
    };
  }
  // ── FCM path (end events, or fallback when APNs secrets not configured) ──
  if (!fcmToken) {
    return {
      ok: false,
      errorMessage: "Missing fcm_token for FCM delivery",
      errorCode: "MISSING_TOKEN",
      sendLagMs,
      effectiveAtMs,
      stepIndex
    };
  }
  const fcmResult = await sendViaFcm(fcmToken, activityPushToken, contentState, eventType, alertTitle, alertBody);
  if (fcmResult.ok) {
    return {
      ok: true,
      sendLagMs,
      effectiveAtMs,
      stepIndex,
      via: "fcm"
    };
  }
  return {
    ok: false,
    errorMessage: fcmResult.errorMessage,
    errorCode: fcmResult.errorCode,
    sendLagMs,
    effectiveAtMs,
    stepIndex,
    via: "fcm"
  };
}
async function finalizeEvent(eventId, status, error) {
  await supabase.rpc("finalize_live_activity_event", {
    p_event_id: eventId,
    p_status: status,
    p_error: error
  });
}
async function markSessionStale(sessionId, reason) {
  await supabase.from("live_activity_sessions").update({
    status: "stale",
    end_reason: reason,
    updated_at: new Date().toISOString()
  }).eq("id", sessionId);
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
  const token = req.headers.get("x-system-token") ?? req.headers.get("X-System-Token");
  if (token !== cronSecret) {
    return jsonResponse(403, {
      error: "Unauthorized"
    });
  }
  const { data: events, error: lockError } = await supabase.rpc("lock_due_live_activity_events", {
    p_limit: batchLimit
  });
  if (lockError) {
    return jsonResponse(500, {
      error: "Failed to lock due live activity events",
      details: lockError.message
    });
  }
  const rows = Array.isArray(events) ? events : [];
  if (rows.length === 0) {
    return jsonResponse(200, {
      success: true,
      processed: 0,
      sent: 0,
      skipped: 0,
      retried: 0,
      failed: 0,
      direct_apns: useDirectApns
    });
  }
  let sent = 0;
  let skipped = 0;
  let retried = 0;
  let failed = 0;
  for (const row of rows){
    try {
      const result = await sendLiveActivityEvent(row);
      if (result.ok && result.skipped) {
        await finalizeEvent(row.event_id, "cancelled", result.skipReason ?? "skipped");
        skipped += 1;
        console.log(JSON.stringify({
          level: "info",
          msg: "live_activity_event_skipped",
          session_id: row.session_id,
          event_id: row.event_id,
          event_type: row.event_type,
          step_index: result.stepIndex !== undefined ? result.stepIndex + 1 : null,
          effective_at_ms: result.effectiveAtMs ?? null,
          send_lag_ms: result.sendLagMs ?? null,
          reason: result.skipReason ?? "skipped"
        }));
        continue;
      }
      if (result.ok) {
        await finalizeEvent(row.event_id, "sent", null);
        sent += 1;
        console.log(JSON.stringify({
          level: "info",
          msg: "live_activity_event_sent",
          session_id: row.session_id,
          event_id: row.event_id,
          event_type: row.event_type,
          step_index: result.stepIndex !== undefined ? result.stepIndex + 1 : null,
          effective_at_ms: result.effectiveAtMs ?? null,
          send_lag_ms: result.sendLagMs ?? null,
          via: result.via ?? "unknown"
        }));
        continue;
      }
      const shouldFail = row.attempts >= maxAttempts;
      const status = shouldFail ? "failed" : "pending";
      await finalizeEvent(row.event_id, status, result.errorMessage ?? "unknown_error");
      if (result.errorCode && isInvalidTokenCode(result.errorCode)) {
        await markSessionStale(row.session_id, result.errorCode);
      }
      console.log(JSON.stringify({
        level: shouldFail ? "error" : "warn",
        msg: "live_activity_event_send_failed",
        session_id: row.session_id,
        event_id: row.event_id,
        event_type: row.event_type,
        step_index: result.stepIndex !== undefined ? result.stepIndex + 1 : null,
        effective_at_ms: result.effectiveAtMs ?? null,
        send_lag_ms: result.sendLagMs ?? null,
        attempts: row.attempts,
        max_attempts: maxAttempts,
        will_retry: !shouldFail,
        error_code: result.errorCode ?? null,
        error: result.errorMessage ?? "unknown_error",
        via: result.via ?? "unknown"
      }));
      if (shouldFail) {
        failed += 1;
      } else {
        retried += 1;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const shouldFail = row.attempts >= maxAttempts;
      await finalizeEvent(row.event_id, shouldFail ? "failed" : "pending", errorMessage);
      console.log(JSON.stringify({
        level: shouldFail ? "error" : "warn",
        msg: "live_activity_event_exception",
        session_id: row.session_id,
        event_id: row.event_id,
        event_type: row.event_type,
        attempts: row.attempts,
        max_attempts: maxAttempts,
        will_retry: !shouldFail,
        error: errorMessage
      }));
      if (shouldFail) {
        failed += 1;
      } else {
        retried += 1;
      }
    }
  }
  return jsonResponse(200, {
    success: true,
    processed: rows.length,
    sent,
    skipped,
    retried,
    failed,
    direct_apns: useDirectApns
  });
});
