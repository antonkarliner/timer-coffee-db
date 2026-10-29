import {
  type CheckRecipeDraftLabAccessHandlerDeps,
  createCheckRecipeDraftLabAccessHandler,
} from "./handler.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

async function json(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

function createHandlerOverrides(): CheckRecipeDraftLabAccessHandlerDeps {
  return {
    getUserFromToken(token: string) {
      return Promise.resolve(token === "valid-token" ? { id: "user-1" } : null);
    },
    getRecipeDraftLabAccess() {
      return Promise.resolve({
        allowed: true,
        role: "tester",
      });
    },
    getCorsHeaders() {
      return {
        "Access-Control-Allow-Origin": "http://localhost:3000",
      };
    },
    createResponse(
      body: string,
      init: ResponseInit & { headers?: Record<string, string> },
    ) {
      return new Response(body, init);
    },
  };
}

Deno.test("rejects missing bearer token", async () => {
  const handler = createCheckRecipeDraftLabAccessHandler(
    createHandlerOverrides(),
  );
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
    }),
  );

  assertEquals(response.status, 401, "Expected 401 for missing token.");
});

Deno.test("rejects authenticated users without recipe draft lab access", async () => {
  const handler = createCheckRecipeDraftLabAccessHandler({
    ...createHandlerOverrides(),
    getRecipeDraftLabAccess() {
      return Promise.resolve({
        allowed: false,
      });
    },
  });
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
      },
    }),
  );
  const body = await json(response);

  assertEquals(response.status, 403, "Expected 403 for denied user.");
  assertEquals(
    body,
    {
      allowed: false,
      error: "Forbidden",
      message: "Recipe Draft Lab access is not enabled for this account.",
    },
    "Expected denied response body.",
  );
});

Deno.test("returns service admin access role", async () => {
  const handler = createCheckRecipeDraftLabAccessHandler({
    ...createHandlerOverrides(),
    getRecipeDraftLabAccess() {
      return Promise.resolve({
        allowed: true,
        role: "service_admin",
      });
    },
  });
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
      },
    }),
  );
  const body = await json(response);

  assertEquals(response.status, 200, "Expected 200 for service admin.");
  assertEquals(
    body,
    {
      allowed: true,
      role: "service_admin",
    },
    "Expected service admin response body.",
  );
});

Deno.test("returns tester access role", async () => {
  const handler = createCheckRecipeDraftLabAccessHandler(
    createHandlerOverrides(),
  );
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
      },
    }),
  );
  const body = await json(response);

  assertEquals(response.status, 200, "Expected 200 for tester.");
  assertEquals(
    body,
    {
      allowed: true,
      role: "tester",
    },
    "Expected tester response body.",
  );
});

Deno.test("rejects connected-app tokens before the access lookup", async () => {
  // Payload: {"sub":"user-id","client_id":"oauth-client"}
  const connectedAppToken =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWlkIiwiY2xpZW50X2lkIjoib2F1dGgtY2xpZW50In0.signature";
  const handler = createCheckRecipeDraftLabAccessHandler({
    ...createHandlerOverrides(),
    getUserFromToken() {
      return Promise.resolve({ id: "user-1" });
    },
    getRecipeDraftLabAccess() {
      throw new Error("Access lookup must not run for connected apps.");
    },
  });
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connectedAppToken}`,
      },
    }),
  );
  const body = await json(response);

  assertEquals(response.status, 403, "Expected 403 for connected apps.");
  assertEquals(
    body,
    {
      allowed: false,
      error: "connected_app_forbidden",
      message: "Connected apps can't use this function.",
    },
    "Expected connected-app refusal body.",
  );
});
