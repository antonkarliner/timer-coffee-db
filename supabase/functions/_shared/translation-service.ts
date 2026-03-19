/**
 * Translation Service for OpenAI-powered batch translation
 * Provides efficient translation of notification content to multiple locales
 */

import OpenAI from "https://deno.land/x/openai@v4.38.3/mod.ts";
import { getEnvVar } from "./env-validation.ts";
import { logWarning, logError, ErrorCategory, ErrorSeverity } from "./monitoring.ts";

// Configuration
const OPENAI_API_KEY = getEnvVar('OPENAI_API_KEY_NON_PERSONAL');
const OPENAI_MODEL = 'gpt-5.2';
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
      const completion = await client.chat.completions.create({
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
        temperature: 0.3,
        max_tokens: 500,
      });

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
 * Translate notification content to multiple locales
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

  // Translate all locales concurrently (no batching)
  const translationPromises = locales.map(async (locale) => {
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

  // Wait for all translations to complete
  const translationResults = await Promise.all(translationPromises);

  // Build the results map
  for (const { locale, result } of translationResults) {
    results.set(locale, result);
  }

  return results;
}
