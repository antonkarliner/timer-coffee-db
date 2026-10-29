import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { extractBearerToken, resolveCaller } from "./caller-auth.ts";

function request(authorization?: string): Request {
  return new Request("https://example.com", {
    headers: authorization ? { authorization } : undefined,
  });
}

function clientWithGetUser(
  getUser: (token: string) => Promise<unknown>,
): SupabaseClient {
  return { auth: { getUser } } as unknown as SupabaseClient;
}

Deno.test("extractBearerToken returns null for a missing header", () => {
  assertEquals(extractBearerToken(request()), null);
});

Deno.test("extractBearerToken returns null for the wrong scheme", () => {
  assertEquals(extractBearerToken(request("Basic abc")), null);
});

Deno.test("extractBearerToken accepts Bearer case-insensitively", () => {
  assertEquals(
    extractBearerToken(request("bEaReR token-value")),
    "token-value",
  );
});

Deno.test("resolveCaller rejects a missing bearer token", async () => {
  const client = clientWithGetUser(() => {
    throw new Error("getUser should not be called");
  });
  assertEquals(await resolveCaller(request(), client), {
    ok: false,
    status: 401,
    error: "Bearer token required",
  });
});

Deno.test("resolveCaller rejects the wrong authorization scheme", async () => {
  const client = clientWithGetUser(() => {
    throw new Error("getUser should not be called");
  });
  assertEquals(await resolveCaller(request("Basic abc"), client), {
    ok: false,
    status: 401,
    error: "Bearer token required",
  });
});

Deno.test("resolveCaller rejects a getUser error", async () => {
  const client = clientWithGetUser(async () => ({
    data: { user: null },
    error: new Error("invalid token"),
  }));
  assertEquals(await resolveCaller(request("Bearer bad-token"), client), {
    ok: false,
    status: 401,
    error: "Invalid or expired token",
  });
});

Deno.test("resolveCaller rejects a response with no user", async () => {
  const client = clientWithGetUser(async () => ({
    data: { user: null },
    error: null,
  }));
  assertEquals(await resolveCaller(request("Bearer anon-key"), client), {
    ok: false,
    status: 401,
    error: "Invalid or expired token",
  });
});

Deno.test("resolveCaller resolves a non-anonymous user", async () => {
  const client = clientWithGetUser(async (token) => ({
    data: { user: { id: `user-for-${token}`, is_anonymous: false } },
    error: null,
  }));
  assertEquals(await resolveCaller(request("Bearer jwt"), client), {
    ok: true,
    user: { id: "user-for-jwt", isAnonymous: false },
  });
});

Deno.test("resolveCaller resolves an anonymous user", async () => {
  const client = clientWithGetUser(async () => ({
    data: { user: { id: "anonymous-user", is_anonymous: true } },
    error: null,
  }));
  assertEquals(await resolveCaller(request("Bearer jwt"), client), {
    ok: true,
    user: { id: "anonymous-user", isAnonymous: true },
  });
});

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`;
}

const connectedAppJwt = jwt({ sub: "user-id", client_id: "oauth-client" });

Deno.test("resolveCaller accepts an ordinary user JWT", async () => {
  const client = clientWithGetUser(async () => ({
    data: { user: { id: "user-id", is_anonymous: false } },
    error: null,
  }));
  assertEquals(
    await resolveCaller(request(`Bearer ${jwt({ sub: "user-id" })}`), client),
    { ok: true, user: { id: "user-id", isAnonymous: false } },
  );
});

Deno.test("resolveCaller refuses a connected-app token by default", async () => {
  const client = clientWithGetUser(async () => ({
    data: { user: { id: "user-id", is_anonymous: false } },
    error: null,
  }));
  assertEquals(
    await resolveCaller(request(`Bearer ${connectedAppJwt}`), client),
    {
      ok: false,
      status: 403,
      error: "Connected apps can't use this function",
    },
  );
});

Deno.test("resolveCaller still reports an invalid connected-app token as 401", async () => {
  const client = clientWithGetUser(async () => ({
    data: { user: null },
    error: new Error("invalid token"),
  }));
  assertEquals(
    await resolveCaller(request(`Bearer ${connectedAppJwt}`), client),
    {
      ok: false,
      status: 401,
      error: "Invalid or expired token",
    },
  );
});

Deno.test("resolveCaller accepts a connected-app token when opted in", async () => {
  const client = clientWithGetUser(async () => ({
    data: { user: { id: "user-id", is_anonymous: false } },
    error: null,
  }));
  assertEquals(
    await resolveCaller(request(`Bearer ${connectedAppJwt}`), client, {
      allowConnectedApps: true,
    }),
    { ok: true, user: { id: "user-id", isAnonymous: false } },
  );
});
