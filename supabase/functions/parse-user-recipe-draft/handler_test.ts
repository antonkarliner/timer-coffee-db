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

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
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
                elapsed_seconds: null,
                starts_timer: false,
                duration_is_stated: false,
                scalable_amounts: [],
                step_role: null,
              },
            ],
            notes: [],
            total_brew_time_seconds: null,
            extracted_amounts: [],
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
          capture_id: null,
          stage_outputs: null,
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
    // plan 043 Ph 6: default callers have accepted the current beta notice.
    getRecipeMakerConsent() {
      return Promise.resolve({
        noticeVersion: "2026-10-beta-1",
        accepted: true,
      });
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
    captureStages() {
      return Promise.resolve("capture-1");
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

Deno.test("accepts connected-app tokens (website agent tool)", async () => {
  // Payload: {"sub":"user-id","client_id":"oauth-client"}
  const connectedAppToken =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWlkIiwiY2xpZW50X2lkIjoib2F1dGgtY2xpZW50In0.signature";
  const handler = createParseUserRecipeDraftHandler({
    ...createHandlerOverrides(),
    getUserFromToken(token: string) {
      return Promise.resolve(
        token === connectedAppToken ? { id: "user-1" } : null,
      );
    },
  });
  const response = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connectedAppToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "recipe",
        brewing_method_id: "v60",
      }),
    }),
  );

  assertEquals(
    response.status,
    200,
    "Expected connected-app tokens to be allowed.",
  );
});

// Task 1: parseUserRecipeDraftRequestSchema now accepts an optional `mode`,
// and the handler must forward it to parser.parseDraft unchanged so callers
// (e.g. a future verify-mode consumer of this function) can reach the
// parser's conservative "verify" prompts, which already exist but were
// previously unreachable through this handler.

Deno.test("passes mode: verify through to the parser when the request specifies it", async () => {
  const overrides = createHandlerOverrides();
  let capturedMode: string | undefined | "unset" = "unset";
  const handler = createParseUserRecipeDraftHandler({
    ...overrides,
    parser: {
      parseDraft(input) {
        capturedMode = input.mode;
        return overrides.parser.parseDraft(input);
      },
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
        brewing_method_id: "v60",
        mode: "verify",
      }),
    }),
  );

  assertEquals(response.status, 200, "Expected 200 for a valid request.");
  assertEquals(
    capturedMode,
    "verify",
    "Expected the parser to receive mode: 'verify' when the request specifies it.",
  );
});

Deno.test("omits mode when the request does not specify one, leaving the parser's own extract default in effect", async () => {
  const overrides = createHandlerOverrides();
  let capturedMode: string | undefined | "unset" = "unset";
  const handler = createParseUserRecipeDraftHandler({
    ...overrides,
    parser: {
      parseDraft(input) {
        capturedMode = input.mode;
        return overrides.parser.parseDraft(input);
      },
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
        brewing_method_id: "v60",
      }),
    }),
  );

  assertEquals(response.status, 200, "Expected 200 for a valid request.");
  assertEquals(
    capturedMode,
    undefined,
    "Expected no mode request field to reach the parser as undefined, matching today's behaviour where parseDraft itself defaults to 'extract'.",
  );
});

// Stage-capture (opt-in via capture_stages) — see plans/011-recipe-draft-
// lab-live-test-runbook.md for why this exists.

function requestWithCaptureStages(captureStages: boolean | undefined) {
  return new Request("http://localhost", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "recipe",
      brewing_method_id: "v60",
      ...(captureStages === undefined ? {} : { capture_stages: captureStages }),
    }),
  });
}

Deno.test("capture_stages omitted: captureStages dep is never called and capture_id is null", async () => {
  const overrides = createHandlerOverrides();
  let captureStagesCalls = 0;
  const handler = createParseUserRecipeDraftHandler({
    ...overrides,
    // plan 043 Ph 6: opt-in-only behaviour belongs to service admins.
    getRecipeDraftLabAccess() {
      return Promise.resolve({ allowed: true, role: "service_admin" });
    },
    captureStages() {
      captureStagesCalls += 1;
      return Promise.resolve("capture-should-not-happen");
    },
  });

  const response = await handler(requestWithCaptureStages(undefined));
  const body = await json(response) as Record<string, unknown>;

  assertEquals(response.status, 200, "Expected 200 for a valid request.");
  assertEquals(
    captureStagesCalls,
    0,
    "Expected the captureStages dep never called when capture_stages is omitted.",
  );
  assertEquals(
    body.capture_id,
    null,
    "Expected capture_id null when capture wasn't requested.",
  );
});

Deno.test("capture_stages: false: captureStages dep is never called and capture_id is null", async () => {
  const overrides = createHandlerOverrides();
  let captureStagesCalls = 0;
  const handler = createParseUserRecipeDraftHandler({
    ...overrides,
    // plan 043 Ph 6: opt-in-only behaviour belongs to service admins.
    getRecipeDraftLabAccess() {
      return Promise.resolve({ allowed: true, role: "service_admin" });
    },
    captureStages() {
      captureStagesCalls += 1;
      return Promise.resolve("capture-should-not-happen");
    },
  });

  const response = await handler(requestWithCaptureStages(false));
  const body = await json(response) as Record<string, unknown>;

  assertEquals(response.status, 200, "Expected 200 for a valid request.");
  assertEquals(
    captureStagesCalls,
    0,
    "Expected the captureStages dep never called when capture_stages is explicitly false.",
  );
  assertEquals(
    body.capture_id,
    null,
    "Expected capture_id null when capture wasn't requested.",
  );
});

// Fills in a plausible stage_outputs value the way parseDraft itself would
// when captureStages is requested — the shared handler-test parser stub
// otherwise returns a static canned response with stage_outputs: null,
// which would never exercise the handler's capture-insert branch.
function createCaptureAwareParserOverride(
  baseParser: ParseUserRecipeDraftHandlerDeps["parser"],
): ParseUserRecipeDraftHandlerDeps["parser"] {
  return {
    async parseDraft(input) {
      const base = await baseParser.parseDraft(input);
      if (!input.captureStages) {
        return base;
      }

      return {
        ...base,
        stage_outputs: {
          extraction: [
            {
              attempt: 1,
              provider: "groq",
              model: "groq/compound-mini",
              finish_reason: "stop",
              // A sentinel distinct from any legitimate response field (the
              // public response also has its own, unrelated raw_text field
              // at extraction.steps[].raw_text) so the leak-check test below
              // can assert on content that could ONLY have come from
              // stage_outputs, rather than the ambient substring "raw_text".
              raw_text: "STAGE_CAPTURE_RAW_TEXT_SENTINEL",
              parsed: { name: "Bright V60" },
              error: null,
            },
          ],
          normalization: [],
          repair: [],
          cumulative_rewrite: [],
        },
      };
    },
  };
}

Deno.test("capture_stages: true calls captureStages exactly once with all four stage keys, and echoes capture_id", async () => {
  const overrides = createHandlerOverrides();
  const captureCalls: Array<{ stageOutputs: Record<string, unknown> }> = [];
  const handler = createParseUserRecipeDraftHandler({
    ...overrides,
    parser: createCaptureAwareParserOverride(overrides.parser),
    captureStages(data) {
      captureCalls.push(data);
      return Promise.resolve("capture-xyz");
    },
  });

  const response = await handler(requestWithCaptureStages(true));
  const body = await json(response) as Record<string, unknown>;

  assertEquals(response.status, 200, "Expected 200 for a valid request.");
  assertEquals(
    captureCalls.length,
    1,
    "Expected the captureStages dep called exactly once.",
  );
  assertEquals(
    Object.keys(captureCalls[0]!.stageOutputs).sort(),
    ["cumulative_rewrite", "extraction", "normalization", "repair"],
    "Expected all four stage keys present on the captured stageOutputs.",
  );
  assertEquals(
    body.capture_id,
    "capture-xyz",
    "Expected capture_id echoed into the response.",
  );
});

Deno.test("a captureStages failure is non-fatal: still 200 with capture_id null", async () => {
  const overrides = createHandlerOverrides();
  const handler = createParseUserRecipeDraftHandler({
    ...overrides,
    parser: createCaptureAwareParserOverride(overrides.parser),
    captureStages() {
      return Promise.reject(new Error("insert failed"));
    },
  });

  const response = await handler(requestWithCaptureStages(true));
  const body = await json(response) as Record<string, unknown>;

  assertEquals(
    response.status,
    200,
    "Expected 200 even when the capture insert throws — a capture failure must never cost the user a successful parse.",
  );
  assertEquals(
    body.capture_id,
    null,
    "Expected capture_id null when the capture insert failed.",
  );
});

Deno.test("stage_outputs never reaches the serialized HTTP response body", async () => {
  const overrides = createHandlerOverrides();
  const handler = createParseUserRecipeDraftHandler({
    ...overrides,
    parser: createCaptureAwareParserOverride(overrides.parser),
    captureStages() {
      return Promise.resolve("capture-leak-check");
    },
  });

  const response = await handler(requestWithCaptureStages(true));
  const rawBodyText = await response.text();

  assertEquals(response.status, 200, "Expected 200 for a valid request.");
  assert(
    !rawBodyText.includes("stage_outputs"),
    "Expected stage_outputs to never appear in the serialized HTTP response body.",
  );
  // Not a bare "raw_text" substring check: the PUBLIC response legitimately
  // has its own, unrelated raw_text field at extraction.steps[].raw_text.
  // The sentinel below only ever appears inside the mocked stage_outputs'
  // capture entry, so its absence is what actually proves no leak.
  assert(
    !rawBodyText.includes("STAGE_CAPTURE_RAW_TEXT_SENTINEL"),
    "Expected raw per-attempt capture text to never leak into the serialized HTTP response body.",
  );

  const body = JSON.parse(rawBodyText) as Record<string, unknown>;
  assertEquals(
    body.capture_id,
    "capture-leak-check",
    "Expected capture_id present in the serialized response body.",
  );
});

// Plan 043 Phase 6: synthetic requests only; observe consent ordering and capture.
function createConsentTestHandler(options: {
  role: "roaster_admin" | "tester" | "service_admin";
  accepted?: boolean;
  lookupThrows?: boolean;
  captureThrows?: boolean;
}) {
  const base = createHandlerOverrides();
  const calls = {
    consentUsers: [] as string[],
    parserInputs: [] as Parameters<typeof base.parser.parseDraft>[0][],
    captures: [] as Parameters<typeof base.captureStages>[0][],
  };
  const parser = createCaptureAwareParserOverride(base.parser);
  const handler = createParseUserRecipeDraftHandler({
    ...base,
    getRecipeDraftLabAccess() {
      return Promise.resolve({ allowed: true, role: options.role });
    },
    getRecipeMakerConsent(userId) {
      calls.consentUsers.push(userId);
      if (options.lookupThrows) {
        return Promise.reject(new Error("synthetic consent lookup failure"));
      }
      return Promise.resolve({
        noticeVersion: "2026-10-beta-1",
        accepted: options.accepted ?? true,
      });
    },
    parser: {
      parseDraft(input) {
        calls.parserInputs.push(input);
        return parser.parseDraft(input);
      },
    },
    captureStages(data) {
      calls.captures.push(data);
      if (options.captureThrows) {
        return Promise.reject(new Error("synthetic capture failure"));
      }
      return Promise.resolve("synthetic-capture-id");
    },
  });
  return { handler, calls };
}

for (const role of ["roaster_admin", "tester"] as const) {
  Deno.test(`${role} without consent is rejected before parsing or capture`, async () => {
    const { handler, calls } = createConsentTestHandler({
      role,
      accepted: false,
    });
    const response = await handler(requestWithCaptureStages(true));
    assertEquals(response.status, 403, "Consent is required.");
    assertEquals(await json(response), {
      error: "consent_required",
      notice_version: "2026-10-beta-1",
      message: "Accept the recipe maker beta notice before creating recipes.",
    }, "Return the current notice and consent message.");
    assertEquals(
      calls.consentUsers,
      ["user-1"],
      "Look up the authenticated user.",
    );
    assertEquals(calls.parserInputs.length, 0, "Do not parse.");
    assertEquals(calls.captures.length, 0, "Do not capture.");
  });
}

Deno.test("service_admin without consent bypasses the lookup", async () => {
  const { handler, calls } = createConsentTestHandler({
    role: "service_admin",
    accepted: false,
    lookupThrows: true,
  });
  const response = await handler(requestWithCaptureStages(undefined));
  assertEquals(response.status, 200, "Service admins are exempt.");
  assertEquals(calls.consentUsers.length, 0, "Never look up admin consent.");
  assertEquals(calls.parserInputs.length, 1, "Parse once.");
});

Deno.test("consent lookup failure fails closed with 503", async () => {
  const { handler, calls } = createConsentTestHandler({
    role: "roaster_admin",
    lookupThrows: true,
  });
  const response = await handler(requestWithCaptureStages(undefined));
  assertEquals(response.status, 503, "Lookup failure is unavailable.");
  assertEquals(await json(response), {
    error: "Service Unavailable",
    message: "Could not verify recipe maker consent.",
  }, "Return the consent lookup failure message.");
  assertEquals(calls.parserInputs.length, 0, "Do not parse.");
  assertEquals(calls.captures.length, 0, "Do not capture.");
});

for (const captureFlag of [undefined, false]) {
  Deno.test(`consented roaster_admin forces capture with capture_stages ${captureFlag}`, async () => {
    const { handler, calls } = createConsentTestHandler({
      role: "roaster_admin",
    });
    const response = await handler(requestWithCaptureStages(captureFlag));
    const body = await json(response) as Record<string, unknown>;
    assertEquals(response.status, 200, "Consented user may parse.");
    assertEquals(calls.parserInputs.length, 1, "Parse once.");
    assertEquals(
      calls.parserInputs[0].captureStages,
      true,
      "Produce stage outputs.",
    );
    assertEquals(calls.captures.length, 1, "Capture once even without opt-in.");
    assertEquals(
      calls.captures[0].noticeVersion,
      "2026-10-beta-1",
      "Record consent version.",
    );
    assertEquals(
      calls.captures[0].userId,
      "user-1",
      "Capture belongs to caller.",
    );
    assertEquals(
      calls.captures[0].stageOutputs.extraction.length,
      1,
      "Keep raw stage output.",
    );
    assertEquals(body.capture_id, "synthetic-capture-id", "Echo capture id.");
    assertEquals("stage_outputs" in body, false, "Keep stages internal.");
  });
}

Deno.test("consented tester also forces capture", async () => {
  const { handler, calls } = createConsentTestHandler({ role: "tester" });
  const response = await handler(requestWithCaptureStages(false));
  assertEquals(response.status, 200, "Consented tester may parse.");
  assertEquals(calls.parserInputs[0].captureStages, true, "Produce stages.");
  assertEquals(calls.captures.length, 1, "Capture tester parse.");
  assertEquals(
    calls.captures[0].noticeVersion,
    "2026-10-beta-1",
    "Record notice.",
  );
});

for (const captureFlag of [true, undefined]) {
  Deno.test(`service_admin capture remains opt-in with capture_stages ${captureFlag}`, async () => {
    const { handler, calls } = createConsentTestHandler({
      role: "service_admin",
    });
    const response = await handler(requestWithCaptureStages(captureFlag));
    const body = await json(response) as Record<string, unknown>;
    assertEquals(response.status, 200, "Admin may parse.");
    assertEquals(calls.consentUsers.length, 0, "Admin bypasses consent.");
    assertEquals(
      calls.parserInputs[0].captureStages,
      captureFlag ?? false,
      "Forward admin opt-in.",
    );
    assertEquals(
      calls.captures.length,
      captureFlag ? 1 : 0,
      "Capture only on opt-in.",
    );
    if (captureFlag) {
      assertEquals(
        calls.captures[0].noticeVersion,
        null,
        "Admin capture has no notice.",
      );
    }
    assertEquals(
      body.capture_id,
      captureFlag ? "synthetic-capture-id" : null,
      "Return capture id only for capture.",
    );
  });
}

Deno.test("required capture insert failure preserves successful parse", async () => {
  const { handler, calls } = createConsentTestHandler({
    role: "roaster_admin",
    captureThrows: true,
  });
  const response = await handler(requestWithCaptureStages(undefined));
  const body = await json(response) as Record<string, unknown>;
  assertEquals(response.status, 200, "Required capture failure is non-fatal.");
  assertEquals(calls.captures.length, 1, "Attempt required capture.");
  assertEquals(body.capture_id, null, "No capture id on failure.");
  assertEquals(
    "stage_outputs" in body,
    false,
    "Stages stay internal on failure.",
  );
});

for (const invalidBody of ["{", JSON.stringify({ text: 42 })]) {
  Deno.test(`unconsented roaster_admin gets 403 before body validation: ${invalidBody}`, async () => {
    const { handler, calls } = createConsentTestHandler({
      role: "roaster_admin",
      accepted: false,
    });
    const request = new Request("http://localhost", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
      },
      body: invalidBody,
    });
    const response = await handler(request);
    assertEquals(
      response.status,
      403,
      "Consent gate precedes invalid body errors.",
    );
    assertEquals(
      request.bodyUsed,
      false,
      "Do not read the body before consent.",
    );
    assertEquals(calls.parserInputs.length, 0, "Do not parse.");
    assertEquals(calls.captures.length, 0, "Do not capture.");
  });
}
