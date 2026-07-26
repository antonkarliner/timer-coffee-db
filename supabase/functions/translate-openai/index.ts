import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import OpenAI from "https://esm.sh/openai";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { OPENAI_MODELS } from "../_shared/ai-models.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getEnvVar } from "../_shared/env-validation.ts";
import { authorizeServiceRole } from "../_shared/service-role-auth.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  generateCorrelationId,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  buildBatchTranslationMessages,
  buildSingleTranslationMessages,
} from "./translation-prompt.ts";
import {
  buildBatchResponseFormat,
  buildSingleResponseFormat,
  buildTranslationRows,
  chunkLocales,
  parseBatchTranslationContent,
  parseSingleTranslationContent,
  remainingTranslationTimeMs,
  shouldWriteTranslationState,
  summarizeTranslationError,
  TRANSLATION_REQUEST_DEADLINE_MS,
  type TranslationFailure,
  type TranslationRequest,
  validateTranslationRequest,
} from "./translation-runtime.ts";

const MAX_OPENAI_ATTEMPTS = 2;
const MAX_FALLBACK_ATTEMPTS = 1;
const MAX_BATCH_COMPLETION_TOKENS = 2_048;
const MAX_SINGLE_COMPLETION_TOKENS = 1_024;
const OPENAI_REQUEST_TIMEOUT_MS = 30_000;

type SourcePopup = {
  id: number;
  content: string;
  locale: string;
  platform: string | null;
  is_translated: boolean;
  source_popup_id: number | null;
};

type LocaleResult = {
  locale: string;
  status: "translated" | "failed";
  content?: string;
  phase?: "translation" | "database";
  error?: string;
};

type SourceTranslationStatus =
  | "processing"
  | "partial"
  | "completed"
  | "failed";

function jsonResponse(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

async function translateBatchWithRetry(
  client: OpenAI,
  text: string,
  locales: string[],
  requestId: string,
  chunkIndex: number,
  deadlineAt: number,
): Promise<Map<string, string>> {
  const translations = new Map<string, string>();

  for (let attempt = 1; attempt <= MAX_OPENAI_ATTEMPTS; attempt += 1) {
    const remainingTimeMs = remainingTranslationTimeMs(deadlineAt);
    if (remainingTimeMs === 0) {
      break;
    }
    const pendingLocales = locales.filter((locale) =>
      !translations.has(locale)
    );
    if (pendingLocales.length === 0) {
      break;
    }

    try {
      const completion = await client.chat.completions.create(
        {
          messages: buildBatchTranslationMessages(text, pendingLocales),
          model: OPENAI_MODELS.BIG,
          reasoning_effort: "none",
          response_format: buildBatchResponseFormat(pendingLocales),
          max_completion_tokens: MAX_BATCH_COMPLETION_TOKENS,
        },
        { timeout: Math.min(OPENAI_REQUEST_TIMEOUT_MS, remainingTimeMs) },
      );
      const parsed = parseBatchTranslationContent(
        completion.choices[0]?.message?.content ?? "",
        pendingLocales,
      );
      for (const [locale, translation] of parsed) {
        translations.set(locale, translation);
      }
    } catch {
      // Retry is deliberately bounded; summarize only after all attempts to
      // avoid generating one monitoring record per failed API call.
    }
  }

  const missingCount = locales.length - translations.size;
  if (missingCount > 0) {
    logWarning("Launch-popup batch translation incomplete", {
      request_id: requestId,
      phase: "batch_translation",
      chunk_index: chunkIndex,
      attempts: MAX_OPENAI_ATTEMPTS,
      missing_count: missingCount,
    }, requestId);
  }

  return translations;
}

async function translateSingleWithRetry(
  client: OpenAI,
  text: string,
  locale: string,
  deadlineAt: number,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= MAX_FALLBACK_ATTEMPTS; attempt += 1) {
    const remainingTimeMs = remainingTranslationTimeMs(deadlineAt);
    if (remainingTimeMs === 0) {
      break;
    }
    try {
      const completion = await client.chat.completions.create(
        {
          messages: buildSingleTranslationMessages(text, locale),
          model: OPENAI_MODELS.BIG,
          reasoning_effort: "none",
          response_format: buildSingleResponseFormat(),
          max_completion_tokens: MAX_SINGLE_COMPLETION_TOKENS,
        },
        { timeout: Math.min(OPENAI_REQUEST_TIMEOUT_MS, remainingTimeMs) },
      );
      const translated = parseSingleTranslationContent(
        completion.choices[0]?.message?.content ?? "",
      );
      if (translated) {
        return translated;
      }
    } catch {
      // The caller records one bounded chunk-level warning if fallbacks fail.
    }
  }

  return undefined;
}

async function fetchCanonicalSourcePopup(
  supabase: SupabaseClient,
  sourcePopupId: number,
): Promise<
  { popup: SourcePopup; error?: never } | { popup?: never; error: string }
> {
  const { data, error } = await supabase
    .from("launch_popup")
    .select("id, content, locale, platform, is_translated, source_popup_id")
    .eq("id", sourcePopupId)
    .maybeSingle();

  if (error) {
    return { error: "Unable to read source popup." };
  }
  if (!data) {
    return { error: "Source popup was not found." };
  }
  if (
    data.is_translated !== false ||
    data.locale !== "en" ||
    data.source_popup_id !== null
  ) {
    return { error: "Source popup must be a root untranslated English row." };
  }
  if (typeof data.content !== "string" || data.content.trim().length === 0) {
    return { error: "Source popup content is invalid." };
  }

  return { popup: data as SourcePopup };
}

async function updateSourceStatus(
  supabase: SupabaseClient,
  sourcePopupId: number,
  translationStatus: SourceTranslationStatus,
  translationError: string | null,
): Promise<string | undefined> {
  const { error } = await supabase
    .from("launch_popup")
    .update({
      translation_status: translationStatus,
      translation_error: translationError,
    })
    .eq("id", sourcePopupId);

  return error ? "Unable to update source translation status." : undefined;
}

async function persistChunk(
  supabase: SupabaseClient,
  request: TranslationRequest,
  translations: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  const rows = buildTranslationRows(request, translations);
  if (rows.length === 0 || !shouldWriteTranslationState(request)) {
    return undefined;
  }

  const query = request.source_popup_id !== undefined
    ? supabase.from("launch_popup").upsert(rows, {
      onConflict: "source_popup_id,locale",
    })
    : supabase.from("launch_popup").insert(rows);
  const { error } = await query.select("id, locale");
  return error ? "Unable to persist translated popup rows." : undefined;
}

serve(async (req) => {
  const requestId = generateCorrelationId();
  const startedAt = Date.now();
  const deadlineAt = startedAt + TRANSLATION_REQUEST_DEADLINE_MS;
  const cors = getCorsHeaders(req.headers.get("origin") || undefined);

  if (req.method === "OPTIONS") {
    return createSecureResponse("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed.", request_id: requestId },
      405,
      cors,
    );
  }

  let supabaseUrl: string;
  let serviceRoleKey: string;
  let openAiApiKey: string;
  try {
    supabaseUrl = getEnvVar("SUPABASE_URL");
    serviceRoleKey = getEnvVar("SUPABASE_SERVICE_ROLE_KEY");
    openAiApiKey = getEnvVar("OPENAI_API_KEY_NON_PERSONAL");
    if (!openAiApiKey) {
      throw new Error("OPENAI_API_KEY_NON_PERSONAL is missing.");
    }
  } catch {
    logError(
      "Launch-popup translation environment validation failed",
      new Error("Required environment configuration is unavailable."),
      ErrorCategory.CONFIGURATION,
      ErrorSeverity.CRITICAL,
      { request_id: requestId, phase: "environment_validation" },
      requestId,
    );
    return jsonResponse(
      { error: "Service configuration is unavailable.", request_id: requestId },
      500,
      cors,
    );
  }

  const authorization = authorizeServiceRole(
    req.headers.get("authorization"),
    serviceRoleKey,
  );
  if (!authorization.authorized) {
    logWarning("Launch-popup translation authorization rejected", {
      request_id: requestId,
      phase: "authorization",
      status: authorization.status,
    }, requestId);
    return jsonResponse(
      { error: authorization.error, request_id: requestId },
      authorization.status,
      cors,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { error: "Request body must be valid JSON.", request_id: requestId },
      400,
      cors,
    );
  }

  const validation = validateTranslationRequest(body);
  if (!validation.ok) {
    logWarning("Launch-popup translation request validation failed", {
      request_id: requestId,
      phase: "request_validation",
      error_count: validation.errors.length,
    }, requestId);
    return jsonResponse(
      {
        error: "Invalid request.",
        details: validation.errors,
        request_id: requestId,
      },
      400,
      cors,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, detectSessionInUrl: false },
  });
  let translationRequest = validation.value;

  if (translationRequest.source_popup_id !== undefined) {
    const sourcePopupId = translationRequest.source_popup_id;
    const sourceResult = await fetchCanonicalSourcePopup(
      supabase,
      sourcePopupId,
    );
    if ("error" in sourceResult) {
      logWarning("Launch-popup canonical source validation failed", {
        request_id: requestId,
        phase: "source_validation",
        source_popup_id: sourcePopupId,
      }, requestId);
      return jsonResponse(
        { error: sourceResult.error, request_id: requestId },
        sourceResult.error === "Source popup was not found." ? 404 : 409,
        cors,
      );
    }

    translationRequest = {
      ...translationRequest,
      text: sourceResult.popup.content,
      ...(sourceResult.popup.platform !== null
        ? { platform: sourceResult.popup.platform }
        : { platform: undefined }),
    };

    if (shouldWriteTranslationState(translationRequest)) {
      const statusError = await updateSourceStatus(
        supabase,
        sourcePopupId,
        "processing",
        null,
      );
      if (statusError) {
        logError(
          "Launch-popup source status update failed",
          new Error(statusError),
          ErrorCategory.DATABASE,
          ErrorSeverity.HIGH,
          {
            request_id: requestId,
            phase: "source_status",
            source_popup_id: sourcePopupId,
          },
          requestId,
        );
        return jsonResponse(
          { error: statusError, request_id: requestId },
          500,
          cors,
        );
      }
    }
  }

  logInfo("Launch-popup translation request accepted", {
    request_id: requestId,
    phase: "request_start",
    locale_count: translationRequest.locales.length,
    chunk_count: Math.ceil(translationRequest.locales.length / 3),
    dry_run: translationRequest.dry_run,
    has_source_popup_id: translationRequest.source_popup_id !== undefined,
  }, requestId);

  const openAi = new OpenAI({
    apiKey: openAiApiKey,
    maxRetries: 0,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
  });
  const translated = new Map<string, string>();
  const persistedLocales = new Set<string>();
  const failures: TranslationFailure[] = [];
  const chunks = chunkLocales(translationRequest.locales);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    if (remainingTranslationTimeMs(deadlineAt) === 0) {
      const remainingLocales = chunks.slice(chunkIndex).flat();
      for (const locale of remainingLocales) {
        failures.push({
          locale,
          phase: "translation",
          error: "Request deadline exceeded.",
        });
      }
      logWarning("Launch-popup translation deadline reached", {
        request_id: requestId,
        phase: "request_deadline",
        remaining_locale_count: remainingLocales.length,
      }, requestId);
      break;
    }

    const locales = chunks[chunkIndex];
    const chunkTranslations = await translateBatchWithRetry(
      openAi,
      translationRequest.text,
      locales,
      requestId,
      chunkIndex,
      deadlineAt,
    );

    const failureCountBeforeFallbacks = failures.length;
    for (let localeIndex = 0; localeIndex < locales.length; localeIndex += 1) {
      const locale = locales[localeIndex];
      if (chunkTranslations.has(locale)) {
        continue;
      }
      if (remainingTranslationTimeMs(deadlineAt) === 0) {
        for (const remainingLocale of locales.slice(localeIndex)) {
          if (!chunkTranslations.has(remainingLocale)) {
            failures.push({
              locale: remainingLocale,
              phase: "translation",
              error: "Request deadline exceeded.",
            });
          }
        }
        break;
      }
      const fallback = await translateSingleWithRetry(
        openAi,
        translationRequest.text,
        locale,
        deadlineAt,
      );
      if (fallback) {
        chunkTranslations.set(locale, fallback);
      } else {
        failures.push({
          locale,
          phase: "translation",
          error: "Translation failed after bounded retries.",
        });
      }
    }
    const fallbackFailureCount = failures.length -
      failureCountBeforeFallbacks;
    if (fallbackFailureCount > 0) {
      logWarning("Launch-popup locale fallbacks incomplete", {
        request_id: requestId,
        phase: "locale_fallback",
        chunk_index: chunkIndex,
        failed_count: fallbackFailureCount,
      }, requestId);
    }

    for (const [locale, content] of chunkTranslations) {
      translated.set(locale, content);
    }

    const persistenceError = await persistChunk(
      supabase,
      {
        ...translationRequest,
        locales,
      },
      chunkTranslations,
    );
    if (persistenceError) {
      for (const locale of chunkTranslations.keys()) {
        failures.push({
          locale,
          phase: "database",
          error: persistenceError,
        });
      }
      logError(
        "Launch-popup translation chunk persistence failed",
        new Error(persistenceError),
        ErrorCategory.DATABASE,
        ErrorSeverity.HIGH,
        {
          request_id: requestId,
          phase: "chunk_persistence",
          chunk_index: chunkIndex,
          locale_count: chunkTranslations.size,
        },
        requestId,
      );
    } else if (!translationRequest.dry_run) {
      for (const locale of chunkTranslations.keys()) {
        persistedLocales.add(locale);
      }
    }

    logInfo("Launch-popup translation chunk completed", {
      request_id: requestId,
      phase: "chunk_complete",
      chunk_index: chunkIndex,
      requested_count: locales.length,
      translated_count: chunkTranslations.size,
      persistence_failed: persistenceError !== undefined,
    }, requestId);
  }

  const failedLocales = new Set(failures.map((failure) => failure.locale));
  const successfulCount = translationRequest.locales.length -
    failedLocales.size;
  const sourceStatus: SourceTranslationStatus = successfulCount ===
      translationRequest.locales.length
    ? "completed"
    : successfulCount > 0
    ? "partial"
    : "failed";
  let sourceStatusError: string | undefined;

  if (
    translationRequest.source_popup_id !== undefined &&
    shouldWriteTranslationState(translationRequest)
  ) {
    sourceStatusError = await updateSourceStatus(
      supabase,
      translationRequest.source_popup_id,
      sourceStatus,
      summarizeTranslationError(failures),
    );
    if (sourceStatusError) {
      logError(
        "Launch-popup final source status update failed",
        new Error(sourceStatusError),
        ErrorCategory.DATABASE,
        ErrorSeverity.HIGH,
        {
          request_id: requestId,
          phase: "source_status",
          source_popup_id: translationRequest.source_popup_id,
        },
        requestId,
      );
    }
  }

  const results: LocaleResult[] = translationRequest.locales.map((locale) => {
    const failure = failures.find((candidate) => candidate.locale === locale);
    return failure
      ? {
        locale,
        status: "failed",
        phase: failure.phase,
        error: failure.error,
      }
      : {
        locale,
        status: "translated",
        content: translated.get(locale),
      };
  });
  const httpStatus = sourceStatusError
    ? 500
    : sourceStatus === "completed"
    ? 200
    : sourceStatus === "partial"
    ? 424
    : 502;

  logInfo("Launch-popup translation request completed", {
    request_id: requestId,
    phase: "request_complete",
    duration_ms: Date.now() - startedAt,
    status: sourceStatus,
    http_status: httpStatus,
    requested_count: translationRequest.locales.length,
    translated_count: translated.size,
    persisted_count: persistedLocales.size,
    failed_count: failedLocales.size,
    dry_run: translationRequest.dry_run,
    source_status_update_failed: sourceStatusError !== undefined,
  }, requestId);

  return jsonResponse(
    {
      ok: httpStatus === 200,
      request_id: requestId,
      status: sourceStatus,
      dry_run: translationRequest.dry_run,
      source_popup_id: translationRequest.source_popup_id ?? null,
      requested_count: translationRequest.locales.length,
      translated_count: translated.size,
      persisted_count: persistedLocales.size,
      failed_count: failedLocales.size,
      source_status_error: sourceStatusError ?? null,
      results,
    },
    httpStatus,
    cors,
  );
});
