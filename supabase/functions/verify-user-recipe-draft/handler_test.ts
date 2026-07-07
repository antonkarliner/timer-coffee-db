import {
  createVerifyUserRecipeDraftHandler,
  type VerifyUserRecipeDraftHandlerDeps,
  type VerifyUserRecipeDraftRequest,
} from "./handler.ts";
import type {
  DraftStep,
  ParseUserRecipeDraftResponse,
  RecipeDraftParserInput,
} from "../parse-user-recipe-draft/parser.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      message + "\nExpected: " + expectedJson + "\nActual: " + actualJson,
    );
  }
}

async function json(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

function requestBody(
  overrides: Partial<VerifyUserRecipeDraftRequest> = {},
): VerifyUserRecipeDraftRequest {
  return {
    app_locale: "fr-FR",
    source_language_hint: "fr",
    consent_to_diagnostics: false,
    recipe: {
      name: "V60 clair",
      brewing_method_id: "v60",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
      brew_time_seconds: 120,
      grind_size: "Moyen",
      short_description: "Simple et clair",
    },
    steps: [
      {
        order: 1,
        kind: "preparation",
        description: "Rincer le filtre",
        duration_seconds: 0,
      },
      {
        order: 2,
        kind: "brew",
        description: "Verser 60g eau",
        duration_seconds: 30,
      },
    ],
    ...overrides,
  };
}

function parserResponse(
  steps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "Rincer le filtre",
      description_template: "Rincer le filtre",
      preview_text: "Rincer le filtre",
      duration_seconds: 0,
      expressions: [],
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Verser 60g eau",
      description_template: "Verser (0.24 x <final_water_amount>)g eau",
      preview_text: "Verser 60g eau",
      duration_seconds: 30,
      expressions: [],
    },
  ],
): ParseUserRecipeDraftResponse {
  return {
    detected_input_language: "fr",
    provider_used: "groq",
    provider_model_used: "groq/compound-mini",
    tokens_used: 100,
    openai_tokens_used: 0,
    warnings: [],
    validation: {
      is_publishable: true,
      issues: [],
    },
    extraction: {
      detected_input_language: "fr",
      likely_brewing_method: "V60",
      name: "V60 clair",
      short_description: "Simple et clair",
      grind_size: "Moyen",
      water_temp_celsius: 93,
      coffee_amount_grams: 15,
      water_amount: 250,
      preparation: "Rincer le filtre",
      steps: [
        {
          title: null,
          raw_text: "Verser 60g eau",
          duration_seconds: 30,
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
        name: "V60 clair",
        grind_size: "Moyen",
        short_description: "Simple et clair",
      },
      steps,
    },
  };
}

function createHandlerOverrides(
  options: {
    anonymous?: boolean;
    recentInvocationCount?: number;
    parserSteps?: ParseUserRecipeDraftResponse["draft"]["steps"];
  } = {},
): VerifyUserRecipeDraftHandlerDeps & {
  parseCalls: RecipeDraftParserInput[];
  diagnostics: unknown[];
} {
  const parseCalls: RecipeDraftParserInput[] = [];
  const diagnostics: unknown[] = [];
  return {
    parseCalls,
    diagnostics,
    parser: {
      parseDraft(input) {
        parseCalls.push(input);
        return Promise.resolve(parserResponse(options.parserSteps));
      },
    },
    getUserFromToken(token: string) {
      return Promise.resolve(
        token === "valid-token"
          ? { id: "user-1", isAnonymous: options.anonymous ?? false }
          : null,
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
    getRecentInvocationCount() {
      return Promise.resolve(options.recentInvocationCount ?? 0);
    },
    logInvocation() {
      return Promise.resolve({ id: 42 });
    },
    logDiagnostic(data) {
      diagnostics.push(data);
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

function post(body: unknown, token = "valid-token"): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.test("rejects missing bearer token", async () => {
  const handler = createVerifyUserRecipeDraftHandler(createHandlerOverrides());
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    }),
  );

  assertEquals(response.status, 401, "Expected 401 for missing token.");
});

Deno.test("rejects anonymous users", async () => {
  const handler = createVerifyUserRecipeDraftHandler(
    createHandlerOverrides({ anonymous: true }),
  );
  const response = await handler(post(requestBody()));

  assertEquals(response.status, 403, "Expected 403 for anonymous users.");
});

Deno.test("rejects invalid request schema", async () => {
  const handler = createVerifyUserRecipeDraftHandler(createHandlerOverrides());
  const response = await handler(post({ app_locale: "en" }));

  assertEquals(response.status, 400, "Expected 400 for invalid payload.");
});

Deno.test("passes locale and source language to parser and maps correction", async () => {
  const deps = createHandlerOverrides();
  const handler = createVerifyUserRecipeDraftHandler(deps);
  const response = await handler(post(requestBody()));

  const body = await json(response) as Record<string, unknown>;
  assertEquals(response.status, 200, "Expected successful verification.");
  assertEquals(
    deps.parseCalls[0].sourceLanguageHint,
    "fr",
    "Expected source language hint to reach parser.",
  );
  assertEquals(
    (body.corrected_steps as Array<Record<string, unknown>>)[1]
      .description_template,
    "Verser (0.24 x <final_water_amount>)g eau",
    "Expected corrected template in response.",
  );
});

Deno.test("does not log diagnostics without consent", async () => {
  const deps = createHandlerOverrides();
  const handler = createVerifyUserRecipeDraftHandler(deps);
  const response = await handler(post(requestBody()));

  assertEquals(response.status, 200, "Expected successful verification.");
  assertEquals(deps.diagnostics.length, 0, "Expected no diagnostics.");
});

Deno.test("logs diagnostics after consent", async () => {
  const deps = createHandlerOverrides();
  const handler = createVerifyUserRecipeDraftHandler(deps);
  const response = await handler(
    post(requestBody({ consent_to_diagnostics: true })),
  );

  assertEquals(response.status, 200, "Expected successful verification.");
  assertEquals(deps.diagnostics.length, 1, "Expected diagnostics log.");
});

Deno.test("enforces rate limit", async () => {
  const handler = createVerifyUserRecipeDraftHandler(
    createHandlerOverrides({ recentInvocationCount: 10 }),
  );
  const response = await handler(post(requestBody()));

  assertEquals(response.status, 429, "Expected rate limit rejection.");
});

Deno.test("rejects LLM output that changes step count", async () => {
  const handler = createVerifyUserRecipeDraftHandler(
    createHandlerOverrides({ parserSteps: [] }),
  );
  const response = await handler(post(requestBody()));

  assertEquals(response.status, 502, "Expected provider output rejection.");
});

Deno.test("passes verify mode to parser", async () => {
  const deps = createHandlerOverrides();
  const handler = createVerifyUserRecipeDraftHandler(deps);

  const response = await handler(post(requestBody()));

  assertEquals(response.status, 200, "Expected successful verification.");
  assertEquals(
    deps.parseCalls[0].mode,
    "verify",
    "Expected mode 'verify' to reach parser.",
  );
});

Deno.test("reverts AI rewrite that drops a numeric range", async () => {
  const lossySteps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "Rincer le filtre",
      description_template: "Rincer le filtre",
      preview_text: "Rincer le filtre",
      duration_seconds: 0,
      expressions: [],
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Add 50-100 grams of water",
      description_template: "Pour up to 100g",
      preview_text: "Pour up to 100g",
      duration_seconds: 30,
      expressions: [],
    },
  ];

  const deps = createHandlerOverrides({ parserSteps: lossySteps });
  const handler = createVerifyUserRecipeDraftHandler(deps);

  const response = await handler(
    post(
      requestBody({
        steps: [
          {
            order: 1,
            kind: "preparation",
            description: "Rincer le filtre",
            duration_seconds: 0,
          },
          {
            order: 2,
            kind: "brew",
            description: "Add 50-100 grams of water",
            duration_seconds: 30,
          },
        ],
      }),
    ),
  );

  assertEquals(response.status, 200, "Expected successful verification.");
  const body = await json(response) as Record<string, unknown>;
  assertEquals(
    (body.corrected_steps as Array<Record<string, unknown>>)[1]
      .description_template,
    "Add 50-100 grams of water",
    "Expected lossy range rewrite to be reverted to the input description.",
  );
});

Deno.test("reverts AI rewrite that drops the 'water' noun", async () => {
  const lossySteps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "Rincer le filtre",
      description_template: "Rincer le filtre",
      preview_text: "Rincer le filtre",
      duration_seconds: 0,
      expressions: [],
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Add 60g of water",
      description_template: "Add 60g",
      preview_text: "Add 60g",
      duration_seconds: 30,
      expressions: [],
    },
  ];

  const deps = createHandlerOverrides({ parserSteps: lossySteps });
  const handler = createVerifyUserRecipeDraftHandler(deps);

  const response = await handler(
    post(
      requestBody({
        steps: [
          {
            order: 1,
            kind: "preparation",
            description: "Rincer le filtre",
            duration_seconds: 0,
          },
          {
            order: 2,
            kind: "brew",
            description: "Add 60g of water",
            duration_seconds: 30,
          },
        ],
      }),
    ),
  );

  assertEquals(response.status, 200, "Expected successful verification.");
  const body = await json(response) as Record<string, unknown>;
  assertEquals(
    (body.corrected_steps as Array<Record<string, unknown>>)[1]
      .description_template,
    "Add 60g of water",
    "Expected lossy noun rewrite to be reverted to the input description.",
  );
});

Deno.test("reverts AI rewrite of a generic 'Preparation' placeholder", async () => {
  const lossySteps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "Preparation",
      description_template: "Prepare the V60 setup.",
      preview_text: "Prepare the V60 setup.",
      duration_seconds: 0,
      expressions: [],
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Verser 60g eau",
      description_template: "Verser 60g eau",
      preview_text: "Verser 60g eau",
      duration_seconds: 30,
      expressions: [],
    },
  ];

  const deps = createHandlerOverrides({ parserSteps: lossySteps });
  const handler = createVerifyUserRecipeDraftHandler(deps);

  const response = await handler(
    post(
      requestBody({
        steps: [
          {
            order: 1,
            kind: "preparation",
            description: "Preparation",
            duration_seconds: 0,
          },
          {
            order: 2,
            kind: "brew",
            description: "Verser 60g eau",
            duration_seconds: 30,
          },
        ],
      }),
    ),
  );

  assertEquals(response.status, 200, "Expected successful verification.");
  const body = await json(response) as Record<string, unknown>;
  assertEquals(
    (body.corrected_steps as Array<Record<string, unknown>>)[0]
      .description_template,
    "Preparation",
    "Expected hallucinated preparation rewrite to be reverted.",
  );
});
