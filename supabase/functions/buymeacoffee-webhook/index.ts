import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  computeHmacSha256,
  computeSha256,
  constantTimeEquals,
  normalizeSignature,
  resolveWebhookSecret,
  sanitizePayload
} from "./webhook.ts";
const VALID_EVENT_TYPES = new Set([
  "support_created",
  "support_refunded",
  "monthly_support_started",
  "monthly_support_updated",
  "monthly_support_cancelled"
]);
Deno.serve(async (req)=>{
  if (req.method !== "POST") {
    return Response.json({
      error: "Method not allowed"
    }, {
      status: 405
    });
  }
  const url = new URL(req.url);
  const configuredEventType = url.searchParams.get("kind");
  if (!configuredEventType || !VALID_EVENT_TYPES.has(configuredEventType)) {
    return Response.json({
      error: "Invalid or missing kind parameter"
    }, {
      status: 400
    });
  }
  const { secret: webhookSecret, source: secretSource } = resolveWebhookSecret(configuredEventType, (name)=>Deno.env.get(name));
  if (!webhookSecret) {
    return Response.json({
      error: "Missing webhook secret"
    }, {
      status: 500
    });
  }
  const signatureHeader = req.headers.get("x-signature-sha256") ?? req.headers.get("x-bmc-signature");
  const normalizedSignature = normalizeSignature(signatureHeader);
  if (!normalizedSignature) {
    return Response.json({
      error: "Missing signature header"
    }, {
      status: 401
    });
  }
  const rawPayload = await req.text();
  const expectedSignature = await computeHmacSha256(webhookSecret, rawPayload);
  if (!constantTimeEquals(normalizedSignature, expectedSignature)) {
    return Response.json({
      error: "Invalid signature"
    }, {
      status: 401
    });
  }
  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch  {
    return Response.json({
      error: "Invalid JSON payload"
    }, {
      status: 400
    });
  }
  const sanitizedPayload = sanitizePayload(payload);
  const payloadSha256 = await computeSha256(rawPayload);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({
      error: "Missing database configuration"
    }, {
      status: 500
    });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false
    }
  });
  const { data, error } = await supabase.rpc("insert_bmc_support_event", {
    p_configured_event_type: configuredEventType,
    p_payload: sanitizedPayload,
    p_payload_sha256: payloadSha256,
    p_signature_header: signatureHeader
  });
  if (error) {
    console.error("Failed to insert Buy Me a Coffee event:", {
      code: error.code,
      message: error.message
    });
    return Response.json({
      error: "Failed to store webhook"
    }, {
      status: 500
    });
  }
  return Response.json({
    accepted: true,
    configured_event_type: configuredEventType,
    secret_source: secretSource,
    duplicate: data?.inserted === false,
    event_id: data?.event_id ?? null,
    match_status: data?.match_status ?? null,
    candidate_count: data?.candidate_count ?? null,
    matched_install_id: data?.matched_install_id ?? null,
    matched_platform: data?.matched_platform ?? null
  }, {
    status: 202
  });
});
