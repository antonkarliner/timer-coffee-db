// web-risk
// ────────────────────────────────────────────────────────────────
// Google Web Risk `uris:search` client (same lookup the website runs when a
// roaster saves a link, see timer-coffee-landing-2 src/lib/web-risk.ts).
//
// The API key travels ONLY in the X-Goog-Api-Key header, never in the request
// URL, so it cannot leak through URLs in logs or error messages. Results are
// classified values: no raw error message (which could carry the looked-up
// URL) is ever returned. Never throws.
// ────────────────────────────────────────────────────────────────

import { fetchWithTimeout } from "./fetch-with-timeout.ts";

export const WEB_RISK_SEARCH_URL =
  "https://webrisk.googleapis.com/v1/uris:search";

export const WEB_RISK_THREAT_TYPES = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
] as const;

/** Per-lookup timeout (headers and body). */
export const WEB_RISK_TIMEOUT_MS = 5000;

export type WebRiskLookupResult =
  /** `{}`: no match on any requested list. */
  | { status: "clean" }
  | { status: "flagged"; threatTypes: string[] }
  /** This lookup failed; other lookups may still work. */
  | {
    status: "error";
    reason: "timeout" | "network" | "http" | "invalid_response";
    httpStatus?: number;
  }
  /** Rate limit or quota exhausted: every further lookup will fail too. */
  | { status: "quota"; httpStatus: number }
  /** The key was refused (invalid, or the API is not enabled for it). */
  | { status: "auth_error"; httpStatus: number };

export type WebRiskFetch = (
  url: string,
  init: RequestInit,
  timeoutMs: number,
) => Promise<Response>;

export interface WebRiskClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Defaults to _shared/fetch-with-timeout.ts. */
  fetch?: WebRiskFetch;
}

export interface WebRiskClient {
  lookUp(uri: string): Promise<WebRiskLookupResult>;
}

/** The search URL for one URI. It never contains the API key. */
export function buildWebRiskSearchUrl(uri: string): string {
  const params = new URLSearchParams();
  for (const threatType of WEB_RISK_THREAT_TYPES) {
    params.append("threatTypes", threatType);
  }
  params.set("uri", uri);
  return `${WEB_RISK_SEARCH_URL}?${params.toString()}`;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" ||
    error.message.startsWith("Request timeout after");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function googleErrorStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function bodyMentionsInvalidKey(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const details = (error as { details?: unknown }).details;
  if (!Array.isArray(details)) return false;
  return details.some((detail) =>
    detail && typeof detail === "object" &&
    (detail as { reason?: unknown }).reason === "API_KEY_INVALID"
  );
}

function classifyFailedResponse(
  httpStatus: number,
  body: unknown,
): WebRiskLookupResult {
  const status = googleErrorStatus(body);
  if (httpStatus === 429 || status === "RESOURCE_EXHAUSTED") {
    return { status: "quota", httpStatus };
  }
  if (
    httpStatus === 401 || httpStatus === 403 ||
    status === "PERMISSION_DENIED" || status === "UNAUTHENTICATED" ||
    bodyMentionsInvalidKey(body)
  ) {
    return { status: "auth_error", httpStatus };
  }
  return { status: "error", reason: "http", httpStatus };
}

function parseThreat(body: unknown): WebRiskLookupResult | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const threat = (body as { threat?: unknown }).threat;
  if (threat === undefined || threat === null) return { status: "clean" };
  if (typeof threat !== "object") return null;
  const raw = (threat as { threatTypes?: unknown }).threatTypes;
  const threatTypes = Array.isArray(raw)
    ? raw.filter((type): type is string => typeof type === "string")
    : [];
  return {
    status: "flagged",
    threatTypes: threatTypes.length > 0
      ? threatTypes
      : ["THREAT_TYPE_UNSPECIFIED"],
  };
}

export function createWebRiskClient(
  options: WebRiskClientOptions,
): WebRiskClient {
  const apiKey = options.apiKey;
  const timeoutMs = options.timeoutMs ?? WEB_RISK_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetchWithTimeout;

  return {
    async lookUp(uri: string): Promise<WebRiskLookupResult> {
      let response: Response;
      try {
        response = await doFetch(
          buildWebRiskSearchUrl(uri),
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              "X-Goog-Api-Key": apiKey,
            },
          },
          timeoutMs,
        );
      } catch (error) {
        return {
          status: "error",
          reason: isTimeoutError(error) ? "timeout" : "network",
        };
      }

      let body: unknown;
      try {
        body = await readJson(response);
      } catch (error) {
        if (isTimeoutError(error)) {
          return { status: "error", reason: "timeout" };
        }
        if (!response.ok) {
          return classifyFailedResponse(response.status, null);
        }
        return { status: "error", reason: "invalid_response" };
      }

      if (!response.ok) return classifyFailedResponse(response.status, body);

      return parseThreat(body) ??
        { status: "error", reason: "invalid_response" };
    },
  };
}
