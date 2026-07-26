/**
 * Pure parsing/validation for the batched-translation model response.
 *
 * Kept in its own module so unit tests can import it without pulling in
 * translation-service.ts, which reaches env-validation.ts and therefore
 * requires the full production environment at import time.
 */

/**
 * Result of parsing a batched-translation model response.
 */
export interface BatchTranslationParseResult {
  /** Locale -> translated title/body, for locales successfully parsed out of the response. */
  translations: Map<string, { title: string; body: string }>;
  /** Locales that were requested but missing or invalid in the response. */
  missing: string[];
}

/**
 * Parse and validate the batched-translation model response.
 *
 * Expected shape: {"translations": {"<locale>": {"title": string, "body": string}, ...}}
 * Any requested locale that is absent, or whose title/body is not a non-empty
 * string, is reported in `missing` instead of `translations`.
 *
 * @param content Raw chat-completion message content (expected to be JSON)
 * @param locales Locales that were requested
 */
export function parseBatchTranslationResponse(
  content: string,
  locales: string[]
): BatchTranslationParseResult {
  const translations = new Map<string, { title: string; body: string }>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { translations, missing: [...locales] };
  }

  const translationsObj = (parsed as Record<string, unknown> | null)?.["translations"];
  if (!translationsObj || typeof translationsObj !== 'object') {
    return { translations, missing: [...locales] };
  }

  const missing: string[] = [];
  for (const locale of locales) {
    const entry = (translationsObj as Record<string, unknown>)[locale] as
      | { title?: unknown; body?: unknown }
      | undefined;
    const title = entry?.title;
    const body = entry?.body;

    if (
      entry &&
      typeof title === 'string' && title.trim().length > 0 &&
      typeof body === 'string' && body.trim().length > 0
    ) {
      translations.set(locale, { title, body });
    } else {
      missing.push(locale);
    }
  }

  return { translations, missing };
}
