import {
  OPENAI_MODELS,
  OPENAI_SPECIALIZED_MODELS,
  resolveOpenAiModelSettings,
} from "./ai-models.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

function reader(values: Record<string, string | undefined>) {
  return (name: string): string | undefined => values[name];
}

Deno.test("OpenAI model settings use reviewed defaults", () => {
  const settings = resolveOpenAiModelSettings(() => undefined);

  assertEquals(
    settings,
    {
      models: {
        BIG: "gpt-5.6-sol",
        MEDIUM: "gpt-5.6-terra",
        SMALL: "gpt-5.6-luna",
      },
      embedding: "text-embedding-3-small",
      moderation: "omni-moderation-latest",
    },
    "All OpenAI model defaults should resolve centrally.",
  );
});

Deno.test("OpenAI model settings accept and trim every override", () => {
  const settings = resolveOpenAiModelSettings(
    reader({
      OPENAI_MODEL_BIG: " custom-big ",
      OPENAI_MODEL_MEDIUM: "\tcustom-medium\n",
      OPENAI_MODEL_SMALL: "custom-small",
      OPENAI_MODEL_EMBEDDING: " custom-embedding ",
      OPENAI_MODEL_MODERATION: " custom-moderation ",
    }),
  );

  assertEquals(
    settings,
    {
      models: {
        BIG: "custom-big",
        MEDIUM: "custom-medium",
        SMALL: "custom-small",
      },
      embedding: "custom-embedding",
      moderation: "custom-moderation",
    },
    "Configured model values should be trimmed before use.",
  );
});

Deno.test("OpenAI model settings ignore blank overrides", () => {
  const settings = resolveOpenAiModelSettings(
    reader({
      OPENAI_MODEL_BIG: "",
      OPENAI_MODEL_MEDIUM: "   ",
      OPENAI_MODEL_SMALL: "\t\n",
      OPENAI_MODEL_EMBEDDING: " ",
      OPENAI_MODEL_MODERATION: "",
    }),
  );

  assertEquals(
    settings,
    resolveOpenAiModelSettings(() => undefined),
    "Blank model overrides should fall back to reviewed defaults.",
  );
});

Deno.test("OpenAI model settings are immutable", () => {
  const settings = resolveOpenAiModelSettings(() => undefined);

  assert(Object.isFrozen(settings), "The resolved settings should be frozen.");
  assert(
    Object.isFrozen(settings.models),
    "The generative model registry should be frozen.",
  );

  let mutationFailed = false;
  try {
    (settings.models as Record<string, string>).BIG = "changed";
  } catch (_error) {
    mutationFailed = true;
  }

  assert(mutationFailed, "Mutating the frozen model registry should fail.");
  assertEquals(
    settings.models.BIG,
    "gpt-5.6-sol",
    "A mutation attempt must not change the runtime model registry.",
  );
});

Deno.test("runtime OpenAI model registries expose immutable public objects", () => {
  assert(Object.isFrozen(OPENAI_MODELS), "OPENAI_MODELS should be frozen.");
  assert(
    Object.isFrozen(OPENAI_SPECIALIZED_MODELS),
    "OPENAI_SPECIALIZED_MODELS should be frozen.",
  );
  assertEquals(
    Object.keys(OPENAI_MODELS),
    ["BIG", "MEDIUM", "SMALL"],
    "The generative registry should expose only the three capability tiers.",
  );
  assertEquals(
    Object.keys(OPENAI_SPECIALIZED_MODELS),
    ["EMBEDDING", "MODERATION"],
    "The specialized registry should expose embedding and moderation.",
  );
});
