import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import { createCheckAdminUserHandler } from "./handler.ts";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`;
}

const SESSION_TOKEN = jwt({ sub: USER_ID, role: "authenticated" });
const CONNECTED_APP_TOKEN = jwt({
  sub: USER_ID,
  role: "authenticated",
  client_id: "agent-client",
});

function setup(options: {
  user?: { id: string } | null;
  isAdmin?: boolean;
  adminLookupThrows?: boolean;
} = {}) {
  const calls = { getUser: 0, isAdmin: [] as string[] };
  const handler = createCheckAdminUserHandler({
    getUserFromToken() {
      calls.getUser += 1;
      return Promise.resolve(
        options.user === undefined ? { id: USER_ID } : options.user,
      );
    },
    isAdminUser(userId) {
      calls.isAdmin.push(userId);
      if (options.adminLookupThrows) {
        return Promise.reject(new Error("db down"));
      }
      return Promise.resolve(options.isAdmin ?? false);
    },
    corsHeaders: { "Access-Control-Allow-Origin": "*" },
  });
  return { handler, calls };
}

function post(body: unknown, token?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://example.com/check-admin-user", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(response: Response) {
  return { status: response.status, body: await response.json() };
}

Deno.test("answers OPTIONS preflight with CORS headers", async () => {
  const { handler } = setup();
  const response = await handler(
    new Request("https://example.com", { method: "OPTIONS" }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("rejects non-POST methods", async () => {
  const { handler } = setup();
  const response = await handler(new Request("https://example.com"));
  assertEquals(await read(response), {
    status: 405,
    body: { error: "Method not allowed" },
  });
});

Deno.test("requires a bearer token and never looks the user up without one", async () => {
  const { handler, calls } = setup();
  assertEquals(await read(await handler(post({ userId: USER_ID }))), {
    status: 401,
    body: { error: "Bearer token required" },
  });
  assertEquals(calls.getUser, 0);
  assertEquals(calls.isAdmin, []);
});

Deno.test("rejects an invalid or expired token", async () => {
  const { handler, calls } = setup({ user: null });
  assertEquals(
    await read(await handler(post({ userId: USER_ID }, SESSION_TOKEN))),
    { status: 401, body: { error: "Invalid or expired token" } },
  );
  assertEquals(calls.isAdmin, []);
});

Deno.test("rejects a malformed body or missing userId", async () => {
  const { handler } = setup();
  assertEquals(
    (await read(await handler(post("{", SESSION_TOKEN)))).status,
    400,
  );
  assertEquals(
    (await read(await handler(post({}, SESSION_TOKEN)))).status,
    400,
  );
  assertEquals(
    (await read(await handler(post({ userId: 42 }, SESSION_TOKEN)))).status,
    400,
  );
});

Deno.test("refuses to answer about a different user", async () => {
  const { handler, calls } = setup({ isAdmin: true });
  assertEquals(
    await read(await handler(post({ userId: OTHER_ID }, SESSION_TOKEN))),
    {
      status: 403,
      body: { error: "userId must match the authenticated user" },
    },
  );
  assertEquals(calls.isAdmin, []);
});

Deno.test("refuses connected-app (OAuth) tokens before the admin lookup", async () => {
  const { handler, calls } = setup({ isAdmin: true });
  const { status, body } = await read(
    await handler(post({ userId: USER_ID }, CONNECTED_APP_TOKEN)),
  );
  assertEquals(status, 403);
  assertEquals(body.error, "connected_app_forbidden");
  assertEquals(calls.isAdmin, []);
});

Deno.test("returns role admin for the caller when they are an admin", async () => {
  const { handler, calls } = setup({ isAdmin: true });
  assertEquals(
    await read(await handler(post({ userId: USER_ID }, SESSION_TOKEN))),
    { status: 200, body: { role: "admin" } },
  );
  assertEquals(calls.isAdmin, [USER_ID]);
});

Deno.test("returns role null for the caller when they are not an admin", async () => {
  const { handler } = setup({ isAdmin: false });
  assertEquals(
    await read(await handler(post({ userId: USER_ID }, SESSION_TOKEN))),
    { status: 200, body: { role: null } },
  );
});

Deno.test("accepts a lowercase bearer scheme", async () => {
  const { handler } = setup({ isAdmin: true });
  const request = new Request("https://example.com", {
    method: "POST",
    headers: { authorization: `bearer ${SESSION_TOKEN}` },
    body: JSON.stringify({ userId: USER_ID }),
  });
  assertEquals((await read(await handler(request))).body, { role: "admin" });
});

Deno.test("returns 500 without details when the admin lookup fails", async () => {
  const { handler } = setup({ adminLookupThrows: true });
  assertEquals(
    await read(await handler(post({ userId: USER_ID }, SESSION_TOKEN))),
    { status: 500, body: { error: "Internal server error" } },
  );
});
