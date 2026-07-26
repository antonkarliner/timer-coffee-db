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

export function buildBatchTranslationMessages(
  text: string,
  locales: string[],
): ChatMessage[] {
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

export function buildSingleTranslationMessages(
  text: string,
  locale: string,
): ChatMessage[] {
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
