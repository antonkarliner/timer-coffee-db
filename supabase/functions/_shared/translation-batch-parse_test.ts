import { parseBatchTranslationResponse } from "./translation-batch-parse.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

Deno.test("parseBatchTranslationResponse extracts all requested locales when present", () => {
  const content = JSON.stringify({
    translations: {
      es: { title: "Hola", body: "Cuerpo" },
      fr: { title: "Bonjour", body: "Corps" },
    },
  });

  const { translations, missing } = parseBatchTranslationResponse(content, ["es", "fr"]);

  assertEquals(missing, [], "no locales should be missing");
  assertEquals(translations.get("es"), { title: "Hola", body: "Cuerpo" }, "es should be parsed");
  assertEquals(translations.get("fr"), { title: "Bonjour", body: "Corps" }, "fr should be parsed");
});

Deno.test("parseBatchTranslationResponse reports missing locales absent from the response", () => {
  const content = JSON.stringify({
    translations: {
      es: { title: "Hola", body: "Cuerpo" },
    },
  });

  const { translations, missing } = parseBatchTranslationResponse(content, ["es", "fr"]);

  assertEquals(missing, ["fr"], "fr should be reported missing");
  assert(translations.has("es"), "es should still be present");
  assert(!translations.has("fr"), "fr should not be present");
});

Deno.test("parseBatchTranslationResponse reports locales with empty strings as missing", () => {
  const content = JSON.stringify({
    translations: {
      es: { title: "", body: "Cuerpo" },
      fr: { title: "Bonjour", body: "   " },
    },
  });

  const { translations, missing } = parseBatchTranslationResponse(content, ["es", "fr"]);

  assertEquals(missing, ["es", "fr"], "blank title/body should count as missing");
  assertEquals(translations.size, 0, "nothing should be considered translated");
});

Deno.test("parseBatchTranslationResponse reports locales with non-string fields as missing", () => {
  const content = JSON.stringify({
    translations: {
      es: { title: 123, body: null },
    },
  });

  const { translations, missing } = parseBatchTranslationResponse(content, ["es"]);

  assertEquals(missing, ["es"], "non-string fields should count as missing");
  assertEquals(translations.size, 0, "nothing should be considered translated");
});

Deno.test("parseBatchTranslationResponse treats unparsable JSON as all locales missing", () => {
  const { translations, missing } = parseBatchTranslationResponse("not json", ["es", "fr", "de"]);

  assertEquals(missing, ["es", "fr", "de"], "all requested locales should be missing");
  assertEquals(translations.size, 0, "nothing should be parsed from invalid JSON");
});

Deno.test("parseBatchTranslationResponse treats a missing translations key as all locales missing", () => {
  const content = JSON.stringify({ foo: "bar" });

  const { translations, missing } = parseBatchTranslationResponse(content, ["es", "fr"]);

  assertEquals(missing, ["es", "fr"], "all requested locales should be missing");
  assertEquals(translations.size, 0, "nothing should be parsed");
});

Deno.test("parseBatchTranslationResponse ignores extra locales not requested", () => {
  const content = JSON.stringify({
    translations: {
      es: { title: "Hola", body: "Cuerpo" },
      de: { title: "Hallo", body: "Karosserie" },
    },
  });

  const { translations, missing } = parseBatchTranslationResponse(content, ["es"]);

  assertEquals(missing, [], "no locales should be missing");
  assertEquals(translations.size, 1, "only the requested locale should be present");
  assert(!translations.has("de"), "unrequested locale should not leak into the result");
});
