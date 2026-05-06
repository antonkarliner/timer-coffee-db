import { createModerationClient } from "./moderation.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  const typedInit = init as (RequestInit & { body?: BodyInit | null }) | undefined;
  return JSON.parse(String(typedInit?.body ?? "{}"));
}

Deno.test("uses groq compound-mini before other fallbacks", async () => {
  const models: string[] = [];
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: async (_input, init) => {
      const body = parseRequestBody(init);

      if (String(_input).includes("/moderations")) {
        return jsonResponse({
          results: [
            {
              flagged: false,
              categories: {},
            },
          ],
        });
      }

      models.push(String(body.model));
      return jsonResponse({
        choices: [
          {
            message: {
              content: '{"contains_link_or_phone": false}',
            },
          },
        ],
      });
    },
  });

  const result = await moderator.moderateText("harmless coffee text");

  assertEquals(result, { safe: true }, "Expected moderation to pass.");
  assertEquals(
    models,
    ["groq/compound-mini"],
    "Expected the first Groq model to satisfy the request.",
  );
});

Deno.test("falls back from groq compound-mini to groq llama-3.1-8b-instant", async () => {
  const models: string[] = [];
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: async (_input, init) => {
      const body = parseRequestBody(init);

      if (String(_input).includes("/moderations")) {
        return jsonResponse({
          results: [
            {
              flagged: false,
              categories: {},
            },
          ],
        });
      }

      models.push(String(body.model));
      if (body.model === "groq/compound-mini") {
        return jsonResponse(
          {
            error: {
              message: "Bad Request",
            },
          },
          400,
        );
      }

      return jsonResponse({
        choices: [
          {
            message: {
              content: '{"contains_link_or_phone": false}',
            },
          },
        ],
      });
    },
  });

  const result = await moderator.moderateText("harmless coffee text");

  assertEquals(result, { safe: true }, "Expected moderation to pass.");
  assertEquals(
    models,
    ["groq/compound-mini", "llama-3.1-8b-instant"],
    "Expected both Groq models to be tried in order.",
  );
});

Deno.test("falls back to Cerebras after Groq models fail", async () => {
  const models: string[] = [];
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    cerebrasApiKey: "cerebras-key",
    fetchImpl: async (_input, init) => {
      const body = parseRequestBody(init);

      if (String(_input).includes("/moderations")) {
        return jsonResponse({
          results: [
            {
              flagged: false,
              categories: {},
            },
          ],
        });
      }

      models.push(String(body.model));
      if (body.model !== "llama3.1-8b") {
        return jsonResponse(
          {
            error: {
              message: "Provider failure",
            },
          },
          500,
        );
      }

      return jsonResponse({
        choices: [
          {
            message: {
              content: '{"contains_link_or_phone": false}',
            },
          },
        ],
      });
    },
  });

  const result = await moderator.moderateText("harmless coffee text");

  assertEquals(result, { safe: true }, "Expected moderation to pass.");
  assertEquals(
    models,
    ["groq/compound-mini", "llama-3.1-8b-instant", "llama3.1-8b"],
    "Expected Cerebras to run after both Groq models fail.",
  );
});

Deno.test("falls back to Gemini after Groq and Cerebras fail", async () => {
  const models: string[] = [];
  let geminiCalls = 0;
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    cerebrasApiKey: "cerebras-key",
    geminiModerateText: async (_text) => {
      geminiCalls += 1;
      return { safe: true };
    },
    fetchImpl: async (_input, init) => {
      const body = parseRequestBody(init);

      if (String(_input).includes("/moderations")) {
        return jsonResponse({
          results: [
            {
              flagged: false,
              categories: {},
            },
          ],
        });
      }

      models.push(String(body.model));
      return jsonResponse(
        {
          error: {
            message: "Provider failure",
          },
        },
        500,
      );
    },
  });

  const result = await moderator.moderateText("harmless coffee text");

  assertEquals(result, { safe: true }, "Expected Gemini fallback to pass.");
  assertEquals(
    models,
    ["groq/compound-mini", "llama-3.1-8b-instant", "llama3.1-8b"],
    "Expected Groq and Cerebras fallbacks to be exhausted before Gemini.",
  );
  assert(geminiCalls == 1, "Expected Gemini fallback to be called exactly once.");
});
