import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  connectedAppForbiddenResponse,
  isConnectedAppToken,
  readClientIdClaim,
} from "./connected-app.ts";

function jwt(payload: unknown): string {
  const encode = (value: unknown) =>
    btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))),
    )
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

Deno.test("no client_id claim is an ordinary token", () => {
  const token = jwt({ sub: "user-id", role: "authenticated" });
  assertEquals(readClientIdClaim(token), null);
  assertEquals(isConnectedAppToken(token), false);
});

Deno.test("null client_id claim is an ordinary token", () => {
  const token = jwt({ sub: "user-id", client_id: null });
  assertEquals(readClientIdClaim(token), null);
  assertEquals(isConnectedAppToken(token), false);
});

Deno.test("string client_id claim is a connected app", () => {
  const token = jwt({ sub: "user-id", client_id: "oauth-client-1" });
  assertEquals(readClientIdClaim(token), "oauth-client-1");
  assertEquals(isConnectedAppToken(token), true);
});

Deno.test("empty-string client_id claim is a connected app", () => {
  const token = jwt({ sub: "user-id", client_id: "" });
  assertEquals(readClientIdClaim(token), "");
  assertEquals(isConnectedAppToken(token), true);
});

Deno.test("non-string client_id claims are connected apps", () => {
  for (const clientId of [0, 42, false, {}, ["a"]]) {
    const token = jwt({ sub: "user-id", client_id: clientId });
    assertEquals(readClientIdClaim(token), JSON.stringify(clientId));
    assertEquals(isConnectedAppToken(token), true);
  }
});

Deno.test("base64url payload characters decode correctly", () => {
  const clientId = "client??>>~~é";
  const token = jwt({ client_id: clientId });
  assertEquals(/[-_]/.test(token.split(".")[1]), true);
  assertEquals(readClientIdClaim(token), clientId);
});

Deno.test("malformed tokens have no readable payload", () => {
  for (
    const token of [
      "",
      "not-a-jwt",
      "only.two",
      "a.b.c.d",
      "header.!!!.sig",
      `header.${btoa("not json")}.sig`,
      `header.${btoa('"a string"')}.sig`,
      `header.${btoa('["client_id"]')}.sig`,
      `header.${btoa("null")}.sig`,
    ]
  ) {
    assertEquals(readClientIdClaim(token), null, token);
    assertEquals(isConnectedAppToken(token), false, token);
  }
});

Deno.test("refusal response is a 403 JSON error with the caller's CORS headers", async () => {
  const response = connectedAppForbiddenResponse({
    "Access-Control-Allow-Origin": "https://example.com",
  });
  assertEquals(response.status, 403);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://example.com",
  );
  assertEquals(response.headers.get("Content-Type"), "application/json");
  assertEquals(await response.json(), {
    error: "connected_app_forbidden",
    message: "Connected apps can't use this function.",
  });
});
