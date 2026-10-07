function eventTypeToEnvKey(eventType: string) {
  return eventType.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_");
}
export function resolveWebhookSecret(
  eventType: string,
  getEnv: (name: string) => string | undefined,
  logInvalidMap: (message: string) => void = console.error,
) {
  const eventSpecificSecret = getEnv(
    `BUYMEACOFFEE_WEBHOOK_SECRET_${eventTypeToEnvKey(eventType)}`,
  );
  if (eventSpecificSecret) {
    return {
      secret: eventSpecificSecret,
      source: "event_specific_env",
    };
  }
  const secretMap = getEnv("BUYMEACOFFEE_WEBHOOK_SECRETS");
  if (secretMap) {
    try {
      const parsed = JSON.parse(secretMap);
      const mappedSecret = parsed?.[eventType];
      if (typeof mappedSecret === "string" && mappedSecret.length > 0) {
        return {
          secret: mappedSecret,
          source: "json_env_map",
        };
      }
    } catch {
      logInvalidMap("Invalid BUYMEACOFFEE_WEBHOOK_SECRETS JSON");
    }
  }
  const sharedSecret = getEnv("BUYMEACOFFEE_WEBHOOK_SECRET");
  if (sharedSecret) {
    return {
      secret: sharedSecret,
      source: "shared_env",
    };
  }
  return {
    secret: null,
    source: "missing",
  };
}
export function sanitizePayload(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return payload;
  const record = structuredClone(payload);
  const data = (record as Record<string, unknown>).data;
  if (typeof data === "object" && data !== null) {
    const sanitizedData = data as Record<string, unknown>;
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
export function normalizeSignature(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("sha256=") ? trimmed.slice(7) : trimmed;
}
function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function constantTimeEquals(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
export async function computeHmacSha256(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    [
      "sign",
    ],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return bytesToHex(new Uint8Array(signature));
}
export async function computeSha256(payload: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return bytesToHex(new Uint8Array(digest));
}
