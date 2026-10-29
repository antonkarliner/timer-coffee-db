// Connected apps (Supabase Auth's OAuth 2.1 server) get ordinary user JWTs
// with an extra `client_id` claim naming the OAuth client. Ordinary sign-in
// tokens never carry it. Edge functions that act with the service role after
// verifying a user token must refuse connected-app tokens unless they are
// meant to serve agents.

export const CONNECTED_APP_FORBIDDEN_ERROR = "connected_app_forbidden";
export const CONNECTED_APP_FORBIDDEN_MESSAGE =
  "Connected apps can't use this function.";

/**
 * Reads the `client_id` claim from a JWT payload WITHOUT verifying it. Only
 * call this on a token `auth.getUser` has already verified; the result may
 * only restrict access, never grant it.
 *
 * Any present, non-null `client_id` counts as a connected app: an empty string
 * is returned as `""` and a non-string value as its JSON text, so callers
 * should compare with `!== null` (see `isConnectedAppToken`).
 *
 * A token with no readable payload (not three dot-separated segments, bad
 * base64url, or not a JSON object) returns `null`. getUser has verified the
 * token by then, so this should not happen; treating it as an ordinary token
 * keeps non-JWT test doubles and opaque tokens working as before.
 */
export function readClientIdClaim(token: string): string | null {
  const payload = decodePayload(token);
  if (!payload || !Object.hasOwn(payload, "client_id")) return null;
  const clientId = payload.client_id;
  if (clientId === null || clientId === undefined) return null;
  return typeof clientId === "string" ? clientId : JSON.stringify(clientId);
}

export function isConnectedAppToken(token: string): boolean {
  return readClientIdClaim(token) !== null;
}

export function connectedAppForbiddenResponse(
  cors: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: CONNECTED_APP_FORBIDDEN_ERROR,
      message: CONNECTED_APP_FORBIDDEN_MESSAGE,
    }),
    { status: 403, headers: { ...cors, "Content-Type": "application/json" } },
  );
}

function decodePayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
