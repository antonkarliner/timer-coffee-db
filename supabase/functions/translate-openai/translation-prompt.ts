import {
  selectTerminologyByLocale,
  selectTranslationTerms,
} from "../_shared/translation-glossary.ts";

export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

const LAUNCH_POPUP_TRANSLATION_SYSTEM_PROMPT = [
  "You translate launch-popup announcements for the Timer.Coffee coffee-brewing app.",
  "Translate the source text naturally and fully into each requested locale.",
  'Preserve the brand name "Timer.Coffee", emoji, URLs, URL destinations, markdown link syntax, placeholders, numbers, ratios, and units.',
  "Translate markdown link labels while preserving their destinations.",
  "Treat supplied terminology as preferred Timer.Coffee app vocabulary.",
  "Apply grammatical inflection, declension, conjugation, and agreement when needed; do not force an ungrammatical verbatim form.",
  "Treat supplied entries as relevant translation-memory references only; do not introduce their concepts when the source text does not express them.",
  "Return no commentary.",
].join(" ");

// A popup may carry an optional short title (plan 054 Item C). When it does,
// the response shape becomes one object per locale instead of one string.
// When it does not — which is every popup that existed before that plan — the
// prompt and the declared shape are byte-identical to the pre-title version,
// so the overwhelmingly common path cannot regress.
const LAUNCH_POPUP_TITLE_INSTRUCTION =
  "The popup also has a short title; translate it too, keeping it short and " +
  "in the same voice as the body.";

export function buildBatchTranslationMessages(
  text: string,
  locales: string[],
  title?: string,
): ChatMessage[] {
  if (title === undefined) {
    return [
      {
        role: "system",
        content:
          `${LAUNCH_POPUP_TRANSLATION_SYSTEM_PROMPT} Return ONLY a JSON object of this exact shape: ` +
          `{"translations":{"<locale>":"translated popup"}} with one string entry per requested locale.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          locales,
          text,
          terminology_by_locale: selectTerminologyByLocale(text, locales),
        }),
      },
    ];
  }

  return [
    {
      role: "system",
      content:
        `${LAUNCH_POPUP_TRANSLATION_SYSTEM_PROMPT} ${LAUNCH_POPUP_TITLE_INSTRUCTION} ` +
        `Return ONLY a JSON object of this exact shape: ` +
        `{"translations":{"<locale>":{"content":"translated popup","title":"translated title"}}} ` +
        `with one object entry per requested locale.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        locales,
        text,
        title,
        // The glossary is deliberately keyed on the body text only: the title
        // is a few words and selecting terminology from it would change which
        // terms the body receives, altering existing translations.
        terminology_by_locale: selectTerminologyByLocale(text, locales),
      }),
    },
  ];
}

export function buildSingleTranslationMessages(
  text: string,
  locale: string,
  title?: string,
): ChatMessage[] {
  if (title === undefined) {
    return [
      {
        role: "system",
        content:
          `${LAUNCH_POPUP_TRANSLATION_SYSTEM_PROMPT} Translate the source text into ${locale}. ` +
          'Return ONLY JSON of this exact shape: {"translation":"translated popup"}.',
      },
      {
        role: "user",
        content: JSON.stringify({
          locale,
          text,
          terminology: selectTranslationTerms(text, locale),
        }),
      },
    ];
  }

  return [
    {
      role: "system",
      content:
        `${LAUNCH_POPUP_TRANSLATION_SYSTEM_PROMPT} ${LAUNCH_POPUP_TITLE_INSTRUCTION} ` +
        `Translate the source text into ${locale}. ` +
        "Return ONLY JSON of this exact shape: " +
        '{"translation":"translated popup","title":"translated title"}.',
    },
    {
      role: "user",
      content: JSON.stringify({
        locale,
        text,
        title,
        terminology: selectTranslationTerms(text, locale),
      }),
    },
  ];
}
