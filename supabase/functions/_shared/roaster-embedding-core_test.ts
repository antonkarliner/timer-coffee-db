import {
  buildEmbeddingInput,
  type EmbeddingCoreDeps,
  generateRoasterNameEmbedding,
  ROASTER_EMBEDDING_DIMENSIONS,
} from "./roaster-embedding-core.ts";
import {
  EmbeddingConfigError,
  EmbeddingInputError,
  EmbeddingResponseError,
  HttpSourceError,
} from "./roaster-postprocess-errors.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function assertThrows<T extends Error>(
  fn: () => Promise<unknown>,
  expectedClass: new (...args: never[]) => T,
  messageIncludes?: string,
): Promise<T> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof expectedClass)) {
      throw new Error(
        `Expected ${expectedClass.name}, got: ${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`,
      );
    }
    if (messageIncludes && !error.message.includes(messageIncludes)) {
      throw new Error(
        `Expected message to include "${messageIncludes}", got: "${error.message}"`,
      );
    }
    return error;
  }
  throw new Error(`Expected ${expectedClass.name} to be thrown`);
}

// ---------------------------------------------------------------------------
// buildEmbeddingInput — ported verbatim from
// generate-roaster-embedding/request-utils_test.ts (no case lost)
// ---------------------------------------------------------------------------

Deno.test("buildEmbeddingInput uses canonical names and normalized aliases", () => {
  assertEquals(
    buildEmbeddingInput("  Tim Wendelboe  ", " TW, Tim Wendelboe Oslo, "),
    "Tim Wendelboe TW Tim Wendelboe Oslo",
    "Name and aliases should be trimmed and joined.",
  );
  assertEquals(
    buildEmbeddingInput("Swerl", null),
    "Swerl",
    "A roaster without aliases should use only its name.",
  );
  assertEquals(
    buildEmbeddingInput("Swerl", " , "),
    "Swerl",
    "Empty aliases should be ignored.",
  );
  assertEquals(
    buildEmbeddingInput("   ", "Alias"),
    null,
    "A missing canonical name should be rejected.",
  );
});

// ---------------------------------------------------------------------------
// generateRoasterNameEmbedding
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function makeFetch(
  respond: () => { status: number; body: unknown },
): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (url, init) => {
    requests.push({ url: String(url), init });
    const { status, body } = respond();
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetchImpl, requests };
}

function vectorOf(length: number, value = 0.25): number[] {
  return Array.from({ length }, () => value);
}

interface StubWorld {
  updates: Array<{ roasterId: number; embedding: number[] }>;
}

function makeDeps(
  fetchImpl: typeof fetch,
  apiKey: string | null | undefined = "test-api-key",
): { deps: EmbeddingCoreDeps; world: StubWorld } {
  const world: StubWorld = { updates: [] };
  const deps: EmbeddingCoreDeps = {
    openAiApiKey: apiKey,
    model: "fake-embedding-model",
    fetchImpl,
    updateRoasterEmbedding: async (roasterId, embedding) => {
      world.updates.push({ roasterId, embedding });
    },
  };
  return { deps, world };
}

Deno.test("generateRoasterNameEmbedding throws EmbeddingConfigError without an api key", async () => {
  const { fetchImpl, requests } = makeFetch(() => ({
    status: 200,
    body: { data: [{ embedding: vectorOf(ROASTER_EMBEDDING_DIMENSIONS) }] },
  }));
  for (const missingKey of [undefined, null]) {
    const world: StubWorld = { updates: [] };
    const deps: EmbeddingCoreDeps = {
      openAiApiKey: missingKey,
      model: "fake-embedding-model",
      fetchImpl,
      updateRoasterEmbedding: async (roasterId, embedding) => {
        world.updates.push({ roasterId, embedding });
      },
    };
    await assertThrows(
      () =>
        generateRoasterNameEmbedding(deps, {
          roasterId: 1,
          roasterName: "Swerl",
          aliases: null,
        }),
      EmbeddingConfigError,
      "OPENAI_API_KEY",
    );
    assertEquals(world.updates.length, 0, "no DB write without a key");
  }
  assertEquals(requests.length, 0, "no HTTP call without a key");
});

Deno.test("generateRoasterNameEmbedding throws EmbeddingInputError when there is no canonical name", async () => {
  const { fetchImpl, requests } = makeFetch(() => ({
    status: 200,
    body: { data: [{ embedding: vectorOf(ROASTER_EMBEDDING_DIMENSIONS) }] },
  }));
  const { deps, world } = makeDeps(fetchImpl);
  await assertThrows(
    () =>
      generateRoasterNameEmbedding(deps, {
        roasterId: 7,
        roasterName: "   ",
        aliases: "An alias",
      }),
    EmbeddingInputError,
    "no canonical name",
  );
  assertEquals(requests.length, 0, "no HTTP call for an empty name");
  assertEquals(world.updates.length, 0, "no DB write for an empty name");
});

Deno.test("generateRoasterNameEmbedding throws HttpSourceError on provider 429", async () => {
  const { fetchImpl, requests } = makeFetch(() => ({
    status: 429,
    body: { error: { message: "rate limited" } },
  }));
  const { deps, world } = makeDeps(fetchImpl);
  const error = await assertThrows(
    () =>
      generateRoasterNameEmbedding(deps, {
        roasterId: 1,
        roasterName: "Swerl",
        aliases: null,
      }),
    HttpSourceError,
  );
  assertEquals(error.status, 429, "429 status is preserved");
  assertEquals(world.updates.length, 0, "no DB write on provider failure");
});

Deno.test("generateRoasterNameEmbedding throws HttpSourceError on provider 500", async () => {
  const { fetchImpl } = makeFetch(() => ({
    status: 500,
    body: { error: { message: "boom" } },
  }));
  const { deps } = makeDeps(fetchImpl);
  const error = await assertThrows(
    () =>
      generateRoasterNameEmbedding(deps, {
        roasterId: 1,
        roasterName: "Swerl",
        aliases: null,
      }),
    HttpSourceError,
  );
  assertEquals(error.status, 500, "500 status is preserved");
});

Deno.test("generateRoasterNameEmbedding throws HttpSourceError on provider 400", async () => {
  const { fetchImpl } = makeFetch(() => ({
    status: 400,
    body: { error: { message: "bad request" } },
  }));
  const { deps } = makeDeps(fetchImpl);
  const error = await assertThrows(
    () =>
      generateRoasterNameEmbedding(deps, {
        roasterId: 1,
        roasterName: "Swerl",
        aliases: null,
      }),
    HttpSourceError,
  );
  assertEquals(error.status, 400, "400 status is preserved");
});

Deno.test("generateRoasterNameEmbedding throws EmbeddingResponseError on a wrong-length vector", async () => {
  const { fetchImpl } = makeFetch(() => ({
    status: 200,
    body: { data: [{ embedding: vectorOf(ROASTER_EMBEDDING_DIMENSIONS - 1) }] },
  }));
  const { deps, world } = makeDeps(fetchImpl);
  await assertThrows(
    () =>
      generateRoasterNameEmbedding(deps, {
        roasterId: 1,
        roasterName: "Swerl",
        aliases: null,
      }),
    EmbeddingResponseError,
    "384",
  );
  assertEquals(world.updates.length, 0, "wrong-length vector is never stored");
});

Deno.test("generateRoasterNameEmbedding throws EmbeddingResponseError on a non-numeric element", async () => {
  const embedding: unknown[] = vectorOf(ROASTER_EMBEDDING_DIMENSIONS);
  embedding[10] = "not-a-number";
  const { fetchImpl } = makeFetch(() => ({
    status: 200,
    body: { data: [{ embedding }] },
  }));
  const { deps, world } = makeDeps(fetchImpl);
  await assertThrows(
    () =>
      generateRoasterNameEmbedding(deps, {
        roasterId: 1,
        roasterName: "Swerl",
        aliases: null,
      }),
    EmbeddingResponseError,
  );
  assertEquals(world.updates.length, 0, "non-numeric vector is never stored");
});

Deno.test("generateRoasterNameEmbedding posts the exact body and persists the vector", async () => {
  const embedding = vectorOf(ROASTER_EMBEDDING_DIMENSIONS, 0.5);
  const { fetchImpl, requests } = makeFetch(() => ({
    status: 200,
    body: { data: [{ embedding }] },
  }));
  const { deps, world } = makeDeps(fetchImpl);

  const result = await generateRoasterNameEmbedding(deps, {
    roasterId: 42,
    roasterName: "  Tim Wendelboe  ",
    aliases: " TW, Tim Wendelboe Oslo, ",
  });

  assertEquals(requests.length, 1, "exactly one provider call");
  assertEquals(
    requests[0].url,
    "https://api.openai.com/v1/embeddings",
    "provider endpoint",
  );
  assertEquals(
    JSON.parse(String(requests[0].init?.body)),
    {
      input: "Tim Wendelboe TW Tim Wendelboe Oslo",
      model: "fake-embedding-model",
      dimensions: 384,
    },
    "request body: built input text, model, dimensions",
  );
  assertEquals(
    requests[0].init?.headers,
    {
      "Authorization": "Bearer test-api-key",
      "Content-Type": "application/json",
    },
    "auth and content-type headers",
  );
  assertEquals(
    world.updates,
    [{ roasterId: 42, embedding }],
    "updateRoasterEmbedding received the vector",
  );
  assertEquals(result.embedding, embedding, "returned embedding");
  assertEquals(
    result.embeddedText,
    "Tim Wendelboe TW Tim Wendelboe Oslo",
    "returned the embedded text",
  );
});
