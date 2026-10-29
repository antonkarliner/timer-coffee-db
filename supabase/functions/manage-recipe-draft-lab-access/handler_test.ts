import {
  assertEquals,
  assertObjectMatch,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  createManageRecipeDraftLabAccessHandler,
  type ManageRecipeDraftLabAccessHandlerDeps,
} from "./handler.ts";

function createDeps(
  overrides: Partial<ManageRecipeDraftLabAccessHandlerDeps> = {},
): ManageRecipeDraftLabAccessHandlerDeps {
  return {
    getUserFromToken: () => Promise.resolve({ id: "admin-user" }),
    isServiceAdmin: () => Promise.resolve(true),
    listTesters: () =>
      Promise.resolve([
        {
          user_id: "tester-user",
          email: "tester@example.com",
          role: "tester",
          is_active: true,
          expires_at: null,
          created_at: "2026-04-17T10:00:00.000Z",
          created_by: "admin-user",
        },
      ]),
    grantTesterAccess: () =>
      Promise.resolve({
        user_id: "tester-user",
        email: "tester@example.com",
        role: "tester",
        is_active: true,
        expires_at: null,
        created_at: "2026-04-17T10:00:00.000Z",
        created_by: "admin-user",
      }),
    updateTesterAccess: () =>
      Promise.resolve({
        user_id: "tester-user",
        email: "tester@example.com",
        role: "tester",
        is_active: false,
        expires_at: null,
        created_at: "2026-04-17T10:00:00.000Z",
        created_by: "admin-user",
      }),
    deleteTesterAccess: () => Promise.resolve(true),
    getTokenStats: () =>
      Promise.resolve({
        "tester-user": { tokens_used: 1500, openai_tokens_used: 800 },
      }),
    getCorsHeaders: () => ({
      "Access-Control-Allow-Origin": "http://localhost:3000",
    }),
    createResponse(body, init) {
      return new Response(body, init);
    },
    ...overrides,
  };
}

function postRequest(body: unknown, token = "token") {
  return new Request("http://localhost/manage-recipe-draft-lab-access", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.test("requires a bearer token", async () => {
  const handler = createManageRecipeDraftLabAccessHandler(createDeps());
  const response = await handler(
    new Request("http://localhost/manage-recipe-draft-lab-access", {
      method: "POST",
      body: JSON.stringify({ action: "list" }),
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 401);
  assertEquals(body.error, "Unauthorized");
});

Deno.test("forbids non-service-admin users", async () => {
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({
      isServiceAdmin: () => Promise.resolve(false),
    }),
  );
  const response = await handler(postRequest({ action: "list" }));
  const body = await response.json();

  assertEquals(response.status, 403);
  assertEquals(
    body.message,
    "Only full service admins can manage lab testers.",
  );
});

Deno.test("lists tester access rows", async () => {
  const handler = createManageRecipeDraftLabAccessHandler(createDeps());
  const response = await handler(postRequest({ action: "list" }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertObjectMatch(body, {
    users: [
      {
        user_id: "tester-user",
        email: "tester@example.com",
        is_active: true,
      },
    ],
  });
});

Deno.test("list includes token usage per tester", async () => {
  const handler = createManageRecipeDraftLabAccessHandler(createDeps());
  const response = await handler(postRequest({ action: "list" }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertObjectMatch(body.users[0], {
    user_id: "tester-user",
    tokens_used: 1500,
    openai_tokens_used: 800,
  });
});

Deno.test("list defaults token usage to 0 for users with no invocations", async () => {
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({ getTokenStats: () => Promise.resolve({}) }),
  );
  const response = await handler(postRequest({ action: "list" }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.users[0].tokens_used, 0);
  assertEquals(body.users[0].openai_tokens_used, 0);
});

Deno.test("grants tester access", async () => {
  const calls: unknown[] = [];
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({
      grantTesterAccess: (args) => {
        calls.push(args);
        return Promise.resolve({
          user_id: "tester-user",
          email: "tester@example.com",
          role: "tester",
          is_active: true,
          expires_at: "2026-05-01T10:00:00.000Z",
          created_at: "2026-04-17T10:00:00.000Z",
          created_by: args.createdBy,
        });
      },
    }),
  );
  const response = await handler(
    postRequest({
      action: "grant",
      identifier: "tester@example.com",
      expires_at: "2026-05-01T10:00:00.000Z",
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(calls, [
    {
      identifier: "tester@example.com",
      expiresAt: "2026-05-01T10:00:00.000Z",
      createdBy: "admin-user",
    },
  ]);
  assertEquals(body.user.email, "tester@example.com");
});

Deno.test("returns 404 when grant target user is missing", async () => {
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({
      grantTesterAccess: () => Promise.resolve(null),
    }),
  );
  const response = await handler(
    postRequest({ action: "grant", identifier: "missing@example.com" }),
  );
  const body = await response.json();

  assertEquals(response.status, 404);
  assertEquals(body.message, "Supabase Auth user was not found");
});

Deno.test("updates tester access", async () => {
  const calls: unknown[] = [];
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({
      updateTesterAccess: (args) => {
        calls.push(args);
        return Promise.resolve({
          user_id: args.userId,
          email: "tester@example.com",
          role: "tester",
          is_active: args.isActive ?? true,
          expires_at: args.expiresAt ?? null,
          created_at: "2026-04-17T10:00:00.000Z",
          created_by: "admin-user",
        });
      },
    }),
  );
  const response = await handler(
    postRequest({
      action: "update",
      user_id: "11111111-1111-4111-8111-111111111111",
      is_active: false,
      expires_at: null,
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(calls, [
    {
      userId: "11111111-1111-4111-8111-111111111111",
      isActive: false,
      expiresAt: null,
    },
  ]);
});

Deno.test("deletes tester access", async () => {
  const calls: unknown[] = [];
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({
      deleteTesterAccess: (userId) => {
        calls.push(userId);
        return Promise.resolve(true);
      },
    }),
  );
  const response = await handler(
    postRequest({
      action: "delete",
      user_id: "11111111-1111-4111-8111-111111111111",
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(calls, ["11111111-1111-4111-8111-111111111111"]);
  assertEquals(body, {
    success: true,
    user_id: "11111111-1111-4111-8111-111111111111",
  });
});

Deno.test("returns 404 when deleting missing tester access", async () => {
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({
      deleteTesterAccess: () => Promise.resolve(false),
    }),
  );
  const response = await handler(
    postRequest({
      action: "delete",
      user_id: "11111111-1111-4111-8111-111111111111",
    }),
  );
  const body = await response.json();

  assertEquals(response.status, 404);
  assertEquals(body.message, "Tester access row was not found");
});

Deno.test("refuses connected-app tokens before the admin check", async () => {
  // Payload: {"sub":"user-id","client_id":"oauth-client"}
  const connectedAppToken =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWlkIiwiY2xpZW50X2lkIjoib2F1dGgtY2xpZW50In0.signature";
  const handler = createManageRecipeDraftLabAccessHandler(
    createDeps({
      isServiceAdmin: () => {
        throw new Error("Admin check must not run for connected apps.");
      },
    }),
  );
  const response = await handler(
    postRequest({ action: "list" }, connectedAppToken),
  );

  assertEquals(response.status, 403);
  assertEquals(await response.json(), {
    error: "connected_app_forbidden",
    message: "Connected apps can't use this function.",
  });
});
