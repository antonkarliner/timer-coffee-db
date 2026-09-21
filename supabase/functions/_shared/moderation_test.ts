import {
  createModerationClient,
  DEFAULT_SURFACE_LABEL,
  JEV_MODERATION_QUESTIONS,
} from "./moderation.ts";
import type { JevResult } from "./jev-client.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function parseRequestBody(
  init: RequestInit | undefined,
): Record<string, unknown> {
  const typedInit = init as
    | (RequestInit & { body?: BodyInit | null })
    | undefined;
  return JSON.parse(String(typedInit?.body ?? "{}"));
}

Deno.test("uses groq gpt-oss-20b before other fallbacks", async () => {
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
    ["openai/gpt-oss-20b"],
    "Expected the first Groq model to satisfy the request.",
  );
});

Deno.test("falls back from groq gpt-oss-20b to groq llama-3.1-8b-instant", async () => {
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
      if (body.model === "openai/gpt-oss-20b") {
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
    ["openai/gpt-oss-20b", "llama-3.1-8b-instant"],
    "Expected both Groq models to be tried in order.",
  );
});

Deno.test("falls back to Gemini after both Groq models fail", async () => {
  const models: string[] = [];
  let geminiCalls = 0;
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
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
    ["openai/gpt-oss-20b", "llama-3.1-8b-instant"],
    "Expected both Groq models to be exhausted before Gemini.",
  );
  assert(
    geminiCalls == 1,
    "Expected Gemini fallback to be called exactly once.",
  );
});

Deno.test("sends per-model request fields: gpt-oss reasons low with room for JSON, llama keeps 32 tokens", async () => {
  const bodies: Record<string, unknown>[] = [];
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: async (_input, init) => {
      if (String(_input).includes("/moderations")) {
        return jsonResponse({ results: [{ flagged: false, categories: {} }] });
      }
      const body = parseRequestBody(init);
      bodies.push(body);
      // Fail gpt-oss so the llama request is captured too.
      if (body.model === "openai/gpt-oss-20b") {
        return jsonResponse(
          { error: { message: "json_validate_failed" } },
          400,
        );
      }
      return jsonResponse({
        choices: [{ message: { content: '{"contains_link_or_phone": true}' } }],
      });
    },
  });

  const result = await moderator.moderateText("order at beanhub dot io");

  assertEquals(
    result,
    { safe: false, reason: "Detected obfuscated link or phone number" },
    "Expected the llama fallback verdict to be used.",
  );
  const [gptOss, llama] = bodies;
  assertEquals(
    [gptOss.model, gptOss.reasoning_effort, gptOss.max_completion_tokens],
    ["openai/gpt-oss-20b", "low", 256],
    "gpt-oss needs reasoning_effort low and a budget above 32 tokens.",
  );
  assertEquals(
    gptOss.response_format,
    { type: "json_object" },
    "gpt-oss keeps json_object mode.",
  );
  assertEquals(
    [llama.model, llama.reasoning_effort, llama.max_completion_tokens],
    ["llama-3.1-8b-instant", undefined, 32],
    "llama must not receive reasoning_effort.",
  );
});

Deno.test("requires Groq or Gemini as the secondary provider", () => {
  let message = "";
  try {
    createModerationClient({ openaiApiKey: "openai-key" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(
    message,
    "Missing secondary moderation provider. Configure Groq or Gemini.",
    "Expected construction to fail without a secondary provider.",
  );
});

// ---------------------------------------------------------------------------
// Jev primary path (plan 034 cutover)
// ---------------------------------------------------------------------------

/** Minimal well-formed Jev result for the two questions this module asks. */
function jevResult(
  contactP: number,
  probabilities: Record<string, number>,
): JevResult {
  return {
    answers: {
      contact: { type: "noul", noul: contactP },
      violation: {
        type: "choice",
        choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
        probabilities,
        confidence: 1,
      },
    },
    usage: { input_tokens: 800, output_tokens: 100 },
    latencyMs: 420,
  };
}

const CLEAN_PROBS = {
  acceptable: 1,
  hateful_or_harassing: 0,
  sexually_explicit: 0,
  violent_threat_or_graphic: 0,
  self_harm_or_dangerous: 0,
  profanity_only: 0,
};

/** Fails the test if the legacy chain is reached. */
function forbiddenFetch(): typeof fetch {
  return ((input: string | URL | Request) => {
    throw new Error(
      `Legacy moderation must not run when Jev answered (called ${
        String(input)
      })`,
    );
  }) as unknown as typeof fetch;
}

Deno.test("Jev allows without touching omni or the Groq chain", async () => {
  let asked = 0;
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: forbiddenFetch(),
    jevAsk: async () => {
      asked += 1;
      return jevResult(0.03, CLEAN_PROBS);
    },
  });

  const result = await moderator.moderateText("отличная обжарка, 1:16.6666667");

  assertEquals(result, { safe: true }, "Expected the Jev verdict to allow.");
  assertEquals(asked, 1, "Expected exactly one batched Jev call.");
});

Deno.test("Jev blocks on contact at the 0.7 production threshold", async () => {
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: forbiddenFetch(),
    jevAsk: async () => jevResult(0.7, CLEAN_PROBS),
  });

  assertEquals(
    await moderator.moderateText("write me at beanhub dot io"),
    { safe: false, reason: "Detected link or phone number" },
    "p(contact) at the threshold must block.",
  );
});

Deno.test("a contact score just under the threshold is allowed", async () => {
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: forbiddenFetch(),
    // 0.45-0.50 is the observed score for handle-shaped display names such
    // as espresso_addict_1987, the case the 0.7 threshold exists to keep.
    jevAsk: async () => jevResult(0.5, CLEAN_PROBS),
  });

  assertEquals(
    await moderator.moderateText("espresso_addict_1987"),
    { safe: true },
    "Handle-shaped display names must survive the 0.7 contact threshold.",
  );
});

Deno.test("violation mass is summed across categories and named in the reason", async () => {
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: forbiddenFetch(),
    jevAsk: async () =>
      jevResult(0.01, {
        acceptable: 0.5,
        // Neither option reaches 0.5 alone; together they do.
        hateful_or_harassing: 0.3,
        sexually_explicit: 0.2,
        violent_threat_or_graphic: 0,
        self_harm_or_dangerous: 0,
        profanity_only: 0,
      }),
  });

  assertEquals(
    await moderator.moderateText("…"),
    { safe: false, reason: "Content flagged: hate or harassment" },
    "Summed violation mass at the threshold must block and name the heaviest option.",
  );
});

Deno.test("profanity is allowed by default and blocks when configured", async () => {
  const probs = {
    acceptable: 0.1,
    profanity_only: 0.9,
    hateful_or_harassing: 0,
    sexually_explicit: 0,
    violent_threat_or_graphic: 0,
    self_harm_or_dangerous: 0,
  };
  const build = (profanity: "allow" | "block") =>
    createModerationClient({
      openaiApiKey: "openai-key",
      groqApiKey: "groq-key",
      fetchImpl: forbiddenFetch(),
      thresholds: { profanity },
      jevAsk: async () => jevResult(0.01, probs),
    });

  assertEquals(
    await build("allow").moderateText("this roast is fucking great"),
    { safe: true },
    "The published rules do not forbid profanity, so it must pass by default.",
  );
  assertEquals(
    await build("block").moderateText("this roast is fucking great"),
    { safe: false, reason: "Content flagged: profanity" },
    "profanity: block must fold profanity_only into the violation mass.",
  );
});

Deno.test("a harm verdict outranks a contact verdict when both trip", async () => {
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: forbiddenFetch(),
    jevAsk: async () =>
      jevResult(0.95, {
        acceptable: 0,
        hateful_or_harassing: 0,
        sexually_explicit: 0,
        violent_threat_or_graphic: 0,
        self_harm_or_dangerous: 1,
        profanity_only: 0,
      }),
  });

  assertEquals(
    await moderator.moderateText("…"),
    { safe: false, reason: "Content flagged: self-harm or dangerous activity" },
    "The harm reason is the more specific one and must win.",
  );
});

Deno.test("sends the shared question set, the surface label and the timeout", async () => {
  const calls: { state: unknown; questions: unknown; opts: unknown }[] = [];
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: forbiddenFetch(),
    jevTimeoutMs: 650,
    jevAsk: async (state, questions, opts) => {
      calls.push({ state, questions, opts });
      return jevResult(0.01, CLEAN_PROBS);
    },
  });

  await moderator.moderateText("kill the bloom at 0:45", {
    surface: "recipe",
    correlationId: "corr-1",
  });
  await moderator.moderateText("kill the bloom at 0:45");

  assertEquals(
    calls[0].state,
    {
      where_it_appears:
        "public coffee brewing recipe (name, description, grind, steps)",
      text: "kill the bloom at 0:45",
    },
    "A known surface must send its evaluated label.",
  );
  assertEquals(
    (calls[1].state as { where_it_appears: string }).where_it_appears,
    DEFAULT_SURFACE_LABEL,
    "An unspecified surface must fall back to the generic label.",
  );
  assert(
    calls[0].questions === JEV_MODERATION_QUESTIONS,
    "Production must send the exact question object the harness evaluates.",
  );
  assertEquals(
    calls[0].opts,
    { timeoutMs: 650, correlationId: "corr-1" },
    "The configured Jev timeout and the correlation id must be passed through.",
  );
});

Deno.test("falls back to the full legacy chain when Jev returns null", async () => {
  const seen: string[] = [];
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    // jevAsk never throws; null is how it reports timeout, non-2xx, a
    // missing key or an off-contract body.
    jevAsk: async () => null,
    fetchImpl: async (input, init) => {
      if (String(input).includes("/moderations")) {
        seen.push("omni");
        return jsonResponse({ results: [{ flagged: false, categories: {} }] });
      }
      seen.push(String(parseRequestBody(init).model));
      return jsonResponse({
        choices: [{
          message: { content: '{"contains_link_or_phone": false}' },
        }],
      });
    },
  });

  assertEquals(
    await moderator.moderateText("harmless coffee text"),
    { safe: true },
    "The fallback must produce a verdict of its own.",
  );
  assertEquals(
    seen,
    ["omni", "openai/gpt-oss-20b"],
    "A Jev outage must run omni and the secondary check, in that order.",
  );
});

Deno.test("the regex pre-filter still guards the fallback path only", async () => {
  let jevCalls = 0;
  const regexBait = "call 555 123 4567";

  const blocked = await createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    jevAsk: async () => null,
    fetchImpl: forbiddenFetch(),
  }).moderateText(regexBait);
  assertEquals(
    blocked,
    { safe: false, reason: "Detected link or phone number" },
    "With Jev down, the regex must short-circuit before omni.",
  );

  const allowed = await createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    fetchImpl: forbiddenFetch(),
    jevAsk: async () => {
      jevCalls += 1;
      return jevResult(0.02, CLEAN_PROBS);
    },
  }).moderateText(regexBait);
  assertEquals(
    allowed,
    { safe: true },
    "With Jev up, its verdict stands; the regex never runs.",
  );
  assertEquals(jevCalls, 1, "Expected the Jev call to be the only check.");
});

Deno.test("falls back when Jev answers with the wrong answer types", async () => {
  let omniCalls = 0;
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    jevAsk: async () => ({
      // A `choice` where a `noul` was asked for: well-formed on the wire,
      // unusable here. It must never be read as "safe".
      answers: {
        contact: {
          type: "choice",
          choice: "acceptable",
          probabilities: { acceptable: 1 },
          confidence: 1,
        },
        violation: { type: "noul", noul: 0.1 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      latencyMs: 10,
    } as unknown as JevResult),
    fetchImpl: async (input) => {
      if (String(input).includes("/moderations")) {
        omniCalls += 1;
        return jsonResponse({
          results: [{ flagged: true, categories: { hate: true } }],
        });
      }
      throw new Error("unexpected call");
    },
  });

  assertEquals(
    await moderator.moderateText("…"),
    { safe: false, reason: "Content flagged: hate" },
    "An unusable Jev answer must hand over to the fallback, not allow.",
  );
  assertEquals(omniCalls, 1, "Expected the fallback's omni check to run.");
});

Deno.test("jevEnabled false skips Jev entirely", async () => {
  let jevCalls = 0;
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    jevEnabled: false,
    jevAsk: async () => {
      jevCalls += 1;
      return jevResult(0.99, CLEAN_PROBS);
    },
    fetchImpl: async (input) => {
      if (String(input).includes("/moderations")) {
        return jsonResponse({ results: [{ flagged: false, categories: {} }] });
      }
      return jsonResponse({
        choices: [{
          message: { content: '{"contains_link_or_phone": false}' },
        }],
      });
    },
  });

  assertEquals(
    await moderator.moderateText("harmless coffee text"),
    { safe: true },
    "The kill switch must leave the legacy pipeline in charge.",
  );
  assertEquals(jevCalls, 0, "The kill switch must not spend a Jev call.");
});

Deno.test("moderateTextLegacy bypasses Jev even when Jev is wired", async () => {
  let jevCalls = 0;
  const moderator = createModerationClient({
    openaiApiKey: "openai-key",
    groqApiKey: "groq-key",
    jevAsk: async () => {
      jevCalls += 1;
      return jevResult(0.01, CLEAN_PROBS);
    },
    fetchImpl: async (input) => {
      if (String(input).includes("/moderations")) {
        return jsonResponse({
          results: [{ flagged: true, categories: { violence: true } }],
        });
      }
      throw new Error("unexpected call");
    },
  });

  assertEquals(
    await moderator.moderateTextLegacy("…"),
    { safe: false, reason: "Content flagged: violence" },
    "The explicit legacy entry point must not consult Jev.",
  );
  assertEquals(jevCalls, 0, "moderateTextLegacy must not call Jev.");
});
