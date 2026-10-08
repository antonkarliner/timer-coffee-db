import { createRecipeDraftParser, type ProviderUsage } from "./parser.ts";
import { GEMINI_DEFAULT_MODEL } from "../_shared/ai-models.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function buildMinimalValidExtractionPayload() {
  return {
    detected_input_language: "en",
    likely_brewing_method: "V60",
    name: "Token Limit Test",
    short_description: "Tests per-stage token ceilings.",
    grind_size: "Medium",
    water_temp_celsius: 93,
    coffee_amount_grams: 15,
    water_amount: 250,
    preparation: "Rinse the filter and add the coffee.",
    steps: [
      {
        title: null,
        raw_text: "Pour 250g of water and wait 180 seconds.",
        duration_seconds: 180,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
    ],
    notes: [],
    total_brew_time_seconds: null,
  };
}

function buildMinimalValidNormalizedPayload() {
  return {
    detected_input_language: "en",
    warnings: [],
    recipe: {
      brewing_method_id: "v60",
      brewing_method_confidence: "high",
      coffee_amount: 15,
      water_amount: 250,
      water_temp: 93,
    },
    localization: {
      name: "Token Limit Test",
      grind_size: "Medium",
      short_description: "Tests per-stage token ceilings.",
    },
    steps: [
      {
        kind: "preparation",
        description_source: "Rinse the filter and add the coffee.",
        description_template: "Rinse the filter and add the coffee.",
        duration_seconds: 0,
        elapsed_seconds: null,
        starts_timer: false,
        duration_is_stated: false,
        scalable_amounts: [],
        step_role: null,
      },
      {
        kind: "brew",
        description_source: "Pour 250g of water and wait 180 seconds.",
        description_template: "Pour 250g of water and wait 180 seconds.",
        duration_seconds: 180,
        elapsed_seconds: null,
        starts_timer: true,
        duration_is_stated: true,
        scalable_amounts: [],
        step_role: null,
      },
    ],
  };
}

async function geminiCredentials() {
  const key = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", key.privateKey),
  );
  return JSON.stringify({
    client_email: "fake@example.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${
      btoa(String.fromCharCode(...bytes))
    }\n-----END PRIVATE KEY-----`,
  });
}

const parserInput = {
  text:
    "Rinse the filter and add coffee. Pour 250g of water and wait 180 seconds.",
  userId: "test-user",
  requestId: "test-request",
  sourceLanguageHint: "en",
  brewingMethods: [{ brewing_method_id: "v60", brewing_method: "V60" }],
};

Deno.test("Gemini generateContent uses the global endpoint despite configured region", async () => {
  const requestUrls: string[] = [];
  const parser = createRecipeDraftParser({
    geminiServiceAccountKeyJson: await geminiCredentials(),
    geminiProjectId: "fake",
    geminiRegion: "us-central1",
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: (url) => {
      if (String(url).includes("oauth2")) {
        return Promise.resolve(
          Response.json({ access_token: "fake", expires_in: 3600 }),
        );
      }
      requestUrls.push(String(url));
      const payload = requestUrls.length === 1
        ? buildMinimalValidExtractionPayload()
        : buildMinimalValidNormalizedPayload();
      return Promise.resolve(Response.json({
        candidates: [{
          content: { parts: [{ text: JSON.stringify(payload) }] },
          finishReason: "STOP",
        }],
        usageMetadata: { totalTokenCount: 37 },
      }));
    },
  });
  await parser.parseDraft(parserInput);
  const expectedUrl =
    `https://aiplatform.googleapis.com/v1/projects/fake/locations/global/publishers/google/models/${GEMINI_DEFAULT_MODEL}:generateContent`;
  equal(requestUrls, [expectedUrl, expectedUrl]);
});

for (const provider of ["openai", "gemini"] as const) {
  for (
    const outcome of [
      "length",
      "malformed",
      "schema",
      "empty",
      "success",
      "http",
      400,
      401,
      403,
      404,
      422,
      429,
      408,
      503,
      "fetch",
      "response-json",
    ] as const
  ) {
    Deno.test(`F14 ${provider}: usage once per attempt for ${outcome}`, async () => {
      const usages: ProviderUsage[] = [];
      let attempts = 0;
      const credentials = provider === "gemini"
        ? await geminiCredentials()
        : "";
      const parser = createRecipeDraftParser({
        ...(provider === "openai" ? { openAiApiKey: "fake" } : {
          geminiServiceAccountKeyJson: credentials,
          geminiProjectId: "fake",
          geminiRegion: "us-central1",
        }),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: (url) => {
          if (String(url).includes("oauth2")) {
            return Promise.resolve(
              Response.json({ access_token: "fake", expires_in: 3600 }),
            );
          }
          attempts++;
          if (outcome === "fetch") return Promise.reject(new Error("network"));
          if (typeof outcome === "number") {
            return Promise.resolve(Response.json({
              error: {
                message: "You have no credits remaining.",
                type: "insufficient_quota",
                param: null,
                code: "credit_balance_exhausted",
              },
            }, { status: outcome }));
          }
          if (outcome === "http") {
            return Promise.resolve(new Response("error", { status: 500 }));
          }
          if (outcome === "response-json") {
            return Promise.resolve(new Response("invalid"));
          }
          const payload = attempts === 1
            ? buildMinimalValidExtractionPayload()
            : buildMinimalValidNormalizedPayload();
          const content = outcome === "malformed"
            ? "{broken"
            : outcome === "schema"
            ? "{}"
            : outcome === "empty"
            ? ""
            : JSON.stringify(payload);
          return Promise.resolve(Response.json(
            provider === "openai"
              ? {
                choices: [{
                  message: { content },
                  finish_reason: outcome === "length" ? "length" : "stop",
                }],
                usage: { total_tokens: 37 },
              }
              : {
                candidates: [{
                  content: { parts: [{ text: content }] },
                  finishReason: outcome === "length" ? "MAX_TOKENS" : "STOP",
                }],
                usageMetadata: { totalTokenCount: 37 },
              },
          ));
        },
      });
      let failed = false;
      try {
        await parser.parseDraft({
          ...parserInput,
          onProviderUsage: (usage) => usages.push(usage),
        });
      } catch {
        failed = true;
      }
      equal(failed, outcome !== "success");
      equal(usages.length, attempts);
      equal(
        usages.map((u) => u.totalTokens),
        Array(attempts).fill(
          typeof outcome === "number"
            ? outcome < 500 && outcome !== 408 ? 0 : null
            : ["http", "fetch", "response-json"].includes(outcome)
            ? null
            : 37,
        ),
      );
      equal(
        usages.every((u) => u.provider === provider && u.model.length > 0),
        true,
      );
      if (outcome !== "success") equal(attempts, provider === "openai" ? 4 : 2);
    });
  }
}

Deno.test("F14 real parser reports failed first attempt and successful retry; throwing usage callbacks are isolated", async () => {
  for (const throws of [false, true]) {
    const usages: ProviderUsage[] = [];
    let attempts = 0;
    const parser = createRecipeDraftParser({
      openAiApiKey: "fake",
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: () => {
        attempts++;
        const content = attempts === 1 ? "{broken" : JSON.stringify(
          attempts === 2
            ? buildMinimalValidExtractionPayload()
            : buildMinimalValidNormalizedPayload(),
        );
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content }, finish_reason: "stop" }],
            usage: { total_tokens: 37 },
          }),
        );
      },
    });
    const result = await parser.parseDraft({
      ...parserInput,
      onProviderUsage(usage) {
        usages.push(usage);
        if (throws) throw new Error("observer");
      },
    });
    equal(usages.length, 3);
    equal(result.tokens_used, 74);
    equal(usages.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0), 111);
  }
});
