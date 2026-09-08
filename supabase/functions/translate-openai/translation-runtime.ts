export const TRANSLATION_CHUNK_SIZE = 3;
export const MAX_TRANSLATION_LOCALES = 25;
export const MAX_TRANSLATION_TEXT_LENGTH = 10_000;
export const TRANSLATION_REQUEST_DEADLINE_MS = 120_000;

export const MAX_TRANSLATION_TITLE_LENGTH = 200;

export type TranslationRequest = {
  text: string;
  locales: string[];
  platform?: string;
  source_popup_id?: number;
  title?: string;
  dry_run: boolean;
};

/// One locale's translated output. `title` is present only when the request
/// carried one (plan 054 Item C); a titleless request produces entries whose
/// `title` is undefined, which is what the pre-title code path always did.
export type TranslatedEntry = {
  content: string;
  title?: string;
};

export type TranslationFailure = {
  locale: string;
  phase: "translation" | "database";
  error: string;
};

export type TranslationRow = {
  content: string;
  locale: string;
  is_translated: true;
  platform?: string;
  source_popup_id?: number;
  title?: string;
};

export type ValidationResult =
  | { ok: true; value: TranslationRequest }
  | { ok: false; errors: string[] };

export function validateTranslationRequest(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }

  const errors: string[] = [];
  const text = input.text;
  const locales = input.locales;
  const platform = input.platform;
  const sourcePopupId = input.source_popup_id;
  const title = input.title;
  const dryRun = input.dry_run;

  if (typeof text !== "string" || text.trim().length === 0) {
    errors.push("text must be a non-empty string.");
  } else if ([...text].length > MAX_TRANSLATION_TEXT_LENGTH) {
    errors.push(
      `text must be at most ${MAX_TRANSLATION_TEXT_LENGTH} characters.`,
    );
  }

  if (!Array.isArray(locales)) {
    errors.push("locales must be an array.");
  } else {
    if (locales.length === 0 || locales.length > MAX_TRANSLATION_LOCALES) {
      errors.push(
        `locales must contain between 1 and ${MAX_TRANSLATION_LOCALES} entries.`,
      );
    }

    const seen = new Set<string>();
    for (const locale of locales) {
      if (
        typeof locale !== "string" ||
        !/^[A-Za-z]{2,3}(?:[-_](?:r)?[A-Za-z0-9]{2,8})*$/u.test(locale)
      ) {
        errors.push("Each locale must be a valid locale code.");
        continue;
      }

      const canonicalLocale = canonicalizeLocale(locale);
      if (seen.has(canonicalLocale)) {
        errors.push("locales must be unique.");
      }
      seen.add(canonicalLocale);
    }
  }

  if (
    platform !== undefined &&
    (typeof platform !== "string" ||
      platform.length === 0 ||
      platform.length > 64)
  ) {
    errors.push(
      "platform must be a non-empty string of at most 64 characters.",
    );
  }

  if (
    sourcePopupId !== undefined &&
    (typeof sourcePopupId !== "number" ||
      !Number.isSafeInteger(sourcePopupId) ||
      sourcePopupId <= 0)
  ) {
    errors.push("source_popup_id must be a positive safe integer.");
  }

  // A null title is how the database sends "this popup has no title", so it is
  // accepted and treated as absent rather than rejected.
  if (
    title !== undefined &&
    title !== null &&
    (typeof title !== "string" ||
      title.trim().length === 0 ||
      [...title].length > MAX_TRANSLATION_TITLE_LENGTH)
  ) {
    errors.push(
      `title must be a non-empty string of at most ${MAX_TRANSLATION_TITLE_LENGTH} characters.`,
    );
  }

  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    errors.push("dry_run must be a boolean.");
  }

  if (errors.length > 0) {
    return { ok: false, errors: [...new Set(errors)] };
  }

  return {
    ok: true,
    value: {
      text: text as string,
      locales: [...(locales as string[])],
      ...(platform !== undefined ? { platform: platform as string } : {}),
      ...(sourcePopupId !== undefined
        ? { source_popup_id: sourcePopupId as number }
        : {}),
      ...(typeof title === "string" ? { title: title.trim() } : {}),
      dry_run: (dryRun as boolean | undefined) ?? false,
    },
  };
}

export function chunkLocales(
  locales: string[],
  chunkSize = TRANSLATION_CHUNK_SIZE,
): string[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer.");
  }

  const chunks: string[][] = [];
  for (let index = 0; index < locales.length; index += chunkSize) {
    chunks.push(locales.slice(index, index + chunkSize));
  }
  return chunks;
}

export function buildBatchResponseFormat(locales: string[], titled = false) {
  // Untitled requests keep the original per-locale string schema exactly.
  const localeSchema = titled
    ? {
      type: "object",
      additionalProperties: false,
      required: ["content", "title"],
      properties: {
        content: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
      },
    }
    : { type: "string", minLength: 1 };

  return {
    type: "json_schema" as const,
    json_schema: {
      name: "launch_popup_translations",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["translations"],
        properties: {
          translations: {
            type: "object",
            additionalProperties: false,
            required: locales,
            properties: Object.fromEntries(
              locales.map((locale) => [locale, localeSchema]),
            ),
          },
        },
      },
    },
  };
}

export function buildSingleResponseFormat(titled = false) {
  return {
    type: "json_schema" as const,
    json_schema: {
      name: "launch_popup_translation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: titled ? ["translation", "title"] : ["translation"],
        properties: titled
          ? {
            translation: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
          }
          : {
            translation: { type: "string", minLength: 1 },
          },
      },
    },
  };
}

export function parseBatchTranslationContent(
  content: string,
  requestedLocales: string[],
  titled = false,
): Map<string, TranslatedEntry> {
  const result = new Map<string, TranslatedEntry>();
  const parsed = parseJsonRecord(content);
  if (!parsed) {
    return result;
  }

  const translations = parsed.translations;
  if (!isRecord(translations)) {
    return result;
  }

  for (const locale of requestedLocales) {
    const value = translations[locale];

    if (!titled) {
      if (typeof value === "string" && value.trim().length > 0) {
        result.set(locale, { content: value });
      }
      continue;
    }

    if (!isRecord(value)) {
      continue;
    }
    const localeContent = value.content;
    if (
      typeof localeContent !== "string" || localeContent.trim().length === 0
    ) {
      continue;
    }
    const localeTitle = value.title;
    // A usable body with a missing or empty title keeps the locale, with the
    // title dropped: the client falls back to its localized "What's new", which
    // is a far better outcome than dropping the locale and shipping no popup
    // at all in that language.
    result.set(
      locale,
      typeof localeTitle === "string" && localeTitle.trim().length > 0
        ? { content: localeContent, title: localeTitle }
        : { content: localeContent },
    );
  }
  return result;
}

export function parseSingleTranslationContent(
  content: string,
  titled = false,
): TranslatedEntry | undefined {
  const parsed = parseJsonRecord(content);
  const translation = parsed?.translation;
  if (typeof translation !== "string" || translation.trim().length === 0) {
    return undefined;
  }

  if (!titled) {
    return { content: translation };
  }

  const title = parsed?.title;
  return typeof title === "string" && title.trim().length > 0
    ? { content: translation, title }
    : { content: translation };
}

export function buildTranslationRows(
  request: TranslationRequest,
  translations: ReadonlyMap<string, TranslatedEntry>,
): TranslationRow[] {
  return request.locales.flatMap((locale) => {
    const entry = translations.get(locale);
    if (!entry || !entry.content) {
      return [];
    }

    return [{
      content: entry.content,
      locale,
      is_translated: true as const,
      ...(request.platform !== undefined ? { platform: request.platform } : {}),
      ...(request.source_popup_id !== undefined
        ? { source_popup_id: request.source_popup_id }
        : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
    }];
  });
}

export function shouldWriteTranslationState(
  request: TranslationRequest,
): boolean {
  return !request.dry_run;
}

export function remainingTranslationTimeMs(
  deadlineAt: number,
  now = Date.now(),
): number {
  return Math.max(0, deadlineAt - now);
}

export function summarizeTranslationError(
  failures: TranslationFailure[],
): string | null {
  if (failures.length === 0) {
    return null;
  }

  const locales = [...new Set(failures.map((failure) => failure.locale))];
  return `Failed locales: ${locales.join(", ")}`.slice(0, 500);
}

function canonicalizeLocale(locale: string): string {
  return locale
    .replaceAll("_", "-")
    .replace(/^([a-z]{2,3})-r([a-z]{2})\b/iu, "$1-$2")
    .toLocaleLowerCase("und");
}

function parseJsonRecord(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
