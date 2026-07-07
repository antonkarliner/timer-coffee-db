type SupportedLocale = {
  locale: string;
  locale_name: string;
};

type TranslationPromptPayload = {
  source_locale: string;
  source_name: string;
  source_description: string | null;
};

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export const COLLECTION_TRANSLATION_SYSTEM_PROMPT = [
  "You localize coffee brewing app collection metadata for a polished mobile UI.",
  "Translate natural-language copy fully into the target language while preserving meaning and tone.",
  "Preserve exact proper nouns, creator names, brand names, product names, event names, and competition names.",
  "Examples to preserve exactly when present: World Brewers Cup, V60, AeroPress, Chemex, Kalita Wave, Hario Switch, Clever Dripper, Origami Dripper, Moccamaster.",
  "Do not preserve ordinary brewing descriptors just because they describe a technique. Localize terms such as flash-brewed, chilled, iced, cold brew, pour-over, steeped, and immersion unless they are part of a proper noun or a common untranslated loanword in the target language.",
  "When the source says flash-brewed, express the idea naturally for the target language as brewed hot over ice, brewed directly onto ice, or the target language's standard flash-brew term.",
  "Preserve markdown link syntax and URLs, numbers, ratios, units, and emoji.",
  "Keep titles concise and app-native; keep descriptions natural, accurate, and suitable for recipe collection cards.",
  "Return compact JSON only.",
].join(" ");

export function buildCollectionTranslationMessages(
  payload: TranslationPromptPayload,
  targetLocales: SupportedLocale[],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: COLLECTION_TRANSLATION_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify({
        source_locale: payload.source_locale,
        source: {
          name: payload.source_name,
          description: payload.source_description ?? "",
        },
        target_locales: targetLocales.map((locale) => ({
          locale: locale.locale,
          language_name: locale.locale_name,
        })),
        quality_requirements: [
          "Preserve named competitions and events exactly, including World Brewers Cup.",
          "Do not leave source-language technique descriptors like flash-brewed in the output when the target language has a natural equivalent.",
          "For flash-brewed, prefer the target language's natural phrase for brewed hot over ice or brewed directly onto ice.",
          "Do not drop key nouns or relationships; for example, 'World Brewers Cup champions' must still refer to champions of that named competition.",
          "Use the target language's natural coffee terminology instead of literal word-by-word phrasing.",
          "Return one translation object for every supported target locale requested.",
        ],
        output_shape: {
          translations: [
            {
              locale: "locale code",
              name: "translated collection title",
              description: "translated collection description or empty string",
            },
          ],
        },
      }),
    },
  ];
}
