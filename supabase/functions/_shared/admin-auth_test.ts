import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { authorizeAdminOrService, createAdminAuthDeps } from "./admin-auth.ts";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com", { headers });
}

const cases: Array<{
  name: string;
  headers?: Record<string, string>;
  key?: string;
  user?: { id: string } | null;
  admin?: { role: string | null } | { error: string };
  throwUser?: boolean;
  throwAdmin?: boolean;
  expected: unknown;
}> = [
  {
    name: "service bearer",
    headers: { authorization: "Bearer service-secret" },
    expected: { ok: true, kind: "service" },
  },
  {
    name: "service apikey only",
    headers: { apikey: "service-secret" },
    expected: { ok: true, kind: "service" },
  },
  {
    name: "missing bearer",
    expected: { ok: false, status: 401, error: "Bearer token required" },
  },
  {
    name: "wrong scheme",
    headers: { authorization: "Basic token" },
    expected: { ok: false, status: 401, error: "Bearer token required" },
  },
  {
    name: "anon JWT rejected",
    headers: {
      authorization:
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature",
    },
    user: null,
    expected: { ok: false, status: 401, error: "Invalid or expired token" },
  },
  {
    name: "auth throws",
    throwUser: true,
    expected: { ok: false, status: 401, error: "Invalid or expired token" },
  },
  {
    name: "non-admin",
    admin: { role: "roaster_owner" },
    expected: { ok: false, status: 403, error: "Forbidden" },
  },
  {
    name: "null role",
    admin: { role: null },
    expected: { ok: false, status: 403, error: "Forbidden" },
  },
  {
    name: "lookup error",
    admin: { error: "database unavailable" },
    expected: { ok: false, status: 500, error: "Admin check failed" },
  },
  {
    name: "lookup throws",
    throwAdmin: true,
    expected: { ok: false, status: 500, error: "Admin check failed" },
  },
  {
    name: "forged admin claim",
    headers: {
      authorization:
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWRtaW4ifQ.signature",
    },
    admin: { role: null },
    expected: { ok: false, status: 403, error: "Forbidden" },
  },
  {
    name: "admin session with anon apikey",
    headers: { authorization: "Bearer user-token", apikey: "anon-key" },
    expected: { ok: true, kind: "admin", userId: "user-id" },
  },
  {
    name: "empty configured key without bearer",
    key: "",
    expected: {
      ok: false,
      status: 500,
      error: "Service credential is not configured.",
    },
  },
  {
    name: "empty configured key with bearer",
    key: "",
    headers: { authorization: "Bearer user-token" },
    expected: {
      ok: false,
      status: 500,
      error: "Service credential is not configured.",
    },
  },
];
for (const test of cases) {
  Deno.test(`admin or service authorization: ${test.name}`, async () => {
    const req = request(
      test.headers ??
        (test.name === "missing bearer" ||
            test.name.startsWith("empty configured") ||
            test.name === "wrong scheme"
          ? {}
          : { authorization: "Bearer user-token" }),
    );
    let userCalls = 0;
    let adminCalls = 0;
    const result = await authorizeAdminOrService(req, {
      serviceRoleKey: test.key ?? "service-secret",
      async getUser(token) {
        userCalls++;
        assertEquals(token, req.headers.get("authorization")!.split(" ")[1]);
        if (test.throwUser) throw new Error("auth unavailable");
        return test.user === undefined ? { id: "user-id" } : test.user;
      },
      async getAdminRole(id) {
        adminCalls++;
        assertEquals(id, "user-id");
        if (test.throwAdmin) throw new Error("database unavailable");
        return test.admin ?? { role: "admin" };
      },
    });
    assertEquals(result, test.expected);
    if (
      test.name.startsWith("service") || test.key === "" ||
      test.name === "missing bearer" || test.name === "wrong scheme"
    ) {
      assertEquals([userCalls, adminCalls], [0, 0]);
    }
    if (test.user === null || test.throwUser) assertEquals(adminCalls, 0);
  });
}

Deno.test("admin auth adapter uses verified user and service admin table; errors deny", async () => {
  let authError: { message: string } | null = null;
  let lookupError: { message: string } | null = null;
  let row: { role: string } | null = { role: "admin" };
  const client = {
    auth: {
      async getUser(token: string) {
        assertEquals(token, "user-token");
        return { data: { user: { id: "user-id" } }, error: authError };
      },
    },
    schema(schema: string) {
      assertEquals(schema, "service");
      return {
        from(table: string) {
          assertEquals(table, "admin_users");
          return {
            select(column: string) {
              assertEquals(column, "role");
              return {
                eq(column: string, id: string) {
                  assertEquals([column, id], ["user_id", "user-id"]);
                  return {
                    async maybeSingle() {
                      return { data: row, error: lookupError };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  const deps = createAdminAuthDeps(client, "service-secret");
  assertEquals(await deps.getUser("user-token"), { id: "user-id" });
  authError = { message: "invalid" };
  assertEquals(await deps.getUser("user-token"), null);
  assertEquals(await deps.getAdminRole("user-id"), { role: "admin" });
  row = null;
  assertEquals(await deps.getAdminRole("user-id"), { role: null });
  lookupError = { message: "database unavailable" };
  assertEquals(await deps.getAdminRole("user-id"), {
    error: "database unavailable",
  });
});
