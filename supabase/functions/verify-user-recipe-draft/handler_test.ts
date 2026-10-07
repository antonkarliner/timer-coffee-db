import {
  createVerifyUserRecipeDraftHandler,
  type VerifyUserRecipeDraftHandlerDeps,
  type VerifyUserRecipeDraftRequest,
} from "./handler.ts";
import { createRecipeDraftParser } from "../parse-user-recipe-draft/parser.ts";
import type {
  BrewingMethodOption,
  DraftStep,
  ExtractionResult,
  NormalizedDraft,
  ParseUserRecipeDraftResponse,
  RecipeDraftAiProvider,
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
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Verser 60g eau",
      description_template: "Verser (0.24 x <final_water_amount>)g eau",
      preview_text: "Verser 60g eau",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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
      extracted_amounts: [],
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
          elapsed_seconds: null,
          starts_timer: false,
          duration_is_stated: false,
          scalable_amounts: [],
          step_role: null,
        },
      ],
      notes: [],
      total_brew_time_seconds: null,
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
    // Stage-capture (opt-in via capture_stages, parse-user-recipe-draft
    // only) — verify-user-recipe-draft never sets captureStages on its
    // parseDraft call, so these are always null/no-op here. Present only
    // because they're now required fields on the shared response type.
    capture_id: null,
    stage_outputs: null,
  };
}

function createHandlerOverrides(
  options: {
    anonymous?: boolean;
    recentInvocationCount?: number;
    parserSteps?: ParseUserRecipeDraftResponse["draft"]["steps"];
    parser?: VerifyUserRecipeDraftHandlerDeps["parser"];
    brewingMethods?: BrewingMethodOption[];
  } = {},
): VerifyUserRecipeDraftHandlerDeps & {
  parseCalls: RecipeDraftParserInput[];
  diagnostics: unknown[];
  finalizations: Parameters<
    VerifyUserRecipeDraftHandlerDeps["finalizeInvocation"]
  >[0][];
} {
  const parseCalls: RecipeDraftParserInput[] = [];
  const diagnostics: unknown[] = [];
  const finalizations: Parameters<
    VerifyUserRecipeDraftHandlerDeps["finalizeInvocation"]
  >[0][] = [];
  return {
    parseCalls,
    diagnostics,
    finalizations,
    parser: options.parser ?? {
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
      return Promise.resolve(
        options.brewingMethods ?? [
          {
            brewing_method_id: "v60",
            brewing_method: "Hario V60",
          },
        ],
      );
    },
    admitInvocation() {
      return Promise.resolve({
        admitted: (options.recentInvocationCount ?? 0) < 10,
        invocationId: 42,
        openAiAllowed: true,
      });
    },
    finalizeInvocation(data) {
      finalizations.push(data);
      return Promise.resolve();
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
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Add 50-100 grams of water",
      description_template: "Pour up to 100g",
      preview_text: "Pour up to 100g",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Add 60g of water",
      description_template: "Add 60g",
      preview_text: "Add 60g",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Verser 60g eau",
      description_template: "Verser 60g eau",
      preview_text: "Verser 60g eau",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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

// Defect 2 (Aug 2026 live pass): a live request sent
// "الإعداد: Filter einlegen und Dripper vorbereiten." and got back
// "Filter einlegen und Dripper vorbereiten." — the Arabic "الإعداد"
// ("preparation") prefix was silently dropped. Two bugs combined:
// GENERIC_PREPARATION_PLACEHOLDERS had no Arabic (or Chinese/Hebrew)
// entries at all, and the guard only ever fired on WHOLE-STRING equality,
// so even a language it did recognize would never protect a "placeholder:
// real content" prefix. The fix restores only the missing prefix rather
// than reverting the whole (correctly-translated-preserving) step.
Deno.test("restores a dropped Arabic preparation-label prefix instead of reverting the whole step", async () => {
  const lossySteps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "الإعداد: Filter einlegen und Dripper vorbereiten.",
      description_template: "Filter einlegen und Dripper vorbereiten.",
      preview_text: "Filter einlegen und Dripper vorbereiten.",
      duration_seconds: 0,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Verser 60g eau",
      description_template: "Verser 60g eau",
      preview_text: "Verser 60g eau",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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
            description: "الإعداد: Filter einlegen und Dripper vorbereiten.",
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
    "الإعداد: Filter einlegen und Dripper vorbereiten.",
    "Expected the dropped Arabic preparation-label prefix to be restored, keeping the model's (correctly preserved) German content intact.",
  );
});

// Same shape as the Arabic case above, but for Chinese ("准备:") and
// Hebrew ("הכנה:") — both were also entirely missing from
// GENERIC_PREPARATION_PLACEHOLDERS before this fix.
Deno.test("restores a dropped Chinese and Hebrew preparation-label prefix", async () => {
  const cases: Array<{ label: string; input: string; content: string }> = [
    {
      label: "Chinese",
      input: "准备：冲洗滤纸并预热。",
      content: "冲洗滤纸并预热。",
    },
    {
      label: "Hebrew",
      input: "הכנה: שטפו את הפילטר וחממו מראש.",
      content: "שטפו את הפילטר וחממו מראש.",
    },
  ];

  for (const testCase of cases) {
    const lossySteps: DraftStep[] = [
      {
        step_order: 1,
        kind: "preparation" as const,
        description_source: testCase.input,
        description_template: testCase.content,
        preview_text: testCase.content,
        duration_seconds: 0,
        expressions: [],
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        step_order: 2,
        kind: "brew" as const,
        description_source: "Verser 60g eau",
        description_template: "Verser 60g eau",
        preview_text: "Verser 60g eau",
        duration_seconds: 30,
        expressions: [],
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
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
              description: testCase.input,
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

    assertEquals(
      response.status,
      200,
      `Expected successful verification for the ${testCase.label} case.`,
    );
    const body = await json(response) as Record<string, unknown>;
    assertEquals(
      (body.corrected_steps as Array<Record<string, unknown>>)[0]
        .description_template,
      testCase.input,
      `Expected the dropped ${testCase.label} preparation-label prefix to be restored.`,
    );
  }
});

// The whole-string case (a BARE placeholder with no real content of its
// own) must still fully revert, exactly as before — a prefix restoration
// must never weaken that existing guard.
Deno.test("still fully reverts a bare Arabic preparation placeholder with no real content", async () => {
  const lossySteps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "الإعداد",
      description_template: "Place and rinse the V60 filter.",
      preview_text: "Place and rinse the V60 filter.",
      duration_seconds: 0,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Verser 60g eau",
      description_template: "Verser 60g eau",
      preview_text: "Verser 60g eau",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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
            description: "الإعداد",
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
    "الإعداد",
    "Expected the bare Arabic placeholder rewrite to be fully reverted, same as the bare-English 'Preparation' case.",
  );
});

// Live defect, 2026-08-12 (plans/009 §"Live browser robustness regression",
// plans/012): a real verify run kept its step count (4 in, 4 out) and none
// of the guards above fired — no range, water noun, coffee noun, or
// preparation placeholder was lost — yet step 3 lost its leading elapsed-time
// landmark "At 0:45," AND had its amount spacing reflowed ("50 g" -> "50g",
// "300 g" -> "300g") in the same response. The step-count guard alone cannot
// catch this: it only proves the NUMBER of steps didn't change, not that
// each step's wording survived. This is the case the new drift guard exists
// for.
Deno.test("reverts AI rewrite that drops an elapsed-time landmark even when amount spacing is also reflowed", async () => {
  const lossySteps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "Rincer le filtre",
      description_template: "Rincer le filtre",
      preview_text: "Rincer le filtre",
      duration_seconds: 0,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Pour to 50 g",
      description_template: "Pour to 50g",
      preview_text: "Pour to 50g",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 3,
      kind: "brew" as const,
      // Live failure: the source explicitly stated the pour happens at
      // 0:45, and the model dropped that clause while also reflowing "300
      // g" -> "300g" in the same step.
      description_source: "At 0:45, pour to 300 g",
      description_template: "pour to 300g",
      preview_text: "pour to 300g",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: 45,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 4,
      kind: "brew" as const,
      description_source: "Let it drain fully",
      description_template: "Let it drain fully",
      preview_text: "Let it drain fully",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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
            description: "Pour to 50 g",
            duration_seconds: 30,
          },
          {
            order: 3,
            kind: "brew",
            description: "At 0:45, pour to 300 g",
            duration_seconds: 30,
          },
          {
            order: 4,
            kind: "brew",
            description: "Let it drain fully",
            duration_seconds: 30,
          },
        ],
      }),
    ),
  );

  assertEquals(response.status, 200, "Expected successful verification.");
  const body = await json(response) as Record<string, unknown>;
  const correctedSteps = body.corrected_steps as Array<
    Record<string, unknown>
  >;
  assertEquals(
    correctedSteps[2].description_template,
    "At 0:45, pour to 300 g",
    "Expected the dropped elapsed-time landmark to force a revert to the submitted wording, not just a step-count check to pass.",
  );
});

// Sanity check for the same guard in the opposite direction: a step whose
// ONLY change is cosmetic amount-unit spacing (no dropped or reordered
// wording) must NOT be reverted. Otherwise the guard would fire on every
// single run, which is exactly the false-positive risk of a naive
// string-equality check between submitted text and the returned template.
Deno.test("does not revert a step whose only change is amount unit spacing", async () => {
  const lossySteps: DraftStep[] = [
    {
      step_order: 1,
      kind: "preparation" as const,
      description_source: "Rincer le filtre",
      description_template: "Rincer le filtre",
      preview_text: "Rincer le filtre",
      duration_seconds: 0,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
    },
    {
      step_order: 2,
      kind: "brew" as const,
      description_source: "Pour to 50 g of water",
      description_template: "Pour to 50g of water",
      preview_text: "Pour to 50g of water",
      duration_seconds: 30,
      expressions: [],
      elapsed_seconds: null,
      starts_timer: false,
      duration_is_stated: false,
      scalable_amounts: [],
      step_role: null,
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
            description: "Pour to 50 g of water",
            duration_seconds: 30,
          },
        ],
      }),
    ),
  );

  assertEquals(response.status, 200, "Expected successful verification.");
  const body = await json(response) as Record<string, unknown>;
  const correctedSteps = body.corrected_steps as Array<
    Record<string, unknown>
  >;
  assertEquals(
    correctedSteps[1].description_template,
    "Pour to 50g of water",
    "Expected cosmetic amount-spacing-only reflow to be left as the model returned it, not reverted.",
  );
});

// --- Plan 010 §5 item 2: end-to-end step-count-invariant regression tests ---
//
// Everything above this line stubs `deps.parser` directly, so it never
// exercises the real deterministic passes in parser.ts (in particular
// foldPreTimerStepsIntoPreparation and the synthetic drawdown append) that
// plan 010 §3 gated on `mode === "verify"`. The tests below wire the REAL
// parser (via createRecipeDraftParser) with a minimal mock AI provider, so a
// future regression that re-enables either pass for verify mode fails here
// — as a 502 from the handler — and not only inside parser_test.ts.

function createFixedResponseProvider(
  extraction: ExtractionResult,
  normalized: NormalizedDraft,
): RecipeDraftAiProvider {
  return {
    name: "groq",
    model: "groq/compound-mini",
    invokeJson<T>(input: { stage: string }) {
      if (input.stage === "extraction") {
        return Promise.resolve(
          { result: extraction as unknown as T, tokensUsed: 0 },
        );
      }
      if (input.stage === "normalization") {
        return Promise.resolve(
          { result: normalized as unknown as T, tokensUsed: 0 },
        );
      }
      return Promise.reject(
        new Error(`Mock provider does not support stage: ${input.stage}`),
      );
    },
  };
}

function createRealParser(
  extraction: ExtractionResult,
  normalized: NormalizedDraft,
  now: () => number,
): VerifyUserRecipeDraftHandlerDeps["parser"] {
  return createRecipeDraftParser({
    providers: [createFixedResponseProvider(extraction, normalized)],
    now,
  });
}

// Mirrors parser_test.ts's createHarioSwitchPreTimerExtraction /
// createHarioSwitchPreTimerNormalized (~lines 3448 and 3517): a Hario
// Switch recipe fills the dripper and adds coffee BEFORE starting the
// timer, so the `starts_timer` brew step lands at index > 1 and, in
// extract mode, foldPreTimerStepsIntoPreparation would merge the first
// three brew steps into the preparation step, shrinking 6 steps to 3.
function createHarioSwitchPreTimerExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Hario Switch",
    name: "Hario Switch",
    short_description: "Tests folding pre-timer actions into preparation",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 18,
    water_amount: 250,
    preparation: "Place the dripper on the Switch in closed position.",
    steps: [
      {
        title: null,
        raw_text: "Fill the dripper with water.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Add coffee and stir to saturate the grounds.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Wait for the grounds to settle.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Start the timer, open the switch, and stir gently until 0:40.",
        duration_seconds: 40,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text: "Then add water, close the switch, and let steep until 1:25.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function createHarioSwitchPreTimerNormalized(): NormalizedDraft {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "medium",
      coffee_amount: 18,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Hario Switch",
      grind_size: "Medium",
      short_description: "Tests folding pre-timer actions into preparation",
    },
    steps: [
      {
        kind: "preparation",
        description_source:
          "Place the dripper on the Switch in closed position.",
        description_template:
          "Place the dripper on the Switch in closed position.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Fill the dripper with water.",
        description_template: "Fill the dripper with 200g water.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Add coffee and stir to saturate the grounds.",
        description_template:
          "Add 18g coffee and stir to saturate the grounds.",
        duration_seconds: 15,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Wait for the grounds to settle.",
        description_template: "Wait 10 seconds for the grounds to settle.",
        duration_seconds: 10,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Start the timer, open the switch, and stir gently until 0:40.",
        description_template:
          "Start the timer, open the switch, and stir gently until 0:40.",
        duration_seconds: 40,
        elapsed_seconds: 0,
        starts_timer: true,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source:
          "Then add water, close the switch, and let steep until 1:25.",
        description_template:
          "Then add 50g water, close the switch, and let steep until 1:25.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

// Mirrors parser_test.ts's createChemexNaturalElapsedExtraction /
// createChemexNaturalElapsedNormalized (~lines 806 and 877): an English
// recipe with monotonic elapsed timestamps whose extraction reports a total
// brew time (240s) comfortably past the last timestamped step's own end
// (0+45+65+80+5=195s), with no existing `step_role: "drawdown"` step. In
// extract mode this makes normalizeAbsoluteTimestampDurations APPEND a
// synthetic "Wait for the complete drawdown." step, growing 5 steps to 6
// (proven by the parser_test.ts extract-mode test at line 2613).
function createChemexNaturalElapsedExtraction(): ExtractionResult {
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    likely_brewing_method: "Chemex",
    name: "ChemX",
    short_description:
      "The ChemX is the perfect combination of design and utility.",
    grind_size:
      "medium coarse, slightly finer than you would for a French press",
    water_temp_celsius: 96.1,
    coffee_amount_grams: 50,
    water_amount: 700,
    preparation:
      "A 6 cup Chemex, a Chemex filter, 50 grams of coffee, a scale with a timer, a kettle, and a grinder. Begin by heating about a full kettle of water to between 205 and 210 degrees. Place the filter in the chemex. Ensure the trifold portion of the filter is facing the pouring spout of the brewer. Rinse the filter thoroughly and pour out the excess water. Next, grind your coffee to a medium coarse level, slightly finer than you would for a French press. Place the grounds in the filter and gently shake to create a level coffee bed. Set the chemex on the scale and tear it.",
    steps: [
      {
        title: "Bloom pour",
        raw_text:
          "Start your timer and begin your first pour, known as the Bloom pour. Starting in the center, spiral your pour out and back until the coffee is completely saturated. Target adding around 100 grams of water.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Start the second pour at 45 seconds. Using the same pour pattern, spiral out towards the edge of the slurry before spiraling back. Unlike some other brewers, avoid pouring directly on the filter and bring the water weight up to 300 grams. The water should filter through the grounds almost completely before starting the next pour.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "At a minute and 50 seconds, start your third pour, still using the same pouring pattern. Bringing the water weight up to 500 grams. Pause again, allowing the water to filter through the grounds.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        title: null,
        raw_text:
          "Begin the fourth and final pour at 3 minutes and 10 seconds. Still focusing on a consistent pour pattern, bring the water weight up to 700 grams.",
        duration_seconds: null,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [
      "Timed references like 45 seconds, a minute and 50 seconds, and 3 minutes and 10 seconds are elapsed brew times, not step durations.",
    ],
    total_brew_time_seconds: 240,
  };
}

function createChemexNaturalElapsedNormalized(): NormalizedDraft {
  const extraction = createChemexNaturalElapsedExtraction();
  return {
    extracted_amounts: [],
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "chemex",
      brewing_method_confidence: "high",
      coffee_amount: 50,
      water_amount: 700,
      water_temp: 96.1,
    },
    localization: {
      name: "ChemX",
      grind_size:
        "medium coarse, slightly finer than you would for a French press",
      short_description: "Tests natural elapsed time parsing.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: extraction.preparation!,
        description_template:
          "Use a 6 cup Chemex with a Chemex filter, heat water to 96.1, place and rinse the filter with the trifold facing the spout, grind 50g of coffee medium coarse, add the grounds, level the bed, and set the Chemex on a scale and tare it.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: extraction.steps[0].raw_text,
        description_template:
          "Start the timer and pour up to 100g, spiraling from the center out and back until the coffee is completely saturated.",
        duration_seconds: 45,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: extraction.steps[1].raw_text,
        description_template:
          "At 45 seconds, pour up to 300g using the same spiral pattern, avoiding the filter, and let the water drain almost completely before the next pour.",
        duration_seconds: 65,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: extraction.steps[2].raw_text,
        description_template:
          "pour up to 500g using the same pouring pattern, then pause and let the water filter through.",
        duration_seconds: 80,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: extraction.steps[3].raw_text,
        description_template: "pour up to 700g with a consistent pour pattern.",
        duration_seconds: 5,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

Deno.test("preserves step count end-to-end through the real parser for a Hario-Switch-style pre-timer recipe (plan 010 §5 item 2)", async () => {
  const extraction = createHarioSwitchPreTimerExtraction();
  const normalized = createHarioSwitchPreTimerNormalized();
  const request = requestBody({
    recipe: {
      name: "Hario Switch immersion",
      brewing_method_id: "v60",
      coffee_amount: 18,
      water_amount: 250,
      water_temp: 93,
      brew_time_seconds: 85,
      grind_size: "Medium",
      short_description: "Immersion then drip using the switch",
    },
    steps: [
      {
        order: 1,
        kind: "preparation",
        description: "Place the dripper on the Switch in closed position.",
        duration_seconds: 0,
      },
      {
        order: 2,
        kind: "brew",
        description: "Fill the dripper with water.",
        duration_seconds: 15,
      },
      {
        order: 3,
        kind: "brew",
        description: "Add coffee and stir to saturate the grounds.",
        duration_seconds: 15,
      },
      {
        order: 4,
        kind: "brew",
        description: "Wait for the grounds to settle.",
        duration_seconds: 10,
      },
      {
        order: 5,
        kind: "brew",
        description:
          "Start the timer, open the switch, and stir gently until 0:40.",
        duration_seconds: 40,
      },
      {
        order: 6,
        kind: "brew",
        description:
          "Then add water, close the switch, and let steep until 1:25.",
        duration_seconds: 45,
      },
    ],
  });

  const deps = createHandlerOverrides({
    parser: createRealParser(extraction, normalized, () => 1776000000000),
  });
  const handler = createVerifyUserRecipeDraftHandler(deps);
  const response = await handler(post(request));

  assertEquals(
    response.status,
    200,
    "Expected 200, not a 502 step-count rejection, for a pre-timer recipe shape.",
  );
  const body = await json(response) as Record<string, unknown>;
  const correctedSteps = body.corrected_steps as Array<
    Record<string, unknown>
  >;
  assertEquals(
    correctedSteps.length,
    request.steps.length,
    "Expected corrected_steps to preserve the request's step count instead of folding pre-timer actions away.",
  );
});

Deno.test("preserves step count end-to-end through the real parser for a drawdown-synthesis-shaped recipe (plan 010 §5 item 2)", async () => {
  const extraction = createChemexNaturalElapsedExtraction();
  const normalized = createChemexNaturalElapsedNormalized();
  const request = requestBody({
    app_locale: "en-US",
    source_language_hint: "en",
    recipe: {
      name: "ChemX",
      brewing_method_id: "chemex",
      coffee_amount: 50,
      water_amount: 700,
      water_temp: 96.1,
      brew_time_seconds: 240,
      grind_size:
        "medium coarse, slightly finer than you would for a French press",
      short_description:
        "The ChemX is the perfect combination of design and utility.",
    },
    steps: [
      {
        order: 1,
        kind: "preparation",
        description:
          "Set up the Chemex with a filter, grind and add the coffee, and tare the scale.",
        duration_seconds: 0,
      },
      {
        order: 2,
        kind: "brew",
        description: "Start the timer and pour up to 100g for the bloom pour.",
        duration_seconds: 45,
      },
      {
        order: 3,
        kind: "brew",
        description: "At 45 seconds, pour up to 300g.",
        duration_seconds: 65,
      },
      {
        order: 4,
        kind: "brew",
        description: "Pour up to 500g using the same pouring pattern.",
        duration_seconds: 80,
      },
      {
        order: 5,
        kind: "brew",
        description: "Pour up to 700g with a consistent pour pattern.",
        duration_seconds: 5,
      },
    ],
  });

  const deps = createHandlerOverrides({
    parser: createRealParser(extraction, normalized, () => 1777808888503),
    brewingMethods: [
      { brewing_method_id: "chemex", brewing_method: "Chemex" },
    ],
  });
  const handler = createVerifyUserRecipeDraftHandler(deps);
  const response = await handler(post(request));

  assertEquals(
    response.status,
    200,
    "Expected 200, not a 502 step-count rejection, for a drawdown-synthesis recipe shape.",
  );
  const body = await json(response) as Record<string, unknown>;
  const correctedSteps = body.corrected_steps as Array<
    Record<string, unknown>
  >;
  assertEquals(
    correctedSteps.length,
    request.steps.length,
    "Expected corrected_steps to preserve the request's step count instead of appending a synthetic drawdown step.",
  );
});

Deno.test("F14 concurrent admission caps parser calls at ten", async () => {
  const deps = createHandlerOverrides();
  let admitted = 0;
  deps.admitInvocation = () =>
    Promise.resolve({
      admitted: admitted++ < 10,
      invocationId: admitted,
      openAiAllowed: true,
    });
  const handler = createVerifyUserRecipeDraftHandler(deps);
  const responses = await Promise.all(
    Array.from({ length: 11 }, () => handler(post(requestBody()))),
  );
  assertEquals(
    responses.filter((r) => r.status === 200).length,
    10,
    "ten admitted",
  );
  assertEquals(
    responses.filter((r) => r.status === 429).length,
    1,
    "one denied",
  );
  assertEquals(deps.parseCalls.length, 10, "ten parser calls");
  assertEquals(deps.finalizations.length, 10, "one finalization per admission");
});

Deno.test("F14 admission errors fail closed before parser", async () => {
  const deps = createHandlerOverrides();
  deps.admitInvocation = () => Promise.reject(new Error("database"));
  const response = await createVerifyUserRecipeDraftHandler(deps)(
    post(requestBody()),
  );
  assertEquals(response.status, 503, "unavailable");
  assertEquals(await json(response), {
    error: "Service Unavailable",
    message: "AI recipe review is temporarily unavailable.",
  }, "body");
  assertEquals(deps.parseCalls.length, 0, "no provider");
  assertEquals(deps.finalizations.length, 0, "no admitted row");
});

Deno.test("F14 every validation and brewing-method exit finalizes once", async () => {
  for (const path of ["schema", "json", "unknown", "load"] as const) {
    const deps = createHandlerOverrides(
      path === "unknown" ? { brewingMethods: [] } : {},
    );
    if (path === "load") {
      deps.getBrewingMethods = () => Promise.reject(new Error("load"));
    }
    const request = path === "json"
      ? new Request("http://localhost", {
        method: "POST",
        headers: { Authorization: "Bearer valid-token" },
        body: "{",
      })
      : post(path === "schema" ? {} : requestBody());
    const response = await createVerifyUserRecipeDraftHandler(deps)(request);
    assertEquals(response.status, path === "load" ? 502 : 400, path);
    assertEquals(deps.finalizations.length, 1, "once");
    assertEquals(deps.finalizations[0].status, "failed", "failed");
    assertEquals(deps.finalizations[0].tokensUsed, 0, "zero tokens");
  }
});

Deno.test("F14 billed attempts accumulate on failure, fallback, and step mismatch", async () => {
  for (
    const path of [
      "throw",
      "success",
      "mismatch",
      "unknown-openai",
      "unknown-gemini",
      "finalize-error",
    ] as const
  ) {
    const deps = createHandlerOverrides();
    deps.admitInvocation = () =>
      Promise.resolve({
        admitted: true,
        invocationId: 42,
        openAiAllowed: false,
      });
    deps.parser = {
      parseDraft(input) {
        assertEquals(
          input.disabledProviders,
          ["openai"],
          "budget disables OpenAI",
        );
        input.onProviderUsage?.({
          provider: "openai",
          model: "test",
          stage: "extraction",
          totalTokens: 30,
        });
        input.onProviderUsage?.({
          provider: "gemini",
          model: "test",
          stage: "extraction",
          totalTokens: 70,
        });
        if (path === "unknown-openai" || path === "unknown-gemini") {
          input.onProviderUsage?.({
            provider: path === "unknown-openai" ? "openai" : "gemini",
            model: "test",
            stage: "extraction",
            totalTokens: null,
          });
        }
        if (path === "throw") {
          return Promise.reject(new Error("billed failure"));
        }
        return Promise.resolve(
          parserResponse(path === "mismatch" ? [] : undefined),
        );
      },
    };
    if (path === "finalize-error") {
      const finalize = deps.finalizeInvocation;
      deps.finalizeInvocation = async (data) => {
        await finalize(data);
        throw new Error("database");
      };
    }
    const response = await createVerifyUserRecipeDraftHandler(deps)(
      post(requestBody()),
    );
    assertEquals(
      response.status,
      path === "throw" || path === "mismatch" ? 502 : 200,
      path,
    );
    assertEquals(deps.finalizations.length, 1, "once");
    assertEquals(deps.finalizations[0].tokensUsed, 100, "all attempts");
    assertEquals(deps.finalizations[0].openaiTokensUsed, 30, "OpenAI only");
    assertEquals(
      deps.finalizations[0].billingUnknown,
      path === "unknown-openai",
      "unknown OpenAI only",
    );
    assertEquals(
      deps.finalizations[0].status,
      response.status === 200 ? "succeeded" : "failed",
      "status",
    );
    if (response.status === 200) {
      assertEquals(
        (await json(response) as Record<string, unknown>).tokens_used,
        100,
        "compatible response",
      );
    }
  }
});

for (const failure of ["length", "malformed", "schema"] as const) {
  Deno.test(`F14 real parser ${failure} records billed failures`, async () => {
    const deps = createHandlerOverrides();
    deps.parser = createRecipeDraftParser({
      openAiApiKey: "fake",
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            choices: [{
              message: { content: failure === "malformed" ? "{broken" : "{}" },
              finish_reason: failure === "length" ? "length" : "stop",
            }],
            usage: { total_tokens: 25 },
          }),
        ),
    });
    const response = await createVerifyUserRecipeDraftHandler(deps)(
      post(requestBody()),
    );
    assertEquals(response.status, 502, "provider failure");
    assertEquals(deps.finalizations.length, 1, "once");
    assertEquals(deps.finalizations[0].status, "failed", "failed");
    assertEquals(
      deps.finalizations[0].tokensUsed,
      100,
      "two attempts per OpenAI model",
    );
    assertEquals(
      deps.finalizations[0].openaiTokensUsed,
      100,
      "all billed OpenAI tokens",
    );
  });
}

Deno.test("F14 real parser fallback accounts for both failed attempts and successful stages", async () => {
  const deps = createHandlerOverrides();
  const normalized: NormalizedDraft = {
    detected_input_language: "fr",
    warnings: [],
    extracted_amounts: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "V60 clair",
      grind_size: "Moyen",
      short_description: "Simple et clair",
    },
    steps: parserResponse().draft.steps,
  };
  const provider = (fail: boolean): RecipeDraftAiProvider => ({
    name: "openai",
    model: "fake",
    invokeJson<T>(
      input: Pick<
        Parameters<RecipeDraftAiProvider["invokeJson"]>[0],
        "stage" | "onUsage"
      >,
    ) {
      input.onUsage?.({
        provider: "openai",
        model: "fake",
        stage: input.stage,
        totalTokens: fail ? 30 : 70,
      });
      if (fail) return Promise.reject(new Error("billed attempt"));
      return Promise.resolve({
        result: (input.stage === "extraction"
          ? parserResponse().extraction
          : normalized) as T,
        tokensUsed: 70,
      });
    },
  });
  deps.parser = createRecipeDraftParser({
    providers: [provider(true), provider(false)],
    logger: { info() {}, warn() {}, error() {} },
  });
  const response = await createVerifyUserRecipeDraftHandler(deps)(
    post(requestBody()),
  );
  assertEquals(response.status, 200, "fallback success");
  assertEquals(deps.finalizations.length, 1, "once");
  assertEquals(
    deps.finalizations[0].tokensUsed,
    200,
    "60 failed + 140 successful",
  );
  assertEquals(
    deps.finalizations[0].openaiTokensUsed,
    200,
    "all OpenAI attempts",
  );
  assertEquals(
    (await json(response) as Record<string, unknown>).tokens_used,
    140,
    "response remains successful attempts only",
  );
});

Deno.test("input caps keep the OpenAI reservation an upper bound", async () => {
  const baseStep = requestBody().steps[1];
  const tooManySteps = requestBody({
    steps: Array.from({ length: 51 }, (_, index) => ({
      ...baseStep,
      order: index + 1,
    })),
  });
  const longStep = requestBody({
    steps: [{ ...baseStep, description: "x".repeat(1001) }],
  });
  const atTheCaps = requestBody({
    steps: Array.from({ length: 50 }, (_, index) => ({
      ...baseStep,
      order: index + 1,
      description: "x".repeat(1000),
    })),
  });
  for (
    const [body, status] of [[tooManySteps, 400], [longStep, 400]] as const
  ) {
    const deps = createHandlerOverrides();
    const response = await createVerifyUserRecipeDraftHandler(deps)(post(body));
    assertEquals(response.status, status, "rejected over the cap");
    assertEquals(deps.finalizations.length, 1, "admitted attempt finalized");
    assertEquals(deps.finalizations[0].status, "failed", "counts as failed");
  }
  const deps = createHandlerOverrides();
  const response = await createVerifyUserRecipeDraftHandler(deps)(
    post(atTheCaps),
  );
  assertEquals(
    response.status === 400,
    false,
    "a request exactly at the caps is not rejected by the schema",
  );
});
