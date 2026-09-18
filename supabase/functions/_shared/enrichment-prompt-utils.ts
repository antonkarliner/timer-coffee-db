/**
 * Pure helpers extracted from roaster-enrichment-worker for LLM prompt/cost
 * optimization (see plans/001-roaster-enrichment-prompt-optimization.md).
 *
 * Everything here is a pure function — no env reads, no network calls, no
 * Deno-global side effects at module load — so it can be unit tested without
 * bootstrapping the worker's Supabase/OpenAI/Groq clients.
 */

const HTML_STRIP_INPUT_CAP = 60000;

/**
 * Strip an HTML document down to something cheap to send to an LLM: drop
 * script/style/svg/noscript blocks and comments, but preserve `<meta ...>`
 * tags verbatim (they carry og: metadata that manual parsing can't always
 * reach) followed by the collapsed visible text.
 *
 * Operates on at most the first `HTML_STRIP_INPUT_CAP` characters of `html`
 * to avoid catastrophic regex backtracking / CPU exhaustion on huge pages.
 */
export function stripHtmlForLlm(html: string): string {
  if (!html) return "";
  const input = html.slice(0, HTML_STRIP_INPUT_CAP);

  // Extract meta tags verbatim before we start stripping tags.
  const metaTags: string[] = [];
  for (const match of input.matchAll(/<meta\b[^>]*>/gi)) {
    metaTags.push(match[0]);
  }

  let visible = input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

  const metaBlock = metaTags.join("\n");
  const combined = metaBlock ? `${metaBlock}\n${visible}` : visible;
  return combined.trim();
}

export interface BatchedLogoResult {
  index: number;
  isLogo: boolean;
  confidence: number;
  reason: string;
}

/**
 * Parse the batched logo-verification response
 * (`{"results":[{"index":0,"isLogo":...,"confidence":...,"reason":...}, ...]}`)
 * into a fixed-length array of exactly `expectedCount` entries, ordered by
 * index. Missing indexes are filled with a safe "not verified" default;
 * out-of-range or duplicate indexes are ignored; non-boolean/non-number
 * fields are coerced to safe defaults. Returns `null` if `parsed` has no
 * usable `results` array at all.
 */
export function parseBatchedLogoResults(
  parsed: unknown,
  expectedCount: number,
): BatchedLogoResult[] | null {
  if (expectedCount < 0 || !Number.isFinite(expectedCount)) return null;
  if (!parsed || typeof parsed !== "object") return null;
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;

  const byIndex = new Map<number, BatchedLogoResult>();
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawIndex = record.index;
    const index = typeof rawIndex === "number" && Number.isInteger(rawIndex)
      ? rawIndex
      : null;
    if (index === null || index < 0 || index >= expectedCount) continue;
    if (byIndex.has(index)) continue; // ignore duplicates, keep first
    const isLogo = typeof record.isLogo === "boolean" ? record.isLogo : false;
    const confidence = typeof record.confidence === "number" &&
        Number.isFinite(record.confidence)
      ? record.confidence
      : 0;
    const reason = typeof record.reason === "string"
      ? record.reason
      : "No reason provided";
    byIndex.set(index, { index, isLogo, confidence, reason });
  }

  const out: BatchedLogoResult[] = [];
  for (let i = 0; i < expectedCount; i += 1) {
    out.push(
      byIndex.get(i) ?? {
        index: i,
        isLogo: false,
        confidence: 0,
        reason: "missing from batch response",
      },
    );
  }
  return out;
}

export interface EvidencePage {
  jsonLd?: unknown;
  logos?: unknown;
  addresses?: unknown;
  names?: unknown;
  [key: string]: unknown;
}

export interface EvidencePayload {
  urls: string[];
  pages: unknown[];
  candidate_context: unknown;
}

export interface BoundEvidencePayloadOptions {
  perPageChars?: number;
  totalChars?: number;
}

export interface BoundEvidencePayloadResult {
  payload: EvidencePayload;
  truncated: boolean;
  originalChars: number;
  finalChars: number;
}

const DEFAULT_PER_PAGE_CHARS = 4000;
const DEFAULT_TOTAL_CHARS = 24000;
const STRING_ARRAY_FIELDS = ["logos", "addresses", "names"] as const;
const MAX_STRING_ARRAY_ENTRIES = 10;
const MAX_STRING_FIELD_CHARS = 500;

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function truncateLongStringFields(
  page: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...page };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "string" && value.length > MAX_STRING_FIELD_CHARS) {
      next[key] = value.slice(0, MAX_STRING_FIELD_CHARS);
    }
  }
  return next;
}

function shrinkPage(
  page: unknown,
  perPageChars: number,
): unknown {
  if (!page || typeof page !== "object" || Array.isArray(page)) return page;
  if (safeJsonLength(page) <= perPageChars) return page;

  // Step 1: drop jsonLd.
  let working: Record<string, unknown> = { ...page as Record<string, unknown> };
  if ("jsonLd" in working) {
    delete working.jsonLd;
    if (safeJsonLength(working) <= perPageChars) return working;
  }

  // Step 2: truncate string arrays to first N entries.
  for (const field of STRING_ARRAY_FIELDS) {
    const value = working[field];
    if (Array.isArray(value) && value.length > MAX_STRING_ARRAY_ENTRIES) {
      working = {
        ...working,
        [field]: value.slice(0, MAX_STRING_ARRAY_ENTRIES),
      };
    }
  }
  if (safeJsonLength(working) <= perPageChars) return working;

  // Step 3: truncate long string fields.
  working = truncateLongStringFields(working);
  return working;
}

/**
 * Bound the size of the `{urls, pages, candidate_context}` evidence bundle
 * embedded in the evidence summary prompt. Never drops urls or
 * candidate_context, never throws on weird input (null pages, non-object
 * pages pass through untouched by the per-page shrink step, though they
 * still count toward the total-budget page-dropping pass).
 */
export function boundEvidencePayload(
  payload: EvidencePayload,
  opts?: BoundEvidencePayloadOptions,
): BoundEvidencePayloadResult {
  const perPageChars = opts?.perPageChars ?? DEFAULT_PER_PAGE_CHARS;
  const totalChars = opts?.totalChars ?? DEFAULT_TOTAL_CHARS;

  const originalUrls = Array.isArray(payload?.urls) ? payload.urls : [];
  const originalPages = Array.isArray(payload?.pages) ? payload.pages : [];
  const candidateContext = payload?.candidate_context ?? null;

  const original: EvidencePayload = {
    urls: originalUrls,
    pages: originalPages,
    candidate_context: candidateContext,
  };
  const originalChars = safeJsonLength(original);

  // Dedupe urls preserving order.
  const seenUrls = new Set<string>();
  const dedupedUrls: string[] = [];
  for (const url of originalUrls) {
    if (typeof url !== "string") continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    dedupedUrls.push(url);
  }

  let truncated = dedupedUrls.length !== originalUrls.length;

  // Shrink oversized pages.
  let pages = originalPages.map((page) => {
    const shrunk = shrinkPage(page, perPageChars);
    if (shrunk !== page) truncated = true;
    return shrunk;
  });

  // Enforce total budget by dropping pages from the end.
  let working: EvidencePayload = {
    urls: dedupedUrls,
    pages,
    candidate_context: candidateContext,
  };
  while (
    pages.length > 0 && safeJsonLength(working) > totalChars
  ) {
    pages = pages.slice(0, -1);
    truncated = true;
    working = {
      urls: dedupedUrls,
      pages,
      candidate_context: candidateContext,
    };
  }

  const finalChars = safeJsonLength(working);
  return {
    payload: working,
    truncated,
    originalChars,
    finalChars,
  };
}
