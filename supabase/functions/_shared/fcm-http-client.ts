import { getFCMAccessToken } from "./fcm-jwt-auth.ts";

export interface ServiceAccount {
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

interface FCMMessage {
  token?: string;
  tokens?: string[];
  notification?: {
    title: string;
    body: string;
  };
  data?: Record<string, string>;
  android?: {
    priority?: "high" | "normal";
    notification?: {
      sound?: string;
      click_action?: string;
    };
  };
  apns?: {
    headers?: {
      "apns-priority"?: string;
    };
    payload?: {
      aps?: {
        sound?: string;
        category?: string;
      };
    };
  };
}

interface FCMResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCode?: string;
}

interface FCMMulticastResponse {
  responses: FCMResponse[];
  successCount: number;
  failureCount: number;
}

function extractFcmErrorCode(errorData: unknown): string | undefined {
  if (!errorData || typeof errorData !== "object") return undefined;

  const details = (errorData as { error?: { details?: unknown } }).error
    ?.details;
  if (!Array.isArray(details)) return undefined;

  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const type = (detail as Record<string, unknown>)["@type"];
    const errorCode = (detail as Record<string, unknown>)["errorCode"];

    if (typeof errorCode !== "string" || !errorCode) continue;
    if (typeof type !== "string") continue;
    if (!type.includes("google.firebase.fcm.v1.FcmError")) continue;

    return errorCode;
  }

  return undefined;
}

/**
 * Sends a message to a single FCM token
 */
export async function sendFCMMessage(
  serviceAccount: ServiceAccount,
  message: FCMMessage,
): Promise<FCMResponse> {
  const accessToken = await getFCMAccessToken(serviceAccount);
  const projectId = serviceAccount.project_id;

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    },
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    const fcmErrorCode = extractFcmErrorCode(errorData);
    return {
      success: false,
      error: (errorData as { error?: { message?: string } })?.error?.message ||
        `HTTP ${response.status}`,
      errorCode: fcmErrorCode ||
        (errorData as { error?: { status?: string } })?.error?.status ||
        "unknown",
    };
  }

  const data = await response.json();
  return {
    success: true,
    messageId: data.name,
  };
}

/**
 * Sends messages to multiple FCM tokens (multicast)
 */
export async function sendFCMMulticast(
  serviceAccount: ServiceAccount,
  tokens: string[],
  payload: {
    title: string;
    body: string;
    data?: Record<string, string>;
    priority?: "low" | "normal" | "high";
  },
  concurrency = 25,
  sender: typeof sendFCMMessage = sendFCMMessage,
): Promise<FCMMulticastResponse> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("FCM concurrency must be a positive integer");
  }
  const responses: FCMResponse[] = new Array(tokens.length);
  let nextIndex = 0;
  let successCount = 0;
  let failureCount = 0;

  // Each worker reserves an index before awaiting so response order stays stable.
  async function worker() {
    while (nextIndex < tokens.length) {
      const index = nextIndex++;
      const token = tokens[index];
      const message: FCMMessage = {
        token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data,
      };

      if (payload.priority === "high") {
        message.android = {
          priority: "high",
        };
        message.apns = {
          headers: {
            "apns-priority": "10",
          },
          payload: {
            aps: {
              sound: "default",
            },
          },
        };
      }

      let result: FCMResponse;
      try {
        result = await sender(serviceAccount, message);
      } catch (error) {
        result = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorCode: "transport_error",
        };
      }
      responses[index] = result;

      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, tokens.length) },
      () => worker(),
    ),
  );
  return {
    responses,
    successCount,
    failureCount,
  };
}

/**
 * Checks if an error code indicates an invalid token
 */
export function isInvalidTokenError(errorCode?: string): boolean {
  return [
    "UNREGISTERED",
    "INVALID_ARGUMENT",
    "SENDER_ID_MISMATCH",
  ].includes(errorCode || "");
}
