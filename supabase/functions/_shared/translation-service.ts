/**
 * Translation Service for OpenAI-powered batch translation
 * Provides efficient translation of notification content to multiple locales
 */

import OpenAI from "https://deno.land/x/openai@v4.38.3/mod.ts";
import { getEnvVar } from "./env-validation.ts";
import { logWarning, logError, ErrorCategory, ErrorSeverity } from "./monitoring.ts";
import { OPENAI_MODELS } from "./ai-models.ts";

// Configuration
const OPENAI_API_KEY = getEnvVar('OPENAI_API_KEY_NON_PERSONAL');
const OPENAI_MODEL = OPENAI_MODELS.BIG;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

/**
 * Translation result interface
 */
export interface TranslationResult {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/**
 * Batch translation result map
 */
export type BatchTranslationResult = Map<string, TranslationResult>;

type NonStreamingChatCompletion = {
  choices: Array<{ message?: { content?: string | null } }>;
};

/**
 * Validate OpenAI configuration
 * @returns True if OpenAI is properly configured
 */
export function validateOpenAIConfig(): boolean {
  if (!OPENAI_API_KEY) {
    logError('OpenAI API key is not configured', undefined, ErrorCategory.CONFIGURATION, ErrorSeverity.HIGH);
    return false;
  }

  if (!OPENAI_API_KEY.startsWith('sk-')) {
    logError('Invalid OpenAI API key format', undefined, ErrorCategory.CONFIGURATION, ErrorSeverity.HIGH);
    return false;
  }

  return true;
}

/**
 * Create OpenAI client instance
 * @returns OpenAI client instance
 */
function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: OPENAI_API_KEY,
    timeout: TIMEOUT_MS,
  });
}

/**
 * Translate a single text with simple retry logic
 * @param text Text to translate
 * @param targetLocale Target locale (e.g., 'es', 'fr', 'de')
 * @param context Context for translation (e.g., 'notification title', 'notification body')
 * @param correlationId Correlation ID for logging
 * @returns Translated text
 */
export async function translateText(
  text: string,
  targetLocale: string,
  context: string,
  correlationId?: string
): Promise<string> {
  const client = createOpenAIClient();

  // Simple retry loop (no exponential backoff)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // The pinned v4 client predates the GPT-5 reasoning_effort type, but the
      // Chat Completions API accepts this field. Keep the runtime property while
      // constraining the rest of the request to the SDK's request type.
      const requestBody = {
        messages: [
          {
            role: "system",
            content: `You are a professional translator specializing in mobile app notifications.
Translate the following text to ${targetLocale} with these requirements:
- Maintain the original meaning and tone
- Keep it concise and suitable for push notifications
- Preserve any technical terms or brand names
- Adapt cultural references appropriately
- Do not add any explanations or notes
- Return only the translated text`
          },
          {
            role: "user",
            content: `Context: ${context}\n\nText to translate: ${text}`
          }
        ],
        model: OPENAI_MODEL,
        reasoning_effort: "none",
        temperature: 0.3,
        max_completion_tokens: 500,
      } as Parameters<typeof client.chat.completions.create>[0] & {
        reasoning_effort: "none";
      };
      const completion = await client.chat.completions.create(
        requestBody,
      ) as NonStreamingChatCompletion;

      const translatedText = completion.choices[0]?.message?.content?.trim();
      
      if (!translatedText) {
        throw new Error('Empty translation response from OpenAI');
      }

      return translatedText;

    } catch (error) {
      // On last attempt, log and fallback
      if (attempt === MAX_RETRIES) {
        logWarning(`Translation failed for ${targetLocale} after ${MAX_RETRIES} attempts, using fallback`, {
          correlationId,
          context,
          error: error instanceof Error ? error.message : String(error),
        });
        return text; // Fallback to original text
      }
      
      // Wait before retry (simple fixed delay)
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return text; // Fallback
}

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
 * Pure parsing/validation logic for the batched-translation model response.
 * Extracted so it can be unit tested without a live OpenAI client.
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

/**
 * Translate notification content to multiple locales in a single chat-completion call.
 * @param locales Array of target locales (e.g., ['es', 'fr', 'de'])
 * @param title Notification title to translate
 * @param body Notification body to translate
 * @param data Notification data object (will be passed through unchanged)
 * @param correlationId Correlation ID for logging
 * @returns Map of locale to translated content
 */
export async function translateNotificationBatch(
  locales: string[],
  title: string,
  body: string,
  data: Record<string, unknown>,
  correlationId?: string
): Promise<BatchTranslationResult> {
  const results = new Map<string, TranslationResult>();

  if (locales.length === 0) {
    return results;
  }

  let missingLocales = [...locales];

  try {
    const client = createOpenAIClient();
    const maxTokens = Math.min(220 * locales.length + 100, 8000);

    const requestBody = {
      messages: [
        {
          role: "system",
          content: `You are a professional translator for mobile push notifications. Translate concisely and preserve the original meaning and tone. Preserve technical terms and brand names (e.g. "Timer.Coffee") unchanged. Do not add explanations or notes. Respond ONLY with a JSON object of this exact shape: {"translations": {"<locale>": {"title": string, "body": string}, ...}}, with exactly one entry for every requested locale.`
        },
        {
          role: "user",
          content: JSON.stringify({ locales, title, body })
        }
      ],
      model: OPENAI_MODEL,
      reasoning_effort: "none",
      temperature: 0.3,
      max_completion_tokens: maxTokens,
      response_format: { type: "json_object" },
    } as Parameters<typeof client.chat.completions.create>[0] & {
      reasoning_effort: "none";
    };
    const completion = await client.chat.completions.create(
      requestBody,
    ) as NonStreamingChatCompletion;

    const content = completion.choices[0]?.message?.content ?? "";
    const { translations, missing } = parseBatchTranslationResponse(content, locales);

    for (const [locale, translated] of translations) {
      results.set(locale, {
        title: translated.title,
        body: translated.body,
        data: { ...data },
      });
    }
    missingLocales = missing;

    if (missing.length > 0) {
      logWarning(`Batched translation response missing locales, falling back per-locale`, {
        correlationId,
        missing,
      });
    }
  } catch (error) {
    logError(`Batched translation failed, falling back to per-locale translation`, error as Error, ErrorCategory.EXTERNAL_API, ErrorSeverity.MEDIUM, {
      correlationId,
    });
    missingLocales = [...locales];
  }

  if (missingLocales.length > 0) {
    // Fallback to the existing per-locale path (which itself falls back to
    // the original text on failure) for whichever locales the batched call
    // didn't produce.
    const fallbackPromises = missingLocales.map(async (locale) => {
      try {
        const [translatedTitle, translatedBody] = await Promise.all([
          translateText(title, locale, 'notification title', correlationId),
          translateText(body, locale, 'notification body', correlationId),
        ]);

        return {
          locale,
          result: {
            title: translatedTitle,
            body: translatedBody,
            data: { ...data },
          },
        };
      } catch (error) {
        logError(`Failed to translate to ${locale}`, error as Error, ErrorCategory.EXTERNAL_API, ErrorSeverity.MEDIUM, {
          correlationId,
        });

        // Fallback to original text
        return {
          locale,
          result: {
            title,
            body,
            data: { ...data },
          },
        };
      }
    });

    const fallbackResults = await Promise.all(fallbackPromises);
    for (const { locale, result } of fallbackResults) {
      results.set(locale, result);
    }
  }

  return results;
}
