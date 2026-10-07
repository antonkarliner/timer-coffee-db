import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  createUpdateIdAfterSigninHandler,
  type UpdateIdAfterSigninDeps,
} from "./handler.ts";

const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const moved = {
  global_stats: 1,
  label_invocations: 1,
  recipes: 2,
  recipe_localizations: 2,
  recipe_steps: 2,
  fcm_tokens: 1,
};
const migration = { status: "data_migrated" as const, already: false, moved };
const invalid = { data: null, error: { status: 401 } };

function fixture(overrides: Partial<UpdateIdAfterSigninDeps> = {}) {
  const calls: string[] = [];
  const logs: unknown[] = [];
  const base: UpdateIdAfterSigninDeps = {
    resolveCaller: () =>
      Promise.resolve({
        ok: true,
        user: { id: destination, isAnonymous: false },
      }),
    getSourceUser: () =>
      Promise.resolve({
        data: { id: source, is_anonymous: true },
        error: null,
      }),
    getLedger: () => Promise.resolve({ data: null, error: null }),
    getOldUser: () => Promise.resolve({ data: { id: source }, error: null }),
    migrate: () => Promise.resolve({ data: migration, error: null }),
    deleteUser: () => Promise.resolve({ error: null }),
    complete: () => Promise.resolve({ data: true, error: null }),
    getCorsHeaders: () => ({
      "Access-Control-Allow-Origin": "https://test.example",
    }),
    logInfo: (message, details) => logs.push({ message, details }),
    logWarning: (message, details) => logs.push({ message, details }),
    logError: (message) => logs.push({ message }),
    ...overrides,
  };
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  const deps: UpdateIdAfterSigninDeps = {
    ...base,
    resolveCaller: track("caller", base.resolveCaller),
    getSourceUser: track("proof", (token) => {
      assertEquals(token, "source-token");
      return base.getSourceUser(token);
    }),
    getLedger: track("ledger", (s, d) => {
      assertEquals([s, d], [source, destination]);
      return base.getLedger(s, d);
    }),
    getOldUser: track("oldUser", (s) => {
      assertEquals(s, source);
      return base.getOldUser(s);
    }),
    migrate: track("migrate", base.migrate),
    deleteUser: track("delete", base.deleteUser),
    complete: track("complete", base.complete),
  };
  const handler = createUpdateIdAfterSigninHandler(deps);
  const send = async (
    body: unknown = {
      oldUserId: source,
      newUserId: destination,
      oldAccessToken: "source-token",
    },
    method = "POST",
    raw = false,
  ) => {
    const response = await handler(
      new Request("https://test.example", {
        method,
        headers: { Authorization: "Bearer destination-token" },
        ...(method === "POST"
          ? { body: raw ? String(body) : JSON.stringify(body) }
          : {}),
      }),
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://test.example",
    );
    return {
      status: response.status,
      body: method === "POST" ? await response.json() : await response.text(),
    };
  };
  return { calls, logs, send };
}

for (const proof of [undefined, "", null, 42]) {
  Deno.test(`missing or unusable proof (${String(proof)}) skips without effects`, async () => {
    const f = fixture();
    assertEquals(
      await f.send({
        oldUserId: source,
        newUserId: destination,
        oldAccessToken: proof,
      }),
      {
        status: 200,
        body: { skipped: "source_proof_required", upgradeRequired: true },
      },
    );
    assertEquals(f.calls, ["caller"]);
    assertEquals(f.logs, [{
      message: "Source proof required for user ID migration",
      details: { callerId: destination },
    }]);
  });
}

const cases: Array<{
  name: string;
  deps: Partial<UpdateIdAfterSigninDeps>;
  status: number;
  body: Record<string, unknown>;
  calls: string[];
}> = [
  {
    name: "invalid proof without ledger denies",
    deps: { getSourceUser: () => Promise.resolve(invalid) },
    status: 403,
    body: {
      error: "Invalid or expired source session",
      code: "invalid_source_proof",
    },
    calls: ["caller", "proof", "ledger"],
  },
  {
    name: "invalid proof and completed ledger skips",
    deps: {
      getSourceUser: () => Promise.resolve(invalid),
      getLedger: () =>
        Promise.resolve({ data: { status: "completed" }, error: null }),
    },
    status: 200,
    body: { skipped: "already_migrated" },
    calls: ["caller", "proof", "ledger"],
  },
  {
    name: "invalid proof and missing source completes data_migrated ledger",
    deps: {
      getSourceUser: () => Promise.resolve(invalid),
      getLedger: () =>
        Promise.resolve({ data: { status: "data_migrated" }, error: null }),
      getOldUser: () =>
        Promise.resolve({ data: null, error: { code: "user_not_found" } }),
    },
    status: 200,
    body: { skipped: "already_migrated" },
    calls: ["caller", "proof", "ledger", "oldUser", "complete"],
  },
  {
    name: "invalid proof and source still exists denies",
    deps: {
      getSourceUser: () => Promise.resolve(invalid),
      getLedger: () =>
        Promise.resolve({ data: { status: "data_migrated" }, error: null }),
    },
    status: 403,
    body: {
      error: "Invalid or expired source session",
      code: "invalid_source_proof",
    },
    calls: ["caller", "proof", "ledger", "oldUser"],
  },
  {
    name: "proof subject mismatch denies before RPC",
    deps: {
      getSourceUser: () =>
        Promise.resolve({
          data: { id: destination, is_anonymous: true },
          error: null,
        }),
    },
    status: 403,
    body: {
      error: "Source session does not match oldUserId",
      code: "source_proof_mismatch",
    },
    calls: ["caller", "proof"],
  },
  {
    name: "permanent source skips",
    deps: {
      getSourceUser: () =>
        Promise.resolve({
          data: { id: source, is_anonymous: false },
          error: null,
        }),
    },
    status: 200,
    body: { skipped: "old_user_not_anonymous" },
    calls: ["caller", "proof"],
  },
  ...[{ code: "PT409" }, { message: "anonymous_migration_conflict" }].map((
    error,
  ) => ({
    name: `RPC conflict (${JSON.stringify(error)}) denies without deletion`,
    deps: { migrate: () => Promise.resolve({ data: null, error }) },
    status: 409,
    body: {
      error: "Source account was already migrated to a different account",
      code: "source_already_claimed",
    },
    calls: ["caller", "proof", "migrate"],
  })),
  {
    name: "RPC generic error denies without deletion",
    deps: {
      migrate: () => Promise.resolve({ data: null, error: { code: "23503" } }),
    },
    status: 500,
    body: { error: "Failed to migrate user data" },
    calls: ["caller", "proof", "migrate"],
  },
  {
    name: "deletion transport failure leaves ledger incomplete",
    deps: { deleteUser: () => Promise.reject(new Error("network")) },
    status: 500,
    body: {
      error: "Failed to delete source user",
      code: "source_delete_failed",
    },
    calls: ["caller", "proof", "migrate", "delete"],
  },
  {
    name: "deletion failure leaves ledger incomplete",
    deps: { deleteUser: () => Promise.resolve({ error: { status: 500 } }) },
    status: 500,
    body: {
      error: "Failed to delete source user",
      code: "source_delete_failed",
    },
    calls: ["caller", "proof", "migrate", "delete"],
  },
  {
    name: "ledger lookup error fails closed",
    deps: {
      getSourceUser: () => Promise.resolve(invalid),
      getLedger: () =>
        Promise.resolve({ data: null, error: { code: "database_failure" } }),
    },
    status: 500,
    body: { error: "Failed to look up migration state" },
    calls: ["caller", "proof", "ledger"],
  },
  {
    name: "source lookup database/auth error fails closed",
    deps: {
      getSourceUser: () => Promise.resolve(invalid),
      getLedger: () =>
        Promise.resolve({ data: { status: "data_migrated" }, error: null }),
      getOldUser: () => Promise.resolve({ data: null, error: { status: 500 } }),
    },
    status: 500,
    body: { error: "Failed to look up old user" },
    calls: ["caller", "proof", "ledger", "oldUser"],
  },
  {
    name: "completion error in invalid-proof recovery fails closed",
    deps: {
      getSourceUser: () => Promise.resolve(invalid),
      getLedger: () =>
        Promise.resolve({ data: { status: "data_migrated" }, error: null }),
      getOldUser: () => Promise.resolve({ data: null, error: null }),
      complete: () =>
        Promise.resolve({ data: null, error: { code: "database_failure" } }),
    },
    status: 500,
    body: { error: "Failed to complete migration" },
    calls: ["caller", "proof", "ledger", "oldUser", "complete"],
  },
];
for (const c of cases) {
  Deno.test(c.name, async () => {
    const f = fixture(c.deps);
    assertEquals(await f.send(), { status: c.status, body: c.body });
    assertEquals(f.calls, c.calls);
  });
}

for (
  const [name, deps] of [
    ["happy path", {}],
    ["delete user not found", {
      deleteUser: () => Promise.resolve({ error: { code: "user_not_found" } }),
    }],
    ["completion error", {
      complete: () =>
        Promise.resolve({ data: null, error: { code: "database_failure" } }),
    }],
    ["completion throws", {
      complete: () => Promise.reject(new Error("network")),
    }],
    ["retry still deletes and completes", {
      migrate: () =>
        Promise.resolve({ data: { ...migration, already: true }, error: null }),
    }],
  ] as Array<[string, Partial<UpdateIdAfterSigninDeps>]>
) {
  Deno.test(name, async () => {
    const f = fixture({
      ...deps,
      migrate: async (s, d) => {
        assertEquals([s, d], [source, destination]);
        return deps.migrate
          ? await deps.migrate(s, d)
          : { data: migration, error: null };
      },
      deleteUser: async (s) => {
        assertEquals(s, source);
        return deps.deleteUser ? await deps.deleteUser(s) : { error: null };
      },
      complete: async (s, d) => {
        assertEquals([s, d], [source, destination]);
        return deps.complete
          ? await deps.complete(s, d)
          : { data: true, error: null };
      },
    });
    assertEquals(await f.send(), {
      status: 200,
      body: {
        message: "User ID updated and old user deleted successfully",
        moved,
        fcmTokensUpdated: 1,
        oldUserDeleted: true,
      },
    });
    assertEquals(f.calls, ["caller", "proof", "migrate", "delete", "complete"]);
    assertEquals(JSON.stringify(f.logs).includes("source-token"), false);
  });
}

Deno.test("anonymous caller rejects before proof", async () => {
  const f = fixture({
    resolveCaller: () =>
      Promise.resolve({
        ok: true,
        user: { id: destination, isAnonymous: true },
      }),
  });
  assertEquals(await f.send(), {
    status: 403,
    body: { error: "Anonymous callers cannot migrate user data" },
  });
  assertEquals(f.calls, ["caller"]);
});

for (
  const [name, body, status, expected] of [
    ["destination mismatch", { oldUserId: source, newUserId: source }, 403, {
      error: "newUserId must match the authenticated user",
    }],
    ["same user", { oldUserId: destination, newUserId: destination }, 200, {
      skipped: "same_user",
    }],
    ["non UUID", { oldUserId: "not-a-uuid", newUserId: destination }, 400, {
      error: "oldUserId must be a UUID",
    }],
    ["missing IDs", {}, 400, {
      error: "Both oldUserId and newUserId are required",
    }],
    ["null body", null, 400, {
      error: "Both oldUserId and newUserId are required",
    }],
  ] as const
) {
  Deno.test(name, async () => {
    const f = fixture();
    assertEquals(await f.send(body), { status, body: expected });
    assertEquals(f.calls, ["caller"]);
  });
}

Deno.test("bad JSON rejects after caller", async () => {
  const f = fixture();
  assertEquals(await f.send("{", "POST", true), {
    status: 400,
    body: { error: "Invalid JSON body" },
  });
  assertEquals(f.calls, ["caller"]);
});
Deno.test("unresolved destination caller rejects", async () => {
  const f = fixture({
    resolveCaller: () =>
      Promise.resolve({
        ok: false,
        status: 401,
        error: "Invalid or expired token",
      }),
  });
  assertEquals(await f.send(), {
    status: 401,
    body: { error: "Invalid or expired token" },
  });
  assertEquals(f.calls, ["caller"]);
});
for (
  const [method, status, body] of [["OPTIONS", 200, "ok"], [
    "GET",
    405,
    "Method Not Allowed",
  ]] as const
) {
  Deno.test(method, async () => {
    const f = fixture();
    assertEquals(await f.send(undefined, method), { status, body });
    assertEquals(f.calls, []);
  });
}
