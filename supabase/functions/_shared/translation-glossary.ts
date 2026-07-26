import { APP_TERMINOLOGY } from "./app-terminology.generated.ts";
import { TRANSLATION_GLOSSARY_STOPWORDS } from "./translation-glossary-policy.ts";

export type TranslationTerm = {
  source: string;
  preferred: string;
};

export type TerminologyByLocale = Record<string, TranslationTerm[]>;

export type TranslationSelectionDiagnostics = {
  catalogScans: number;
};

const DEFAULT_TERM_LIMIT = 25;
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const STOPWORDS = new Set<string>(TRANSLATION_GLOSSARY_STOPWORDS);

type MatchKind = "complete" | "multi-word";

type MatchedTerm = TranslationTerm & {
  kind: MatchKind;
  matchedSignificantWords: ReadonlySet<string>;
  normalizedSource: string;
  sourceLength: number;
};

type ClassifiedMatch = Omit<MatchedTerm, "preferred"> & {
  translations: Readonly<Record<string, string>>;
};

export function canonicalizeTranslationLocale(locale: string): string {
  return locale
    .trim()
    .replaceAll("_", "-")
    .replace(/^([a-z]{2,3})-r([a-z]{2})\b/i, "$1-$2")
    .toLowerCase();
}

export function selectTranslationTerms(
  text: string,
  locale: string,
  limit = DEFAULT_TERM_LIMIT,
): TranslationTerm[] {
  const resolvedLimit = normalizeLimit(limit);
  if (resolvedLimit === 0) {
    return [];
  }

  const canonicalLocale = canonicalizeTranslationLocale(locale);
  if (!canonicalLocale) {
    return [];
  }

  return selectLocalizedTerms(
    classifyCatalogMatches(text),
    canonicalLocale,
    resolvedLimit,
  );
}

export function selectTerminologyByLocale(
  text: string,
  locales: string[],
  limitPerLocale = DEFAULT_TERM_LIMIT,
  diagnostics?: TranslationSelectionDiagnostics,
): TerminologyByLocale {
  const resolvedLimit = normalizeLimit(limitPerLocale);
  if (locales.length === 0) {
    return {};
  }
  if (resolvedLimit === 0) {
    return Object.fromEntries(locales.map((locale) => [locale, []]));
  }

  const classifiedMatches = classifyCatalogMatches(text, diagnostics);
  return Object.fromEntries(
    locales.map((locale) => [
      locale,
      selectLocalizedTerms(
        classifiedMatches,
        canonicalizeTranslationLocale(locale),
        resolvedLimit,
      ),
    ]),
  );
}

function classifyCatalogMatches(
  text: string,
  diagnostics?: TranslationSelectionDiagnostics,
): ClassifiedMatch[] {
  const normalizedText = normalizeForMatching(text);
  if (!normalizedText) {
    return [];
  }

  if (diagnostics) {
    diagnostics.catalogScans += 1;
  }

  const fallbackText = removeBrandPhraseForFallback(normalizedText);
  const textWords = new Set(extractWords(fallbackText));
  const matches: ClassifiedMatch[] = [];
  for (const entry of APP_TERMINOLOGY) {
    const normalizedSource = normalizeForMatching(entry.source);
    if (!normalizedSource) {
      continue;
    }

    const classification = classifyMatch(
      normalizedSource,
      normalizedText,
      textWords,
    );
    if (!classification) {
      continue;
    }

    matches.push({
      source: entry.source,
      translations: entry.translations,
      ...classification,
      normalizedSource,
      sourceLength: [...normalizedSource].length,
    });
  }
  return matches;
}

function removeBrandPhraseForFallback(normalizedText: string): string {
  return normalizedText.replace(
    /(?<![\p{L}\p{M}\p{N}])timer\s*\.\s*coffee(?![\p{L}\p{M}\p{N}])/gu,
    " ",
  );
}

function selectLocalizedTerms(
  classifiedMatches: ClassifiedMatch[],
  canonicalLocale: string,
  limit: number,
): TranslationTerm[] {
  if (!canonicalLocale || limit === 0) {
    return [];
  }

  const matches: MatchedTerm[] = [];
  for (const match of classifiedMatches) {
    const preferred = resolvePreferredTranslation(
      match.translations,
      canonicalLocale,
    );
    if (!preferred) {
      continue;
    }
    matches.push({
      source: match.source,
      preferred,
      kind: match.kind,
      matchedSignificantWords: match.matchedSignificantWords,
      normalizedSource: match.normalizedSource,
      sourceLength: match.sourceLength,
    });
  }

  const completeMatchWords = new Set(
    matches
      .filter((match) => match.kind === "complete")
      .flatMap((match) => [...match.matchedSignificantWords]),
  );
  const relevantMatches = matches.filter((match) =>
    match.kind === "complete" ||
    !isCoveredByCompleteMatches(match, completeMatchWords)
  );
  relevantMatches.sort(compareMatches);

  const seen = new Set<string>();
  const selected: TranslationTerm[] = [];
  for (const match of relevantMatches) {
    const deduplicationKey = JSON.stringify([match.source, match.preferred]);
    if (seen.has(deduplicationKey)) {
      continue;
    }

    seen.add(deduplicationKey);
    selected.push({
      source: match.source,
      preferred: match.preferred,
    });
    if (selected.length === limit) {
      break;
    }
  }
  return selected;
}

function normalizeForMatching(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_TERM_LIMIT;
  }

  return Math.min(DEFAULT_TERM_LIMIT, Math.max(0, Math.floor(limit)));
}

function resolvePreferredTranslation(
  translations: Readonly<Record<string, string>>,
  canonicalLocale: string,
): string | undefined {
  const exact = translations[canonicalLocale];
  if (exact) {
    return exact;
  }

  const separatorIndex = canonicalLocale.indexOf("-");
  if (separatorIndex === -1) {
    return undefined;
  }

  return translations[canonicalLocale.slice(0, separatorIndex)];
}

function classifyMatch(
  normalizedSource: string,
  normalizedText: string,
  textWords: ReadonlySet<string>,
): Pick<MatchedTerm, "kind" | "matchedSignificantWords"> | undefined {
  const sourceWords = extractWords(normalizedSource);
  const significantWords = getSignificantWords(sourceWords);

  if (hasCompleteTerm(normalizedSource, normalizedText)) {
    return {
      kind: "complete",
      matchedSignificantWords: significantWords,
    };
  }

  if (sourceWords.length <= 1) {
    return undefined;
  }

  const matchedSignificantWords = new Set<string>();
  for (const word of significantWords) {
    if (textWords.has(word)) {
      matchedSignificantWords.add(word);
    }
  }

  return matchedSignificantWords.size >= 2
    ? {
      kind: "multi-word",
      matchedSignificantWords,
    }
    : undefined;
}

function getSignificantWords(words: string[]): Set<string> {
  return new Set(
    words.filter((word) => [...word].length >= 4 && !STOPWORDS.has(word)),
  );
}

function isCoveredByCompleteMatches(
  match: MatchedTerm,
  completeMatchWords: ReadonlySet<string>,
): boolean {
  return [...match.matchedSignificantWords].every((word) =>
    completeMatchWords.has(word)
  );
}

function hasCompleteTerm(
  normalizedSource: string,
  normalizedText: string,
): boolean {
  const escapedSource = escapeRegExp(normalizedSource);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${escapedSource}(?![\\p{L}\\p{M}\\p{N}])`,
    "u",
  );
  return pattern.test(normalizedText);
}

function extractWords(value: string): string[] {
  return value.match(WORD_PATTERN) ?? [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareMatches(left: MatchedTerm, right: MatchedTerm): number {
  if (left.kind !== right.kind) {
    return left.kind === "complete" ? -1 : 1;
  }

  return right.sourceLength - left.sourceLength ||
    left.normalizedSource.localeCompare(right.normalizedSource, "en");
}
