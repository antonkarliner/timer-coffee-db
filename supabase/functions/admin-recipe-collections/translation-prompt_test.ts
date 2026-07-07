import {
  buildCollectionTranslationMessages,
  COLLECTION_TRANSLATION_SYSTEM_PROMPT,
} from "./translation-prompt.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

Deno.test("collection translation prompt preserves proper nouns and localizes technique descriptors", () => {
  const messages = buildCollectionTranslationMessages(
    {
      source_locale: "en",
      source_name: "Iced coffee",
      source_description:
        "Refreshing cold and iced coffee recipes for hot days -- flash-brewed and chilled.",
    },
    [
      { locale: "es", locale_name: "Español" },
      { locale: "ru", locale_name: "Русский" },
    ],
  );

  assert(
    COLLECTION_TRANSLATION_SYSTEM_PROMPT.includes("World Brewers Cup"),
    "The system prompt should explicitly preserve named competitions.",
  );
  assert(
    COLLECTION_TRANSLATION_SYSTEM_PROMPT.includes("flash-brewed"),
    "The system prompt should explicitly call out flash-brewed as localizable copy.",
  );
  assert(
    COLLECTION_TRANSLATION_SYSTEM_PROMPT.includes(
      "Translate natural-language copy fully",
    ),
    "The system prompt should prefer complete localization over mixed-language output.",
  );

  const request = JSON.parse(messages[1].content) as {
    source: { name: string; description: string };
    target_locales: Array<{ locale: string; language_name: string }>;
    quality_requirements: string[];
  };

  assertEquals(
    request.source.name,
    "Iced coffee",
    "Source name should be passed through.",
  );
  assertEquals(
    request.target_locales.length,
    2,
    "Every supported target locale should be included.",
  );
  assert(
    request.quality_requirements.some((requirement) =>
      requirement.includes("World Brewers Cup champions")
    ),
    "Prompt should guard against dropping the champion relationship.",
  );
  assert(
    request.quality_requirements.some((requirement) =>
      requirement.includes("flash-brewed")
    ),
    "Prompt should guard against leaving technique descriptors in English.",
  );
});
