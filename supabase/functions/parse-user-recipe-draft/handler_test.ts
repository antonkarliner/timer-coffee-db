import {
  createParseUserRecipeDraftHandler,
  type ParseUserRecipeDraftHandlerDeps,
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

function createHandlerOverrides(): ParseUserRecipeDraftHandlerDeps {
  return {
    parser: {
      parseDraft() {
        return Promise.resolve({
          detected_input_language: "en",
          provider_used: "groq" as const,
          provider_model_used: "groq/compound-mini",
          tokens_used: 100,
          openai_tokens_used: 0,
          warnings: [],
          validation: {
            is_publishable: true,
            issues: [],
          },
          extraction: {
            detected_input_language: "en",
            likely_brewing_method: "Hario V60",
            name: "Bright V60",
            short_description: "Simple and bright",
            grind_size: "Medium",
            water_temp_celsius: 93,
            coffee_amount_grams: 15,
            water_amount: 250,
            preparation: "Rinse the filter.",
            steps: [
              {
                title: null,
                raw_text: "Rinse the filter.",
                duration_seconds: null,
              },
            ],
            notes: [],
          },
          draft: {
            recipe: {
              brewing_method_id: "v60",
              coffee_amount: 15,
              water_amount: 250,
              water_temp: 93,
              brew_time_seconds: 30,
              vendor_id: "usr-user-1",
            },
            localization: {
              locale: "en",
              name: "Bright V60",
              grind_size: "Medium",
              short_description: "Simple and bright",
            },
            steps: [],
          },
        });
      },
    },
    getUserFromToken(token: string) {
      return Promise.resolve(token === "valid-token" ? { id: "user-1" } : null);
    },
    getRecipeDraftLabAccess(userId: string) {
      return Promise.resolve(
        userId === "user-1"
          ? {
            allowed: true as const,
            role: "roaster_admin" as const,
          }
          : {
            allowed: false as const,
          },
      );
    },
    getBrewingMethods() {
      return Promise.resolve([
        {
          brewing_method_id: "v60",
          brewing_method: "Hario V60",
        },
      ]);
    },
    getOpenAiDailyTokensUsed() {
      return Promise.resolve(0);
    },
    logInvocation() {
      return Promise.resolve();
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
  const handler = createParseUserRecipeDraftHandler(createHandlerOverrides());
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "recipe",
      }),
    }),
  );

  assertEquals(response.status, 401, "Expected 401 for missing token.");
});

Deno.test("rejects authenticated users without active roaster profile", async () => {
  const handler = createParseUserRecipeDraftHandler({
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
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "recipe",
      }),
    }),
  );

  assertEquals(response.status, 403, "Expected 403 for non-admin user.");
});

Deno.test("allows authenticated service admins without roaster profile ownership", async () => {
  const handler = createParseUserRecipeDraftHandler({
    ...createHandlerOverrides(),
    getRecipeDraftLabAccess(userId: string) {
      return Promise.resolve(
        userId === "user-1"
          ? {
            allowed: true,
            role: "service_admin",
          }
          : {
            allowed: false,
          },
      );
    },
  });
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "recipe",
      }),
    }),
  );

  const body = await json(response) as Record<string, unknown>;
  assertEquals(response.status, 200, "Expected 200 for service admin access.");
  assertEquals(
    body.provider_used,
    "groq",
    "Expected parser response passthrough.",
  );
  assertEquals(
    body.provider_model_used,
    "groq/compound-mini",
    "Expected parser model response passthrough.",
  );
});

Deno.test("allows authenticated recipe draft lab testers", async () => {
  const handler = createParseUserRecipeDraftHandler({
    ...createHandlerOverrides(),
    getRecipeDraftLabAccess(userId: string) {
      return Promise.resolve(
        userId === "user-1"
          ? {
            allowed: true,
            role: "tester",
          }
          : {
            allowed: false,
          },
      );
    },
  });
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "recipe",
      }),
    }),
  );

  const body = await json(response) as Record<string, unknown>;
  assertEquals(response.status, 200, "Expected 200 for tester access.");
  assertEquals(
    body.provider_used,
    "groq",
    "Expected parser response passthrough.",
  );
});

Deno.test("returns parsed draft for valid roaster admin requests", async () => {
  const handler = createParseUserRecipeDraftHandler(createHandlerOverrides());
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "recipe",
        brewing_method_id: "v60",
      }),
    }),
  );

  const body = await json(response) as Record<string, unknown>;
  assertEquals(response.status, 200, "Expected 200 for a valid request.");
  assertEquals(
    body.provider_used,
    "groq",
    "Expected parser response passthrough.",
  );
  assertEquals(
    body.provider_model_used,
    "groq/compound-mini",
    "Expected parser model response passthrough.",
  );
});
