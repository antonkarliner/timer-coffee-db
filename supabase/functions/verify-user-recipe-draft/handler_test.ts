import {
  createVerifyUserRecipeDraftHandler,
  type VerifyUserRecipeDraftHandlerDeps,
  type VerifyUserRecipeDraftRequest,
} from "./handler.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const cors = { "Access-Control-Allow-Origin": "https://timer.coffee" };

// Only these three members are available: no parser, database, or diagnostics.
function fakeDeps(): VerifyUserRecipeDraftHandlerDeps {
  return {
    getUserFromToken(token) {
      return Promise.resolve(
        token === "valid" || token === "anonymous"
          ? { id: "test-user", isAnonymous: token === "anonymous" }
          : null,
      );
    },
    getCorsHeaders(origin) {
      assertEquals(origin, "https://timer.coffee");
      return cors;
    },
    createResponse(body, init) {
      return new Response(body, init);
    },
  };
}

function requestBody(): VerifyUserRecipeDraftRequest {
  return {
    app_locale: "en",
    consent_to_diagnostics: true,
    recipe: {
      name: "Test coffee",
      brewing_method_id: "unknown-method-is-valid",
      coffee_amount: 15,
      water_amount: 250,
      brew_time_seconds: 120,
      grind_size: "Medium",
    },
    steps: [
      {
        order: 3,
        kind: "preparation",
        description: "Rinse filter",
        duration_seconds: 0,
      },
      {
        order: 1,
        kind: "brew",
        description: "Bloom with 50 g",
        duration_seconds: 30,
      },
      {
        order: 2,
        kind: "brew",
        description: "Pour 200 g",
        duration_seconds: 90,
      },
    ],
  };
}

function request(
  body: unknown = requestBody(),
  authorization: string | null = "Bearer valid",
  method = "POST",
  raw = false,
): Request {
  const headers = new Headers({ origin: "https://timer.coffee" });
  if (authorization !== null) headers.set("Authorization", authorization);
  return new Request("http://localhost", {
    method,
    headers,
    ...(method === "POST"
      ? { body: raw ? String(body) : JSON.stringify(body) }
      : {}),
  });
}

async function echo(body: VerifyUserRecipeDraftRequest): Promise<void> {
  const response = await createVerifyUserRecipeDraftHandler(fakeDeps())(
    request(body),
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    cors["Access-Control-Allow-Origin"],
  );
  assertEquals(await response.json(), {
    detected_input_language: null,
    provider_used: null,
    provider_model_used: null,
    tokens_used: 0,
    openai_tokens_used: 0,
    warnings: [],
    issues: [],
    corrected_steps: body.steps.map((step) => ({
      order: step.order,
      kind: step.kind,
      description_template: step.description,
      duration_seconds: step.duration_seconds,
    })),
  });
}

Deno.test("echoes three steps in submitted order with zero usage and no diagnostics", async () => {
  await echo(requestBody());
});

Deno.test("preserves raw whitespace, Japanese, Arabic RTL, Persian digits, emoji and decimal comma", async () => {
  const body = requestBody();
  body.steps = [
    "  お湯を注ぐ 🍵  ",
    "\tصب الماء ۲۵۰ مل ☕\n",
    " Add 0,5 g 🫘 \r\n",
  ].map((description, index) => ({
    order: index + 1,
    kind: "brew",
    description,
    duration_seconds: index,
  }));
  await echo(body);
});

Deno.test("accepts 50 steps and rejects 51", async () => {
  const body = requestBody();
  body.steps = Array.from(
    { length: 50 },
    (_, index) => ({ ...body.steps[0], order: index + 1 }),
  );
  await echo(body);
  body.steps.push({ ...body.steps[0], order: 51 });
  const response = await createVerifyUserRecipeDraftHandler(fakeDeps())(
    request(body),
  );
  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: "Bad Request",
    message: "steps: Array must contain at most 50 element(s)",
  });
});

for (const authorization of [null, "Basic valid", "Bearer "]) {
  Deno.test(`rejects missing or invalid authorization: ${authorization}`, async () => {
    const deps = fakeDeps();
    deps.getUserFromToken = () => {
      throw new Error("Auth must not be called");
    };
    const response = await createVerifyUserRecipeDraftHandler(deps)(
      request({}, authorization),
    );
    assertEquals(response.status, 401);
    assertEquals(await response.json(), {
      error: "Unauthorized",
      message: "Missing or invalid Authorization header.",
    });
  });
}

Deno.test("rejects unknown token", async () => {
  const response = await createVerifyUserRecipeDraftHandler(fakeDeps())(
    request({}, "Bearer unknown"),
  );
  assertEquals(response.status, 401);
  assertEquals(await response.json(), {
    error: "Unauthorized",
    message: "Could not resolve the authenticated user.",
  });
});

Deno.test("rejects anonymous user", async () => {
  const response = await createVerifyUserRecipeDraftHandler(fakeDeps())(
    request({}, "Bearer anonymous"),
  );
  assertEquals(response.status, 403);
  assertEquals(await response.json(), {
    error: "Forbidden",
    message: "AI recipe review is available only to signed-in users.",
  });
});

Deno.test("rejects connected-app tokens", async () => {
  // Payload: {"sub":"user-id","client_id":"oauth-client"}
  const connectedAppToken =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWlkIiwiY2xpZW50X2lkIjoib2F1dGgtY2xpZW50In0.signature";
  const deps = fakeDeps();
  deps.getUserFromToken = () =>
    Promise.resolve({ id: "test-user", isAnonymous: false });
  const response = await createVerifyUserRecipeDraftHandler(deps)(
    request({}, `Bearer ${connectedAppToken}`),
  );
  assertEquals(response.status, 403);
  assertEquals(await response.json(), {
    error: "connected_app_forbidden",
    message: "Connected apps can't use this function.",
  });
});

Deno.test("rejects invalid JSON", async () => {
  const response = await createVerifyUserRecipeDraftHandler(fakeDeps())(
    request("{", "Bearer valid", "POST", true),
  );
  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: "Bad Request",
    message: "Request body must be valid JSON.",
  });
});

Deno.test("formats schema errors for empty and whitespace-only descriptions", async () => {
  for (const description of ["", "  \t\n"]) {
    const body = requestBody();
    body.steps[0].description = description;
    const response = await createVerifyUserRecipeDraftHandler(fakeDeps())(
      request(body),
    );
    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      error: "Bad Request",
      message:
        "steps.0.description: String must contain at least 1 character(s)",
    });
  }
});

Deno.test("OPTIONS returns existing CORS ok response without auth", async () => {
  const deps = fakeDeps();
  deps.getUserFromToken = () => {
    throw new Error("Auth must not be called");
  };
  const response = await createVerifyUserRecipeDraftHandler(deps)(
    request(undefined, null, "OPTIONS"),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "ok");
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    cors["Access-Control-Allow-Origin"],
  );
});

Deno.test("GET returns existing 405 body without auth", async () => {
  const deps = fakeDeps();
  deps.getUserFromToken = () => {
    throw new Error("Auth must not be called");
  };
  const response = await createVerifyUserRecipeDraftHandler(deps)(
    request(undefined, null, "GET"),
  );
  assertEquals(response.status, 405);
  assertEquals(await response.json(), { error: "Method Not Allowed" });
});
