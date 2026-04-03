import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const VALID_EVENT_TYPES = new Set([
  "support_created",
  "support_refunded",
  "monthly_support_started",
  "monthly_support_updated",
  "monthly_support_cancelled"
]);
function eventTypeToEnvKey(eventType) {
  return eventType.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_");
}
function resolveWebhookSecret(eventType, url) {
  const eventSpecificSecret = Deno.env.get(`BUYMEACOFFEE_WEBHOOK_SECRET_${eventTypeToEnvKey(eventType)}`);
  if (eventSpecificSecret) {
    return {
      secret: eventSpecificSecret,
      source: "event_specific_env"
    };
  }
  const secretMap = Deno.env.get("BUYMEACOFFEE_WEBHOOK_SECRETS");
  if (secretMap) {
    try {
      const parsed = JSON.parse(secretMap);
      const mappedSecret = parsed[eventType];
      if (typeof mappedSecret === "string" && mappedSecret.length > 0) {
        return {
          secret: mappedSecret,
          source: "json_env_map"
        };
      }
    } catch (error) {
      console.error("Invalid BUYMEACOFFEE_WEBHOOK_SECRETS JSON:", error);
    }
  }
  const urlSecret = url.searchParams.get("secret");
  if (urlSecret) {
    return {
      secret: urlSecret,
      source: "url_query"
    };
  }
  const sharedSecret = Deno.env.get("BUYMEACOFFEE_WEBHOOK_SECRET");
  if (sharedSecret) {
    return {
      secret: sharedSecret,
      source: "shared_env"
    };
  }
  return {
    secret: null,
    source: "missing"
  };
}
function sanitizePayload(payload) {
  if (typeof payload !== "object" || payload === null) return payload;
  const record = structuredClone(payload);
  const data = record.data;
  if (typeof data === "object" && data !== null) {
    const sanitizedData = data;
    delete sanitizedData.message;
    delete sanitizedData.supporter_email;
    delete sanitizedData.supporter_name;
    delete sanitizedData.supporter_name_type;
    delete sanitizedData.support_note;
    delete sanitizedData.supporter_feedback;
    delete sanitizedData.supporter_id;
  }
  return record;
}
function normalizeSignature(value) {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("sha256=") ? trimmed.slice(7) : trimmed;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((byte)=>byte.toString(16).padStart(2, "0")).join("");
}
function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for(let i = 0; i < a.length; i++){
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
async function computeHmacSha256(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {
    name: "HMAC",
    hash: "SHA-256"
  }, false, [
    "sign"
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}
async function computeSha256(payload) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(digest));
}
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
  const { secret: webhookSecret, source: secretSource } = resolveWebhookSecret(configuredEventType, url);
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
      error: "Invalid signature",
      secret_source: secretSource
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
  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), {
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
    console.error("Failed to insert Buy Me a Coffee event:", error);
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
