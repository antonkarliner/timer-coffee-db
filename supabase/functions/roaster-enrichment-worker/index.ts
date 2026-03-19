//v20260128-parse-batch
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getEnvVar, validateAndLogEnvironment } from "../_shared/env-validation.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  flushLogsOnExit,
  generateCorrelationId,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";

validateAndLogEnvironment();

const FUNCTION_NAME = "roaster-enrichment-worker";
const JOB_LOCKED_BY = "roaster-enrichment-worker";

const supabaseUrl = getEnvVar("SUPABASE_URL");
const supabaseServiceRoleKey = getEnvVar("SUPABASE_SERVICE_ROLE_KEY");
const cronJobSecret = getEnvVar("CRON_JOB_SECRET");

const groqApiKey = getEnvVar("GROQ_API_KEY");
const deepseekApiKey = getEnvVar("DEEPSEEK_API_KEY");
const openaiApiKey = getEnvVar("OPENAI_API_KEY_NON_PERSONAL");

if (!supabaseUrl || !supabaseServiceRoleKey || !cronJobSecret) {
  throw new Error("Missing required Supabase configuration for roaster enrichment worker");
}

if (!groqApiKey || !deepseekApiKey || !openaiApiKey) {
  throw new Error("Missing required LLM API keys for roaster enrichment worker");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MAX_JOB_RETRIES = 3;
const RETRY_BACKOFF_MINUTES = [15, 60, 360];

// Timeout configuration (Edge function timeout is ~150s, we need to finish before that)
const AI_API_TIMEOUT_MS = 10000; // 10s max for AI API calls
const OPENAI_VALIDATE_TIMEOUT_MS = 20000; // 20s for OpenAI validation
const OPENAI_EXTRACT_TIMEOUT_MS = 20000; // 20s for OpenAI extraction
const LOGO_VERIFY_TIMEOUT_MS = 8000; // 8s max for logo verification
const RPC_TIMEOUT_MS = 3000; // 3s max for RPC calls
const FETCH_TIMEOUT_MS = 8000; // 8s max for external page fetches

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const GPT_LOGO_MODEL = "gpt-5-mini";
const GPT_PARSE_MODEL = "gpt-5-mini";
const GPT_EXTRACT_MODEL = "gpt-5.2";
const SEARCH_RESULT_LIMIT = 6;
const SEARCH_AGGREGATOR_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "yelp.com",
  "tripadvisor.com",
  "google.com",
  "foursquare.com",
  "sprudge.com",
  "coffeereview.com",
];
const ADDRESS_PATH_KEYWORDS = [
  "/contact",
  "/about",
  "/locations",
  "/find-us",
  "/stores",
  "/visit",
  "/roastery",
  "/our-coffee",
  "/team",
];
const MAX_PAGES_PER_DOMAIN = 2; // Reduced from 3 to prevent timeouts
const MAX_TOTAL_DISCOVERED_PAGES = 4; // Reduced from 7 to prevent timeouts
const MAX_LOGOS_TO_VERIFY = 1; // Reduced from 2 - verify only 1 logo max to prevent timeouts
const PARSE_BATCH_SIZE = 3; // Process 3 pages per invocation (increased from 1)
const FETCH_BATCH_SIZE = 3; // Fetch 3 URLs per invocation (increased from 1)

const GROQ_TRIAGE_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
];

const ADDRESS_REGEX = /\b\d{1,5}\s+[\w\.,'\-\s]{3,120},?\s+[\p{L}\s\.-]{2,80},?\s+[\p{L}\.\-\s]{2,80}\b/giu;

interface JobRow {
  id: number;
  cluster_id: string;
  state: string;
  attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  stage: string;
  stage_data: Record<string, unknown>;
  correlation_id: string | null;
}

interface ClusterRow {
  id: string;
  normalized_name: string;
  display_name: string | null;
  candidate_count: number;
  occurrences: number;
  status: string;
  best_match_roaster_id: number | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

interface CandidateRow {
  id: number;
  roaster: string;
  coffee_bean_name: string;
  similar_candidates: unknown;
  google_search_results?: unknown;
  bean_search_results?: unknown;
  location?: unknown;
  cluster_id: string | null;
  inserted_at: string;
  processed: boolean;
  notes?: string | null;
}

interface SearchResultItem {
  title?: string;
  link?: string;
  url?: string;
}

interface SearchEvidenceResult {
  title: string | null;
  url: string;
  domain: string | null;
  source: "google" | "bean" | "unknown";
}

interface SearchEvidence {
  source: "stored_results" | "openai_web_search";
  results: SearchEvidenceResult[];
  official_site: string | null;
  candidate_domains: string[];
  queries: string[];
}

interface PageEvidence {
  url: string;
  title: string | null;
  jsonLd: unknown[];
  ogLogo: string | null;
  ogImage: string | null;
  logos: string[];
  addresses: string[];
  names: string[];
}

interface EvidenceBundle {
  urls: string[];
  pages: PageEvidence[];
  jsonLd: unknown[];
  logos: string[];
  addresses: string[];
  names: string[];
}

interface TriageResult {
  display_name: string | null;
  normalized_name: string | null;
  aliases: string[];
  is_roaster: boolean | null;
  confidence: number | null;
  notes: string | null;
  model: string;
}

interface PotentialMatch {
  roaster_id: number;
  roaster_name: string;
  confidence: number;
  match_method: string;
}

interface EvidenceSummary {
  website: string | null;
  logos: string[];
  addresses: string[];
  city: string | null;
  state: string | null;
  country: string | null;
  socials: string[];
  sources: string[];
  notes: string | null;
}

interface ProposedFields {
  roaster_name: string | null;
  aliases: string[];
  roaster_website_url: string | null;
  roaster_logo_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  is_roaster: boolean | null;
}

interface ExtractionResult {
  proposed: ProposedFields;
  confidence: number | null;
  conflicts: string[];
  notes: string | null;
}

interface ValidationResult {
  proposed: ProposedFields;
  confidence: number | null;
  needs_review: boolean;
  notes: string | null;
}

interface LogoVerificationResult {
  isLogo: boolean;
  confidence: number;
  reason: string;
}

interface PersistedResult {
  status: string;
  proposed: ProposedFields;
  sources: Array<{ url: string }>;
  signals: Record<string, unknown>;
  confidence: number;
  error: string | null;
}

interface StageResult {
  nextStage: string;
}

interface ProcessResult {
  status: 'in_progress' | 'completed' | 'failed';
  result?: PersistedResult;
}

// Legacy stage data interfaces (for backwards compatibility)
interface TriageStageData {
  triage: TriageResult;
  candidates: CandidateRow[];
}

interface EvidenceStageData {
  triage: TriageResult;
  urls: string[];
  evidence_bundle: EvidenceBundle;
}

interface SummaryStageData {
  triage: TriageResult;
  evidence_summary: EvidenceSummary;
  evidence_bundle_urls: string[];
}

interface ExtractStageData {
  triage: TriageResult;
  evidence_summary: EvidenceSummary;
  extraction: ExtractionResult;
  urls: string[];
}

// New validate micro-stage data interfaces (split from monolithic validate stage)
interface ValidateStageData {
  triage: TriageResult;
  evidence_summary: EvidenceSummary;
  extraction: ExtractionResult;
  urls: string[];
  cluster: ClusterRow;
}

interface TranslateLocationStageData extends ValidateStageData {
  validation?: ValidationResult;
  requires_validation: boolean;
}

interface FindMatchesStageData extends TranslateLocationStageData {
  final_proposed: ProposedFields;
  final_confidence: number;
  status: string;
}

interface PersistResultStageData extends FindMatchesStageData {
  potential_matches: PotentialMatch[];
}

// New micro-stage data interfaces for evidence collection
interface FetchedPage {
  url: string;
  html: string;
  status: number;
  fetched_at: string;
}

interface ParsedPage {
  url: string;
  page: PageEvidence;
}

interface ParseProgress {
  next_index: number;
  total_pages: number;
}

interface FetchCandidatesStageData {
  triage: TriageResult;
  cluster: ClusterRow;
  candidates: CandidateRow[];
  candidate_urls: string[];
  fetched_pages: FetchedPage[];
  fetch_progress?: { next_index: number; total_urls: number };
}

interface ParseCandidatesStageData extends FetchCandidatesStageData {
  parsed_pages: ParsedPage[];
  parse_progress?: ParseProgress;
}

interface DiscoverLinksStageData extends ParseCandidatesStageData {
  discovered_urls: string[];
}

interface FetchDiscoveredStageData extends DiscoverLinksStageData {
  fetched_discovered: FetchedPage[];
  fetch_discovered_progress?: { next_index: number; total_urls: number };
}

interface ParseDiscoveredStageData extends FetchDiscoveredStageData {
  parsed_discovered: ParsedPage[];
  parse_progress?: ParseProgress;
}

interface AggregateEvidenceStageData extends ParseDiscoveredStageData {
  evidence_bundle: EvidenceBundle;
}

class ProviderRetryableError extends Error {
  status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

async function verifyLogoWithOpenAI(
  imageUrl: string,
  roasterName: string,
  correlationId: string
): Promise<LogoVerificationResult> {
  logInfo("Verifying logo with GPT", { imageUrl, roasterName, model: GPT_LOGO_MODEL }, correlationId);

  const prompt = `You are a logo verification expert. Analyze this image and determine if it is a company logo.

Image URL: ${imageUrl}
Expected brand name: ${roasterName}

Return ONLY JSON with this exact structure:
{
  "isLogo": true/false,
  "confidence": 0.0 to 1.0,
  "reason": "explanation in 20 words or less"
}

Logo characteristics to look for:
- Distinctive brand mark or symbol
- Text matching brand name
- Simple, recognizable design
- NOT: product photos, promotional graphics, people, scenery
- NOT: product packaging with logos (the packaging itself, not the logo)
- NOT: store interiors or product displays`;

  const requestBody = {
    model: GPT_LOGO_MODEL,
    reasoning: { effort: "minimal" },
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
  };

  try {
    const response = await fetchWithRetry(
      OPENAI_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      { 
        correlationId, 
        label: "gpt_logo_verify",
        timeoutMs: LOGO_VERIFY_TIMEOUT_MS, // Use 8s timeout
        maxAttempts: 1, // Don't retry logo verification to save time
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      logWarning("Logo verification HTTP error", {
        imageUrl,
        status: response.status,
        body: errorBody.slice(0, 500),
        model: GPT_LOGO_MODEL,
      }, correlationId);
      return {
        isLogo: false,
        confidence: 0,
        reason: `HTTP error: ${response.status}`,
      };
    }

    const json = await response.json();
    const outputText = extractOpenAiOutputText(json);
    const parsed = parseModelJson<{ isLogo: boolean, confidence: number, reason: string }>(outputText, {
      isLogo: false,
      confidence: 0,
      reason: "Failed to parse response",
    });

    logInfo("Logo verification result", {
      isLogo: parsed.isLogo,
      confidence: parsed.confidence,
      reason: parsed.reason,
    }, correlationId);

    return {
      isLogo: parsed.isLogo ?? false,
      confidence: parsed.confidence ?? 0,
      reason: parsed.reason ?? "No reason provided",
    };
  } catch (error) {
    // Fail gracefully on timeout or any error
    const errorMessage = getErrorMessage(error);
    logWarning("Logo verification failed", { 
      imageUrl, 
      error: errorMessage 
    }, correlationId);
    return {
      isLogo: false,
      confidence: 0,
      reason: `Verification failed: ${errorMessage.slice(0, 50)}`,
    };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return Math.max(0, parsed - Date.now());
  return null;
}

function computeBackoff(attempt: number, baseMs = 500, maxMs = 8000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.random() * exponential * 0.2;
  return exponential + jitter;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  {
    maxAttempts = 3,
    correlationId,
    label,
    timeoutMs,
  }: { maxAttempts?: number; correlationId?: string; label?: string; timeoutMs?: number } = {},
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = timeoutMs
        ? await fetchWithTimeout(url, options, timeoutMs)
        : await fetch(url, options);
      lastResponse = response;

      if (response.status !== 429) {
        return response;
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const MAX_RETRY_DELAY_MS = 30000; // 30 seconds max delay
      const delay = Math.min(retryAfter ?? computeBackoff(attempt), MAX_RETRY_DELAY_MS);
      logWarning("Rate limited, retrying", {
        label,
        attempt,
        status: response.status,
        delay_ms: delay,
      }, correlationId);
      await sleep(delay);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      
      // Don't retry on timeout errors - fail fast
      if (errorMessage.includes("timeout")) {
        logWarning("Request timeout, not retrying", {
          label,
          attempt,
          url,
          message: errorMessage,
        }, correlationId);
        throw error;
      }
      
      if (attempt >= maxAttempts) {
        throw error;
      }

      const delay = computeBackoff(attempt);
      logWarning("Network error, retrying", {
        label,
        attempt,
        delay_ms: delay,
        message: errorMessage,
      }, correlationId);
      await sleep(delay);
    }
  }

  if (!lastResponse) {
    throw new Error("No response received from fetchWithRetry");
  }

  return lastResponse;
}

function stripCodeFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function sanitizeForJson(value: string): string {
  if (!value) return value;
  // Remove UTF-16 surrogate halves + NUL bytes to keep JSONB inserts valid.
  return value.replace(/[\u0000\uD800-\uDFFF]/g, "");
}

function parseModelJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(stripCodeFence(raw)) as T;
  } catch {
    return fallback;
  }
}

function extractOpenAiOutputText(json: unknown): string {
  const outputItems = safeArray<{ content?: Array<{ type?: string; text?: string }> }>(
    (json as { output?: unknown })?.output
  );
  const contentItems = outputItems.flatMap((item) =>
    safeArray<{ type?: string; text?: string }>(item?.content)
  );
  return (json as { output_text?: string })?.output_text
    ?? contentItems.find((content) => content?.type === "output_text" && typeof content.text === "string")?.text
    ?? contentItems.find((content) => typeof content?.text === "string")?.text
    ?? "{}";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    const nested = (error as { error?: { message?: unknown } }).error?.message;
    if (typeof nested === "string") return nested;
  }
  return "Unknown error";
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  const message = getErrorMessage(error);
  return new Error(message);
}

function getErrorDetails(error: unknown): { message: string; type: string; name?: string; raw?: string } {
  const message = getErrorMessage(error);
  const name = error instanceof Error ? error.name : undefined;
  const type = error === null ? "null" : typeof error;
  let raw: string | undefined;
  if (error && typeof error === "object") {
    try {
      raw = JSON.stringify(error);
    } catch {
      raw = undefined;
    }
  }
  if (raw && raw.length > 500) raw = raw.slice(0, 500);
  return { message, type, name, raw };
}

function normalizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isBinaryLikeUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const BINARY_EXTENSIONS = [
      ".pdf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
      ".zip",
      ".rar",
      ".7z",
      ".tar",
      ".gz",
    ];
    return BINARY_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

function normalizeDomain(value: string): string {
  return value.replace(/^www\./i, "").toLowerCase();
}

function extractDomain(value: string): string | null {
  try {
    return normalizeDomain(new URL(value).hostname);
  } catch {
    return null;
  }
}

function filterLogosByExtension(urls: string[]): string[] {
  const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg"];
  return urls.filter((url) => {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      return ALLOWED_EXTENSIONS.some(ext =>
        pathname.endsWith(ext) || pathname.includes(`${ext}?`)
      );
    } catch {
      return false;
    }
  });
}

function isAggregatorDomain(domain: string | null): boolean {
  if (!domain) return false;
  const normalized = normalizeDomain(domain);
  return SEARCH_AGGREGATOR_DOMAINS.some((blocked) =>
    normalized === blocked || normalized.endsWith(`.${blocked}`)
  );
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function extractMetaContent(html: string, property: string): string | null {
  const regex = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const match = html.match(regex);
  return match?.[1] ?? null;
}

function extractJsonLd(html: string): unknown[] {
  const matches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  const jsonLd: unknown[] = [];
  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const cleaned = raw.replace(/<!--|-->/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        jsonLd.push(...parsed);
      } else {
        jsonLd.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return jsonLd;
}

function extractInternalLinks(baseUrl: string, html: string): string[] {
  const base = new URL(baseUrl);
  const links = Array.from(html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi))
    .map((match) => match[1])
    .filter((href): href is string => Boolean(href));

  const resolved = links
    .map((href) => {
      try {
        const url = new URL(href, base);
        if (url.hostname !== base.hostname) return null;
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.hash = "";
        return url.toString();
      } catch {
        return null;
      }
    })
    .filter((href): href is string => Boolean(href));

  return uniqueStrings(resolved);
}

function isAddressPageCandidate(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return ADDRESS_PATH_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function extractFromJsonLd(data: unknown[]): {
  logos: string[];
  names: string[];
  addresses: string[];
} {
  const logos: string[] = [];
  const names: string[] = [];
  const addresses: string[] = [];

  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = record.name;
    if (typeof name === "string") names.push(name);

    const logo = record.logo ?? record.image;
    if (typeof logo === "string") logos.push(logo);
    if (logo && typeof logo === "object") {
      const logoUrl = (logo as Record<string, unknown>).url;
      if (typeof logoUrl === "string") logos.push(logoUrl);
    }

    const address = record.address;
    if (typeof address === "string") {
      addresses.push(address);
    }
    if (address && typeof address === "object") {
      const addressRecord = address as Record<string, unknown>;
      const parts = [
        addressRecord.streetAddress,
        addressRecord.addressLocality,
        addressRecord.addressRegion,
        addressRecord.postalCode,
        addressRecord.addressCountry,
      ]
        .filter((part) => typeof part === "string" && part.trim())
        .map((part) => String(part).trim());

      if (parts.length) addresses.push(parts.join(", "));
    }
  }

  return {
    logos: uniqueStrings(logos),
    names: uniqueStrings(names),
    addresses: uniqueStrings(addresses),
  };
}

function extractAddresses(html: string): string[] {
  const matches = Array.from(html.matchAll(ADDRESS_REGEX)).map((match) => match[0]);
  return uniqueStrings(matches.map((value) => value.trim())).slice(0, 6);
}

async function parsePageWithLLM(url: string, html: string, correlationId: string): Promise<PageEvidence> {
  logInfo("Parsing page with LLM", { url, model: GPT_PARSE_MODEL }, correlationId);
  
  const prompt = `Parse this HTML page and extract structured information about a coffee roaster.
Return ONLY JSON with this exact structure:
{
  "title": string|null,
  "jsonLd": unknown[],
  "ogLogo": string|null,
  "ogImage": string|null,
  "logos": string[],
  "addresses": string[],
  "names": string[]
}

Important instructions:
1. Extract the page title from <title> tag
2. Extract JSON-LD from <script type="application/ld+json"> tags
3. Extract og:logo and og:image from meta tags
4. Find all logo URLs (must end with .png, .jpg, or .jpeg)
5. Find all physical addresses
6. Find all company/roaster names

HTML content: ${html.slice(0, 10000)}`; // Limit to first 10KB

  try {
    const requestBody = {
      model: GPT_PARSE_MODEL,
      reasoning: { effort: "minimal" },
      text: { format: { type: "json_object" } },
      input: prompt,
    };

    const response = await fetchWithRetry(
      OPENAI_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      { correlationId, label: "gpt_parse", timeoutMs: AI_API_TIMEOUT_MS },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      logWarning("GPT parsing HTTP error", {
        url,
        status: response.status,
        body: errorBody.slice(0, 500),
        model: GPT_PARSE_MODEL,
      }, correlationId);
      throw new Error(`GPT parsing failed: ${response.status}`);
    }

    const json = await response.json();
    const outputText = extractOpenAiOutputText(json);
    const result = parseModelJson<Record<string, unknown>>(outputText, {});
    
    return {
      url,
      title: typeof result.title === "string" ? result.title : null,
      jsonLd: safeArray(result.jsonLd),
      ogLogo: typeof result.ogLogo === "string" ? result.ogLogo : null,
      ogImage: typeof result.ogImage === "string" ? result.ogImage : null,
      logos: filterLogosByExtension(safeArray<string>(result.logos)),
      addresses: safeArray<string>(result.addresses),
      names: safeArray<string>(result.names),
    };
  } catch (error) {
    logWarning("LLM parsing failed, falling back to manual parsing", {
      url,
      error: getErrorMessage(error),
    }, correlationId);
    
    // Fallback to manual parsing if LLM fails
    return parsePageEvidence(url, html);
  }
}

function parsePageEvidence(url: string, html: string): PageEvidence {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? null;
  const jsonLd = extractJsonLd(html);
  const ogLogo = extractMetaContent(html, "og:logo");
  const ogImage = extractMetaContent(html, "og:image");
  const addresses = extractAddresses(html);
  const jsonLdExtracted = extractFromJsonLd(jsonLd);

  return {
    url,
    title,
    jsonLd,
    ogLogo,
    ogImage,
    logos: filterLogosByExtension(uniqueStrings([
      ...jsonLdExtracted.logos,
      ...(ogLogo ? [ogLogo] : []),
      ...(ogImage ? [ogImage] : []),
    ])),
    addresses: uniqueStrings([...jsonLdExtracted.addresses, ...addresses]),
    names: jsonLdExtracted.names,
  };
}

function sanitizeParsedPage(page: PageEvidence): PageEvidence {
  return {
    url: sanitizeForJson(page.url),
    title: page.title ? sanitizeForJson(page.title) : null,
    jsonLd: page.jsonLd,
    ogLogo: page.ogLogo ? sanitizeForJson(page.ogLogo) : null,
    ogImage: page.ogImage ? sanitizeForJson(page.ogImage) : null,
    logos: page.logos.map((value) => sanitizeForJson(value)),
    addresses: page.addresses.map((value) => sanitizeForJson(value)),
    names: page.names.map((value) => sanitizeForJson(value)),
  };
}

async function lockNextJob(correlationId: string): Promise<JobRow | null> {
  const now = new Date().toISOString();
  logInfo("Checking for queued enrichment jobs", { run_after_lte: now }, correlationId);
  const { data: job, error } = await supabase
    .schema("service")
    .from("roaster_enrichment_jobs")
    .select("*")
    .eq("state", "queued")
    .lte("run_after", now)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    logError("Failed to fetch queued enrichment job", toError(error), ErrorCategory.DATABASE, ErrorSeverity.HIGH, {}, correlationId);
    throw error;
  }

  if (!job) {
    logInfo("No queued enrichment jobs found", {}, correlationId);
    return null;
  }

  const { data: updated, error: updateError } = await supabase
    .schema("service")
    .from("roaster_enrichment_jobs")
    .update({
      state: "running",
      locked_at: new Date().toISOString(),
      locked_by: JOB_LOCKED_BY,
      attempts: (job.attempts ?? 0) + 1,
    })
    .eq("id", job.id)
    .eq("state", "queued")
    .select("*")
    .maybeSingle();

  if (updateError) {
    logError("Failed to lock enrichment job", toError(updateError), ErrorCategory.DATABASE, ErrorSeverity.HIGH, { job_id: job.id }, correlationId);
    throw updateError;
  }

  if (!updated) {
    logWarning("Enrichment job already locked by another worker", { job_id: job.id }, correlationId);
    return null;
  }

  logInfo("Enrichment job locked", {
    job_id: updated.id,
    cluster_id: updated.cluster_id,
    attempts: updated.attempts,
  }, correlationId);
  return updated as JobRow;
}

async function updateJobState(jobId: number, state: string, lastError: string | null, correlationId: string) {
  logInfo("Updating enrichment job state", { job_id: jobId, state }, correlationId);
  const { error } = await supabase
    .schema("service")
    .from("roaster_enrichment_jobs")
    .update({
      state,
      last_error: lastError,
    })
    .eq("id", jobId);

  if (error) {
    logError("Failed to update job state", toError(error), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, { job_id: jobId, state }, correlationId);
    return;
  }

  logInfo("Enrichment job state updated", { job_id: jobId, state }, correlationId);
}

async function updateJobStage(
  jobId: number, 
  stage: string, 
  stageData: Record<string, unknown>, 
  correlationId: string
) {
  logInfo("Updating job stage", { job_id: jobId, stage }, correlationId);
  
  const { error } = await supabase
    .schema("service")
    .from("roaster_enrichment_jobs")
    .update({
      stage,
      stage_data: stageData,
      run_after: new Date().toISOString(), // Ready for immediate processing
      correlation_id: correlationId,
    })
    .eq("id", jobId);

  if (error) {
    logError(
      "Failed to update job stage", 
      toError(error), 
      ErrorCategory.DATABASE, 
      ErrorSeverity.MEDIUM, 
      { job_id: jobId, stage }, 
      correlationId
    );
    throw error;
  }

  logInfo("Job stage updated", { job_id: jobId, stage }, correlationId);
}

async function processTriageStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing triage stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);

  const { cluster, candidates } = await loadClusterContext(job, correlationId);
  const triage = await triageAndNormalize(cluster, candidates, correlationId);

  // Store minimal candidate data (first 5) to keep stage_data small
  const minimalCandidates = candidates.slice(0, 5).map(c => ({
    id: c.id,
    roaster: c.roaster,
    coffee_bean_name: c.coffee_bean_name,
    google_search_results: c.google_search_results,
    bean_search_results: c.bean_search_results,
    cluster_id: c.cluster_id,
  }));

  // Collect URLs from candidates
  const urls = collectCandidateUrls(candidates, correlationId);

  // Advance to fetch-candidates stage - include cluster and URLs to avoid re-fetching
  await updateJobStage(
    job.id,
    "fetch-candidates",
    {
      triage,
      cluster: {
        id: cluster.id,
        normalized_name: cluster.normalized_name,
        display_name: cluster.display_name,
        candidate_count: cluster.candidate_count,
        occurrences: cluster.occurrences,
        status: cluster.status,
        best_match_roaster_id: cluster.best_match_roaster_id,
        confidence: cluster.confidence,
      },
      candidates: minimalCandidates,
      candidate_urls: urls,
      fetched_pages: [],
    },
    correlationId
  );

  logInfo("Triage stage completed, advanced to fetch-candidates", { job_id: job.id, url_count: urls.length }, correlationId);
  return { nextStage: "fetch-candidates" };
}

async function processEvidenceStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing evidence stage (legacy)", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  
  // Load stage data from triage
  const stageData = job.stage_data as unknown as TriageStageData & {
    candidates: CandidateRow[];
    cluster: ClusterRow;
  };
  const { triage, candidates, cluster } = stageData;
  
  // Use candidates from stage_data instead of re-fetching
  const urls = collectCandidateUrls(candidates, correlationId);
  const evidenceBundle = await buildEvidenceBundle(urls, correlationId);
  
  // Advance to summary stage - pass cluster through
  await updateJobStage(
    job.id,
    "summary",
    {
      triage,
      cluster,
      urls,
      evidence_bundle: evidenceBundle,
    },
    correlationId
  );
  
  logInfo("Evidence stage completed, advanced to summary", {
    job_id: job.id,
    url_count: urls.length,
    page_count: evidenceBundle.pages.length
  }, correlationId);
  
  return { nextStage: "summary" };
}

// ==================== NEW MICRO-STAGE HANDLERS ====================

async function processFetchCandidatesStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing fetch-candidates stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  
  const stageData = job.stage_data as unknown as FetchCandidatesStageData;
  const { candidate_urls: urls } = stageData;
  
  // Get already fetched pages (from previous invocations)
  const fetchedPages: FetchedPage[] = stageData.fetched_pages ?? [];
  
  // Initialize or load progress tracking
  // For backward compatibility: resume from already fetched count if no progress tracked
  const progress = stageData.fetch_progress ?? {
    next_index: fetchedPages.length,
    total_urls: urls.length,
  };
  
  // Calculate batch range
  const startIndex = progress.next_index;
  const endIndex = Math.min(startIndex + FETCH_BATCH_SIZE, progress.total_urls);
  
  logInfo("Fetching candidate URLs batch", {
    job_id: job.id,
    batch_start: startIndex,
    batch_end: endIndex - 1,
    total_urls: progress.total_urls,
    already_fetched: fetchedPages.length,
  }, correlationId);
  
  // Fetch only this batch
  for (let i = startIndex; i < endIndex; i++) {
    const url = urls[i];
    logInfo(`Fetching candidate URL ${i + 1}/${urls.length}`, { url }, correlationId);
    
    try {
      const response = await fetchWithRetry(
        url,
        {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
          },
        },
        { maxAttempts: 2, correlationId, label: "fetch_candidate", timeoutMs: FETCH_TIMEOUT_MS },
      );
      
      if (response.ok) {
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
          logWarning("Skipping non-HTML candidate URL", { url, status: response.status, content_type: contentType }, correlationId);
          fetchedPages.push({
            url,
            html: "",
            status: response.status,
            fetched_at: new Date().toISOString(),
          });
          continue;
        }
        const html = sanitizeForJson((await response.text()).slice(0, 120000));
        fetchedPages.push({
          url,
          html,
          status: response.status,
          fetched_at: new Date().toISOString(),
        });
        logInfo(`Successfully fetched candidate URL`, { url, status: response.status, size: html.length }, correlationId);
      } else {
        logWarning(`Candidate URL fetch failed`, { url, status: response.status }, correlationId);
        fetchedPages.push({
          url,
          html: "",
          status: response.status,
          fetched_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      logWarning(`Candidate URL fetch error`, { url, error: getErrorMessage(error) }, correlationId);
      fetchedPages.push({
        url,
        html: "",
        status: 0,
        fetched_at: new Date().toISOString(),
      });
    }
  }
  
  // Check if more URLs need fetching
  const nextIndex = endIndex;
  const hasMoreUrls = nextIndex < progress.total_urls;
  
  if (hasMoreUrls) {
    // Stay in fetch-candidates stage, update progress
    await updateJobStage(
      job.id,
      "fetch-candidates",
      {
        ...stageData,
        fetched_pages: fetchedPages,
        fetch_progress: {
          next_index: nextIndex,
          total_urls: progress.total_urls,
        },
      },
      correlationId
    );
    
    logInfo("Fetch-candidates batch complete, more URLs pending", {
      job_id: job.id,
      fetched_count: fetchedPages.length,
      next_index: nextIndex,
      total_urls: progress.total_urls,
    }, correlationId);
    
    return { nextStage: "fetch-candidates" };
  } else {
    // All URLs fetched, advance to parse-candidates
    // Clean up progress tracking from stage_data
    const { fetch_progress: _, ...stageDataWithoutProgress } = stageData;
    
    await updateJobStage(
      job.id,
      "parse-candidates",
      {
        ...stageDataWithoutProgress,
        fetched_pages: fetchedPages,
      },
      correlationId
    );
    
    logInfo("Fetch-candidates stage completed, advanced to parse-candidates", {
      job_id: job.id,
      fetched_count: fetchedPages.length,
      total_urls: progress.total_urls,
    }, correlationId);
    
    return { nextStage: "parse-candidates" };
  }
}

async function processParseCandidatesStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing parse-candidates stage", {
    job_id: job.id,
    cluster_id: job.cluster_id
  }, correlationId);
  
  const stageData = job.stage_data as unknown as ParseCandidatesStageData;
  const { fetched_pages: fetchedPages } = stageData;
  
  // Get already parsed pages (from previous invocations)
  const parsedPages: ParsedPage[] = stageData.parsed_pages ?? [];
  
  // Initialize or load progress tracking
  // For backward compatibility: resume from already parsed count if no progress tracked
  const progress: ParseProgress = stageData.parse_progress ?? {
    next_index: parsedPages.length,
    total_pages: fetchedPages.length,
  };
  
  // Calculate batch range
  const startIndex = progress.next_index;
  const endIndex = Math.min(startIndex + PARSE_BATCH_SIZE, progress.total_pages);
  
  logInfo("Parsing candidate pages batch", {
    job_id: job.id,
    batch_start: startIndex,
    batch_end: endIndex - 1,
    total_pages: progress.total_pages,
    already_parsed: parsedPages.length,
  }, correlationId);
  
  // Process only this batch
  for (let i = startIndex; i < endIndex; i++) {
    const fetched = fetchedPages[i];
    if (!fetched.html) {
      logWarning(`Skipping empty HTML for URL`, { url: fetched.url, index: i }, correlationId);
      continue;
    }
    
    try {
      const page = await parsePageWithLLM(fetched.url, fetched.html, correlationId);
      parsedPages.push({ url: fetched.url, page: sanitizeParsedPage(page) });
      logInfo(`Parsed candidate page`, {
        url: fetched.url,
        index: i,
        title: page.title,
        logo_count: page.logos.length,
        address_count: page.addresses.length
      }, correlationId);
    } catch (error) {
      const details = getErrorDetails(error);
      logWarning(`Failed to parse candidate page`, {
        url: fetched.url,
        index: i,
        status: fetched.status,
        html_length: fetched.html.length,
        error: details.message,
        error_type: details.type,
        error_name: details.name,
        error_raw: details.raw,
      }, correlationId);
    }
  }
  
  // Check if more pages need parsing
  const nextIndex = endIndex;
  const hasMorePages = nextIndex < progress.total_pages;
  
  if (hasMorePages) {
    // Stay in parse-candidates stage, update progress
    await updateJobStage(
      job.id,
      "parse-candidates",
      {
        ...stageData,
        parsed_pages: parsedPages,
        parse_progress: {
          next_index: nextIndex,
          total_pages: progress.total_pages,
        },
      },
      correlationId
    );
    
    logInfo("Parse-candidates batch complete, more pages pending", {
      job_id: job.id,
      parsed_count: parsedPages.length,
      next_index: nextIndex,
      total_pages: progress.total_pages,
    }, correlationId);
    
    return { nextStage: "parse-candidates" };
  } else {
    // All pages parsed, advance to discover-links
    // Clean up progress tracking from stage_data
    const { parse_progress: _, ...stageDataWithoutProgress } = stageData;
    
    await updateJobStage(
      job.id,
      "discover-links",
      {
        ...stageDataWithoutProgress,
        parsed_pages: parsedPages,
      },
      correlationId
    );
    
    logInfo("Parse-candidates stage completed, advanced to discover-links", {
      job_id: job.id,
      parsed_count: parsedPages.length,
      total_pages: progress.total_pages,
    }, correlationId);
    
    return { nextStage: "discover-links" };
  }
}

async function processDiscoverLinksStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing discover-links stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  
  const stageData = job.stage_data as unknown as DiscoverLinksStageData;
  const { parsed_pages: parsedPages, candidate_urls: urls } = stageData;
  
  const seenUrls = new Set(urls);
  const domainCounts = new Map<string, number>();
  const discoveredUrls: string[] = [];
  
  // Count existing URLs per domain
  for (const url of urls) {
    const domain = extractDomain(url);
    if (domain) {
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
  }
  
  // Discover internal links from parsed pages
  for (const parsed of parsedPages) {
    if (!parsed.page) continue;
    
    // Re-fetch to get raw HTML for link extraction (we only stored parsed data)
    // Actually, we need the raw HTML - let's use the fetched_pages from stage data
    const fetchedPage = stageData.fetched_pages.find(fp => fp.url === parsed.url);
    if (!fetchedPage || !fetchedPage.html) continue;
    
    const internalLinks = extractInternalLinks(parsed.url, fetchedPage.html)
      .filter((link) => {
        const domain = extractDomain(link);
        if (!domain || isAggregatorDomain(domain)) return false;
        if (!isAddressPageCandidate(new URL(link).pathname)) return false;
        const domainCount = domainCounts.get(domain) ?? 0;
        if (domainCount >= MAX_PAGES_PER_DOMAIN) return false;
        if (seenUrls.has(link)) return false;
        return true;
      });
    
    for (const link of internalLinks) {
      if (discoveredUrls.length >= MAX_TOTAL_DISCOVERED_PAGES) break;
      const domain = extractDomain(link);
      if (!domain) continue;
      const domainCount = domainCounts.get(domain) ?? 0;
      if (domainCount >= MAX_PAGES_PER_DOMAIN) continue;
      discoveredUrls.push(link);
      seenUrls.add(link);
      domainCounts.set(domain, domainCount + 1);
    }
    
    if (discoveredUrls.length >= MAX_TOTAL_DISCOVERED_PAGES) break;
  }
  
  logInfo("Discovered internal links", {
    job_id: job.id,
    discovered_count: discoveredUrls.length,
    discovered_urls: discoveredUrls
  }, correlationId);
  
  // Advance to fetch-discovered stage
  await updateJobStage(
    job.id,
    "fetch-discovered",
    {
      ...stageData,
      discovered_urls: discoveredUrls,
    },
    correlationId
  );
  
  logInfo("Discover-links stage completed, advanced to fetch-discovered", {
    job_id: job.id,
    discovered_count: discoveredUrls.length
  }, correlationId);
  
  return { nextStage: "fetch-discovered" };
}

async function processFetchDiscoveredStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing fetch-discovered stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  
  const stageData = job.stage_data as unknown as FetchDiscoveredStageData;
  const { discovered_urls: urls } = stageData;
  
  // Get already fetched pages (from previous invocations)
  const fetchedDiscovered: FetchedPage[] = stageData.fetched_discovered ?? [];
  
  // Initialize or load progress tracking
  // For backward compatibility: resume from already fetched count if no progress tracked
  const progress = stageData.fetch_discovered_progress ?? {
    next_index: fetchedDiscovered.length,
    total_urls: urls.length,
  };
  
  // Calculate batch range
  const startIndex = progress.next_index;
  const endIndex = Math.min(startIndex + FETCH_BATCH_SIZE, progress.total_urls);
  
  logInfo("Fetching discovered URLs batch", {
    job_id: job.id,
    batch_start: startIndex,
    batch_end: endIndex - 1,
    total_urls: progress.total_urls,
    already_fetched: fetchedDiscovered.length,
  }, correlationId);
  
  // Fetch only this batch
  for (let i = startIndex; i < endIndex; i++) {
    const url = urls[i];
    logInfo(`Fetching discovered URL ${i + 1}/${urls.length}`, { url }, correlationId);
    
    try {
      const response = await fetchWithRetry(
        url,
        {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
          },
        },
        { maxAttempts: 2, correlationId, label: "fetch_discovered", timeoutMs: FETCH_TIMEOUT_MS },
      );
      
      if (response.ok) {
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
          logWarning("Skipping non-HTML discovered URL", { url, status: response.status, content_type: contentType }, correlationId);
          fetchedDiscovered.push({
            url,
            html: "",
            status: response.status,
            fetched_at: new Date().toISOString(),
          });
          continue;
        }
        const html = sanitizeForJson((await response.text()).slice(0, 120000));
        fetchedDiscovered.push({
          url,
          html,
          status: response.status,
          fetched_at: new Date().toISOString(),
        });
        logInfo(`Successfully fetched discovered URL`, { url, status: response.status, size: html.length }, correlationId);
      } else {
        logWarning(`Discovered URL fetch failed`, { url, status: response.status }, correlationId);
        fetchedDiscovered.push({
          url,
          html: "",
          status: response.status,
          fetched_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      logWarning(`Discovered URL fetch error`, { url, error: getErrorMessage(error) }, correlationId);
      fetchedDiscovered.push({
        url,
        html: "",
        status: 0,
        fetched_at: new Date().toISOString(),
      });
    }
  }
  
  // Check if more URLs need fetching
  const nextIndex = endIndex;
  const hasMoreUrls = nextIndex < progress.total_urls;
  
  if (hasMoreUrls) {
    // Stay in fetch-discovered stage, update progress
    await updateJobStage(
      job.id,
      "fetch-discovered",
      {
        ...stageData,
        fetched_discovered: fetchedDiscovered,
        fetch_discovered_progress: {
          next_index: nextIndex,
          total_urls: progress.total_urls,
        },
      },
      correlationId
    );
    
    logInfo("Fetch-discovered batch complete, more URLs pending", {
      job_id: job.id,
      fetched_count: fetchedDiscovered.length,
      next_index: nextIndex,
      total_urls: progress.total_urls,
    }, correlationId);
    
    return { nextStage: "fetch-discovered" };
  } else {
    // All URLs fetched, advance to parse-discovered
    // Clean up progress tracking from stage_data
    const { fetch_discovered_progress: _, ...stageDataWithoutProgress } = stageData;
    
    await updateJobStage(
      job.id,
      "parse-discovered",
      {
        ...stageDataWithoutProgress,
        fetched_discovered: fetchedDiscovered,
      },
      correlationId
    );
    
    logInfo("Fetch-discovered stage completed, advanced to parse-discovered", {
      job_id: job.id,
      fetched_count: fetchedDiscovered.length,
      total_urls: progress.total_urls,
    }, correlationId);
    
    return { nextStage: "parse-discovered" };
  }
}

async function processParseDiscoveredStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing parse-discovered stage", {
    job_id: job.id,
    cluster_id: job.cluster_id
  }, correlationId);
  
  const stageData = job.stage_data as unknown as ParseDiscoveredStageData;
  const { fetched_discovered: fetchedDiscovered } = stageData;
  
  // Get already parsed pages
  const parsedDiscovered: ParsedPage[] = stageData.parsed_discovered ?? [];
  
  // Initialize or load progress tracking
  // For backward compatibility: resume from already parsed count if no progress tracked
  const progress: ParseProgress = stageData.parse_progress ?? {
    next_index: parsedDiscovered.length,
    total_pages: fetchedDiscovered.length,
  };
  
  // Calculate batch range
  const startIndex = progress.next_index;
  const endIndex = Math.min(startIndex + PARSE_BATCH_SIZE, progress.total_pages);
  
  logInfo("Parsing discovered pages batch", {
    job_id: job.id,
    batch_start: startIndex,
    batch_end: endIndex - 1,
    total_pages: progress.total_pages,
    already_parsed: parsedDiscovered.length,
  }, correlationId);
  
  // Process only this batch
  for (let i = startIndex; i < endIndex; i++) {
    const fetched = fetchedDiscovered[i];
    if (!fetched.html) {
      logWarning(`Skipping empty HTML for discovered URL`, { url: fetched.url, index: i }, correlationId);
      continue;
    }
    
    try {
      const page = await parsePageWithLLM(fetched.url, fetched.html, correlationId);
      parsedDiscovered.push({ url: fetched.url, page: sanitizeParsedPage(page) });
      logInfo(`Parsed discovered page`, {
        url: fetched.url,
        index: i,
        title: page.title,
        logo_count: page.logos.length,
        address_count: page.addresses.length
      }, correlationId);
    } catch (error) {
      logWarning(`Failed to parse discovered page`, {
        url: fetched.url,
        index: i,
        error: getErrorMessage(error)
      }, correlationId);
    }
  }
  
  // Check if more pages need parsing
  const nextIndex = endIndex;
  const hasMorePages = nextIndex < progress.total_pages;
  
  if (hasMorePages) {
    // Stay in parse-discovered stage, update progress
    await updateJobStage(
      job.id,
      "parse-discovered",
      {
        ...stageData,
        parsed_discovered: parsedDiscovered,
        parse_progress: {
          next_index: nextIndex,
          total_pages: progress.total_pages,
        },
      },
      correlationId
    );
    
    logInfo("Parse-discovered batch complete, more pages pending", {
      job_id: job.id,
      parsed_count: parsedDiscovered.length,
      next_index: nextIndex,
      total_pages: progress.total_pages,
    }, correlationId);
    
    return { nextStage: "parse-discovered" };
  } else {
    // All pages parsed, advance to aggregate-evidence
    const { parse_progress: _, ...stageDataWithoutProgress } = stageData;
    
    await updateJobStage(
      job.id,
      "aggregate-evidence",
      {
        ...stageDataWithoutProgress,
        parsed_discovered: parsedDiscovered,
      },
      correlationId
    );
    
    logInfo("Parse-discovered stage completed, advanced to aggregate-evidence", {
      job_id: job.id,
      parsed_count: parsedDiscovered.length,
      total_pages: progress.total_pages,
    }, correlationId);
    
    return { nextStage: "aggregate-evidence" };
  }
}

async function processAggregateEvidenceStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing aggregate-evidence stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  
  const stageData = job.stage_data as unknown as AggregateEvidenceStageData;
  const { triage, cluster, parsed_pages: parsedPages, parsed_discovered: parsedDiscovered, candidate_urls: urls, discovered_urls: discoveredUrls } = stageData;
  
  // Combine all pages
  const allPages = [
    ...parsedPages.map(p => p.page),
    ...parsedDiscovered.map(p => p.page),
  ];
  
  // Aggregate data
  const allLogos: string[] = [];
  const allAddresses: string[] = [];
  const allNames: string[] = [];
  const allJsonLd: unknown[] = [];
  
  for (const page of allPages) {
    allLogos.push(...page.logos);
    allAddresses.push(...page.addresses);
    allNames.push(...page.names);
    allJsonLd.push(...page.jsonLd);
  }
  
  const evidenceBundle: EvidenceBundle = {
    urls: uniqueStrings([...urls, ...(discoveredUrls ?? [])]),
    pages: allPages,
    jsonLd: allJsonLd,
    logos: uniqueStrings(allLogos),
    addresses: uniqueStrings(allAddresses),
    names: uniqueStrings(allNames),
  };
  
  logInfo("Evidence aggregated", {
    job_id: job.id,
    total_pages: allPages.length,
    logo_count: evidenceBundle.logos.length,
    address_count: evidenceBundle.addresses.length
  }, correlationId);
  
  // Advance to summary stage
  await updateJobStage(
    job.id,
    "summary",
    {
      triage,
      cluster,
      urls: evidenceBundle.urls,
      evidence_bundle: evidenceBundle,
    },
    correlationId
  );
  
  logInfo("Aggregate-evidence stage completed, advanced to summary", {
    job_id: job.id,
    url_count: evidenceBundle.urls.length,
    page_count: evidenceBundle.pages.length
  }, correlationId);
  
  return { nextStage: "summary" };
}

async function processSummaryStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing summary stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  
  // Load stage data from evidence
  const stageData = job.stage_data as unknown as EvidenceStageData & { cluster: ClusterRow };
  const { triage, urls, evidence_bundle: evidenceBundle, cluster } = stageData;
  
  // Run DeepSeek summarization
  const evidenceSummary = await summarizeEvidenceWithDeepSeek(
    evidenceBundle,
    triage,
    correlationId
  );
  
  // Advance to extract stage - pass cluster through
  await updateJobStage(
    job.id,
    "extract",
    {
      triage,
      evidence_summary: evidenceSummary,
      evidence_bundle_urls: urls,
      cluster,
    },
    correlationId
  );
  
  logInfo("Summary stage completed, advanced to extract", {
    job_id: job.id,
    website: evidenceSummary.website,
    logo_count: evidenceSummary.logos.length,
    address_count: evidenceSummary.addresses.length
  }, correlationId);
  
  return { nextStage: "extract" };
}

async function processExtractStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult | PersistedResult> {
  logInfo("Processing extract stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  
  // Load stage data from summary
  const stageData = job.stage_data as unknown as SummaryStageData & { cluster: ClusterRow };
  const { triage, evidence_summary, evidence_bundle_urls: urls, cluster } = stageData;
  
  // Run GPT extraction
  const extraction = await extractWithOpenAI(evidence_summary, triage, correlationId);
  
  // Advance to validate stage - pass cluster through
  await updateJobStage(
    job.id,
    "validate",
    {
      triage,
      evidence_summary,
      extraction,
      urls,
      cluster,
    },
    correlationId
  );
  
  logInfo("Extract stage completed, advanced to validate", { 
    job_id: job.id,
    confidence: extraction.confidence,
    proposed_name: extraction.proposed.roaster_name
  }, correlationId);
  
  return { nextStage: "validate" };
}

async function translateLocationToEnglish(
  city: string | null,
  country: string | null,
  correlationId: string
): Promise<{ city: string | null; country: string | null }> {
  if (!city && !country) {
    return { city: null, country: null };
  }

  logInfo("Translating location to English", { city, country }, correlationId);

  try {
    const response = await fetchWithRetry(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.2",
          text: { format: { type: "json_object" } },
          input: `Translate these location names to English. Return ONLY JSON with keys: {"city": string|null, "country": string|null}
City: ${city || "null"}
Country: ${country || "null"}`,
        }),
      },
      { correlationId, label: "translate_location", timeoutMs: AI_API_TIMEOUT_MS }
    );

    if (!response.ok) {
      logWarning("Location translation failed, using original", { city, country, status: response.status }, correlationId);
      return { city, country };
    }

    const json = await response.json();
    const outputText = json?.output_text ?? json?.output?.[0]?.content?.[0]?.text ?? "{}";
    const parsed = parseModelJson<{ city?: string | null; country?: string | null }>(outputText, {});

    const translatedCity = parsed.city ?? city;
    const translatedCountry = parsed.country ?? country;

    logInfo("Location translated", { 
      original_city: city, 
      translated_city: translatedCity,
      original_country: country,
      translated_country: translatedCountry 
    }, correlationId);

    return { city: translatedCity, country: translatedCountry };
  } catch (error) {
    logWarning("Location translation error, using original", { 
      city, 
      country, 
      error: getErrorMessage(error) 
    }, correlationId);
    return { city, country };
  }
}

async function processValidateStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult> {
  logInfo("Processing validate stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);

  // Load stage data from extract
  // Support both new format (with cluster) and legacy format (without cluster)
  const stageData = job.stage_data as unknown as (ExtractStageData & { cluster?: ClusterRow });
  const { triage, evidence_summary, extraction, urls } = stageData;
  
  // Load cluster from stage_data or fetch it (backward compatibility)
  let cluster: ClusterRow;
  if (stageData.cluster) {
    cluster = stageData.cluster;
  } else {
    const context = await loadClusterContext(job, correlationId);
    cluster = context.cluster;
  }

  // Run validation if needed
  let validation: ValidationResult | undefined = undefined;
  const requiresValidation = needsValidation(extraction);

  if (requiresValidation) {
    const searchEvidence = buildSearchEvidenceFromCandidates([], correlationId);
    validation = await validateWithOpenAI(
      evidence_summary,
      triage,
      extraction,
      searchEvidence,
      correlationId
    );
  }

  logInfo("Validation completed", {
    job_id: job.id,
    required_validation: requiresValidation,
    had_validation: !!validation,
  }, correlationId);

  // Advance to translate-location stage
  await updateJobStage(
    job.id,
    "translate-location",
    {
      triage,
      evidence_summary,
      extraction,
      urls,
      cluster,
      validation,
      requires_validation: requiresValidation,
    },
    correlationId
  );

  logInfo("Validate stage completed, advanced to translate-location", {
    job_id: job.id,
    required_validation: requiresValidation,
  }, correlationId);

  return { nextStage: "translate-location" };
}

async function processTranslateLocationStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult> {
  logInfo("Processing translate-location stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);

  const stageData = job.stage_data as unknown as TranslateLocationStageData;
  const { triage, evidence_summary, extraction, urls, cluster, validation, requires_validation } = stageData;

  // Determine final proposed fields
  const finalProposed: ProposedFields = validation?.proposed ?? { ...extraction.proposed };

  // Translate location to English if needed
  if (finalProposed.city || finalProposed.country) {
    const translation = await translateLocationToEnglish(
      finalProposed.city,
      finalProposed.country,
      correlationId
    );
    finalProposed.city = translation.city;
    finalProposed.country = translation.country;
  }

  // Determine status and confidence
  const finalConfidence = validation?.confidence ?? extraction.confidence ?? 0.5;
  const status = validation?.needs_review || finalConfidence < 0.6 ? "needs_review" : "completed";

  logInfo("Location translation completed", {
    job_id: job.id,
    city: finalProposed.city,
    country: finalProposed.country,
    status,
    confidence: finalConfidence,
  }, correlationId);

  // Advance to find-matches stage
  await updateJobStage(
    job.id,
    "find-matches",
    {
      triage,
      evidence_summary,
      extraction,
      urls,
      cluster,
      validation,
      requires_validation,
      final_proposed: finalProposed,
      final_confidence: finalConfidence,
      status,
    },
    correlationId
  );

  logInfo("Translate-location stage completed, advanced to find-matches", {
    job_id: job.id,
    status,
    confidence: finalConfidence,
  }, correlationId);

  return { nextStage: "find-matches" };
}

async function processFindMatchesStage(
  job: JobRow,
  correlationId: string
): Promise<StageResult> {
  logInfo("Processing find-matches stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);

  const stageData = job.stage_data as unknown as FindMatchesStageData;
  const { triage, evidence_summary, extraction, urls, cluster, validation, requires_validation, final_proposed, final_confidence, status } = stageData;

  // Find potential roaster matches
  const potentialMatches = await findPotentialMatches(cluster, triage, correlationId);

  logInfo("Potential matches found", {
    job_id: job.id,
    match_count: potentialMatches.length,
  }, correlationId);

  // Advance to persist-result stage
  await updateJobStage(
    job.id,
    "persist-result",
    {
      triage,
      evidence_summary,
      extraction,
      urls,
      cluster,
      validation,
      requires_validation,
      final_proposed,
      final_confidence,
      status,
      potential_matches: potentialMatches,
    },
    correlationId
  );

  logInfo("Find-matches stage completed, advanced to persist-result", {
    job_id: job.id,
    match_count: potentialMatches.length,
  }, correlationId);

  return { nextStage: "persist-result" };
}

async function processPersistResultStage(
  job: JobRow,
  correlationId: string
): Promise<PersistedResult> {
  logInfo("Processing persist-result stage", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);

  const stageData = job.stage_data as unknown as PersistResultStageData;
  const { triage, extraction, urls, validation, final_proposed, final_confidence, status, potential_matches } = stageData;

  // Build signals object
  const signals: Record<string, unknown> = {
    models: {
      triage: triage.model,
      evidence: "deepseek-chat",
      extraction: GPT_EXTRACT_MODEL,
      validation: validation ? "gpt-5.2" : null,
    },
    triage,
    extraction: {
      conflicts: extraction.conflicts,
      notes: extraction.notes,
    },
    validation: validation ? { needs_review: validation.needs_review, notes: validation.notes } : null,
  };

  // Build persisted result
  const persisted: PersistedResult = {
    status,
    proposed: final_proposed,
    sources: urls.map((url: string) => ({ url })),
    signals,
    confidence: final_confidence,
    error: null,
  };

  // Persist result
  await persistResult(job.cluster_id, persisted, potential_matches, correlationId);

  // Mark job as done
  await updateJobState(job.id, "done", null, correlationId);

  logInfo("Persist-result stage completed, job done", {
    job_id: job.id,
    status,
    confidence: final_confidence,
    match_count: potential_matches.length,
  }, correlationId);

  return persisted;
}

// Timeout for stuck jobs (15 minutes)
const STUCK_JOB_TIMEOUT_MINUTES = 15;

async function cleanupStuckJobs(correlationId: string): Promise<number> {
  const stuckThreshold = new Date(Date.now() - STUCK_JOB_TIMEOUT_MINUTES * 60 * 1000).toISOString();

  logInfo("Checking for stuck enrichment jobs", {
    stuck_threshold: stuckThreshold,
    timeout_minutes: STUCK_JOB_TIMEOUT_MINUTES,
  }, correlationId);

  // Find jobs stuck in 'running' state for more than the timeout period
  const { data: stuckJobs, error: fetchError } = await supabase
    .schema("service")
    .from("roaster_enrichment_jobs")
    .select("id, cluster_id, locked_at, attempts")
    .eq("state", "running")
    .lt("locked_at", stuckThreshold);

  if (fetchError) {
    logError("Failed to fetch stuck jobs", toError(fetchError), ErrorCategory.DATABASE, ErrorSeverity.MEDIUM, {}, correlationId);
    return 0;
  }

  if (!stuckJobs || stuckJobs.length === 0) {
    logInfo("No stuck jobs found", {}, correlationId);
    return 0;
  }

  logInfo(`Found ${stuckJobs.length} stuck job(s)`, {
    job_ids: stuckJobs.map((j) => j.id),
  }, correlationId);

  // Reset stuck jobs to 'queued' state
  const jobIds = stuckJobs.map((j) => j.id);
  const { error: updateError } = await supabase
    .schema("service")
    .from("roaster_enrichment_jobs")
    .update({
      state: "queued",
      locked_at: null,
      locked_by: null,
      last_error: `Auto-reset: job stuck in running state for >${STUCK_JOB_TIMEOUT_MINUTES} minutes`,
      run_after: new Date().toISOString(),
    })
    .in("id", jobIds);

  if (updateError) {
    logError("Failed to reset stuck jobs", toError(updateError), ErrorCategory.DATABASE, ErrorSeverity.HIGH, { job_count: stuckJobs.length }, correlationId);
    return 0;
  }

  logInfo(`Successfully reset ${stuckJobs.length} stuck job(s) to queued state`, {
    job_ids: jobIds,
  }, correlationId);

  return stuckJobs.length;
}

async function loadClusterContext(job: JobRow, correlationId: string): Promise<{ cluster: ClusterRow; candidates: CandidateRow[] }> {
  logInfo("Loading cluster context", { job_id: job.id, cluster_id: job.cluster_id }, correlationId);
  const { data: cluster, error: clusterError } = await supabase
    .schema("service")
    .from("roaster_candidate_clusters")
    .select("*")
    .eq("id", job.cluster_id)
    .maybeSingle();

  if (clusterError || !cluster) {
    logError(
      "Failed to load cluster",
      clusterError ? toError(clusterError) : new Error("Cluster not found"),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      { cluster_id: job.cluster_id },
      correlationId,
    );
    throw clusterError ?? new Error("Cluster not found");
  }

  logInfo("Cluster loaded", {
    cluster_id: cluster.id,
    normalized_name: cluster.normalized_name,
    candidate_count: cluster.candidate_count,
    occurrences: cluster.occurrences,
    status: cluster.status,
  }, correlationId);

  const { data: candidates, error: candidatesError } = await supabase
    .schema("service")
    .from("new_roaster_candidates")
    .select("*")
    .eq("cluster_id", job.cluster_id)
    .order("inserted_at", { ascending: false });

  if (candidatesError) {
    logError("Failed to load candidates", toError(candidatesError), ErrorCategory.DATABASE, ErrorSeverity.HIGH, { cluster_id: job.cluster_id }, correlationId);
    throw candidatesError;
  }

  logInfo("Cluster candidates loaded", {
    cluster_id: job.cluster_id,
    candidate_count: (candidates ?? []).length,
  }, correlationId);

  return { cluster: cluster as ClusterRow, candidates: (candidates ?? []) as CandidateRow[] };
}

function collectCandidateUrls(candidates: CandidateRow[], correlationId?: string): string[] {
  const urls: string[] = [];
  const seenDomains = new Set<string>();

  logInfo("Collecting candidate URLs", { candidate_count: candidates.length }, correlationId);

  for (const candidate of candidates) {
    const googleResults = safeArray<SearchResultItem>(candidate.google_search_results);
    const beanResults = safeArray<SearchResultItem>(candidate.bean_search_results);
    const mergedResults = [...googleResults, ...beanResults];

    for (const result of mergedResults) {
      const rawUrl = result.link ?? result.url;
      if (!rawUrl) continue;
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) continue;
      if (isBinaryLikeUrl(normalized)) {
        logInfo("Skipping binary candidate URL", { url: normalized }, correlationId);
        continue;
      }

      const domain = new URL(normalized).hostname;
      if (seenDomains.has(domain)) continue;

      seenDomains.add(domain);
      urls.push(normalized);
      if (urls.length >= 6) return urls;
    }
  }

  if (!urls.length) {
    logWarning("No candidate URLs found", {}, correlationId);
  } else {
    logInfo("Candidate URLs collected", { url_count: urls.length, urls }, correlationId);
  }

  return urls;
}

function buildSearchEvidenceFromCandidates(
  candidates: CandidateRow[],
  correlationId?: string,
): SearchEvidence | null {
  const results: SearchEvidenceResult[] = [];
  const seenUrls = new Set<string>();

  const pushResult = (result: SearchResultItem, source: SearchEvidenceResult["source"]) => {
    if (results.length >= SEARCH_RESULT_LIMIT) return;
    const rawUrl = result.link ?? result.url;
    if (!rawUrl) return;
    const normalized = normalizeUrl(rawUrl);
    if (!normalized || seenUrls.has(normalized)) return;
    const domain = extractDomain(normalized);
    results.push({
      title: typeof result.title === "string" ? result.title : null,
      url: normalized,
      domain,
      source,
    });
    seenUrls.add(normalized);
  };

  for (const candidate of candidates) {
    const googleResults = safeArray<SearchResultItem>(candidate.google_search_results);
    const beanResults = safeArray<SearchResultItem>(candidate.bean_search_results);
    for (const result of googleResults) pushResult(result, "google");
    for (const result of beanResults) pushResult(result, "bean");
    if (results.length >= SEARCH_RESULT_LIMIT) break;
  }

  if (!results.length) {
    logInfo("No stored search evidence found", { candidate_count: candidates.length }, correlationId);
    return null;
  }

  const officialSite = results.find((result) => !isAggregatorDomain(result.domain))?.url ?? null;
  const candidateDomains = uniqueStrings(
    results.map((result) => result.domain).filter((domain): domain is string => Boolean(domain)),
  );

  logInfo("Search evidence built from stored results", {
    result_count: results.length,
    official_site: officialSite,
  }, correlationId);

  return {
    source: "stored_results",
    results,
    official_site: officialSite,
    candidate_domains: candidateDomains,
    queries: [],
  };
}

async function buildEvidenceBundle(urls: string[], correlationId: string): Promise<EvidenceBundle> {
  const pages: PageEvidence[] = [];
  const jsonLd: unknown[] = [];
  const logos: string[] = [];
  const addresses: string[] = [];
  const names: string[] = [];
  const discoveredUrls: string[] = [];
  const domainCounts = new Map<string, number>();
  const seenUrls = new Set<string>();

  logInfo("Building evidence bundle", { url_count: urls.length, urls }, correlationId);

  for (const url of urls) {
    try {
      seenUrls.add(url);
      const baseDomain = extractDomain(url);
      if (baseDomain) {
        domainCounts.set(baseDomain, (domainCounts.get(baseDomain) ?? 0) + 1);
      }
      logInfo("Fetching evidence URL", { url }, correlationId);
      const response = await fetchWithRetry(
        url,
        {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
          },
        },
        { maxAttempts: 2, correlationId, label: "website_fetch" },
      );

      if (!response.ok) {
        logWarning("Website fetch failed", { url, status: response.status }, correlationId);
        continue;
      }

      const html = (await response.text()).slice(0, 120000);
      const page = parsePageEvidence(url, html);
      logInfo("Parsed evidence page", {
        url,
        title: page.title,
        logo_count: page.logos.length,
        address_count: page.addresses.length,
        name_count: page.names.length,
      }, correlationId);
      pages.push(page);
      jsonLd.push(...page.jsonLd);
      logos.push(...page.logos);
      addresses.push(...page.addresses);
      names.push(...page.names);

      const internalLinks = extractInternalLinks(url, html)
        .filter((link) => {
          const domain = extractDomain(link);
          if (!domain || isAggregatorDomain(domain)) return false;
          if (!isAddressPageCandidate(new URL(link).pathname)) return false;
          const domainCount = domainCounts.get(domain) ?? 0;
          if (domainCount >= MAX_PAGES_PER_DOMAIN) return false;
          if (seenUrls.has(link)) return false;
          return true;
        });

      for (const link of internalLinks) {
        if (discoveredUrls.length >= MAX_TOTAL_DISCOVERED_PAGES) break;
        const domain = extractDomain(link);
        if (!domain) continue;
        const domainCount = domainCounts.get(domain) ?? 0;
        if (domainCount >= MAX_PAGES_PER_DOMAIN) continue;
        discoveredUrls.push(link);
        seenUrls.add(link);
        domainCounts.set(domain, domainCount + 1);
      }
    } catch (error) {
      logWarning("Website fetch error", { url, message: getErrorMessage(error) }, correlationId);
    }
  }

  if (discoveredUrls.length) {
    logInfo("Discovered address-related links", {
      discovered_count: discoveredUrls.length,
      discovered_urls: discoveredUrls,
    }, correlationId);
  }

  for (const url of discoveredUrls) {
    try {
      logInfo("Fetching discovered address page", { url }, correlationId);
      const response = await fetchWithRetry(
        url,
        {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
          },
        },
        { maxAttempts: 2, correlationId, label: "website_fetch" },
      );

      if (!response.ok) {
        logWarning("Discovered page fetch failed", { url, status: response.status }, correlationId);
        continue;
      }

      const html = (await response.text()).slice(0, 120000);
      const page = parsePageEvidence(url, html);
      logInfo("Parsed discovered evidence page", {
        url,
        title: page.title,
        logo_count: page.logos.length,
        address_count: page.addresses.length,
        name_count: page.names.length,
      }, correlationId);
      pages.push(page);
      jsonLd.push(...page.jsonLd);
      logos.push(...page.logos);
      addresses.push(...page.addresses);
      names.push(...page.names);
    } catch (error) {
      logWarning("Discovered page fetch error", { url, message: getErrorMessage(error) }, correlationId);
    }
  }

  logInfo("Evidence bundle built", {
    url_count: urls.length,
    page_count: pages.length,
    logo_count: logos.length,
    address_count: addresses.length,
    name_count: names.length,
  }, correlationId);

  return {
    urls: uniqueStrings([...urls, ...discoveredUrls]),
    pages,
    jsonLd,
    logos: uniqueStrings(logos),
    addresses: uniqueStrings(addresses),
    names: uniqueStrings(names),
  };
}

async function callGroqJson(prompt: string, model: string, correlationId: string): Promise<Record<string, unknown>> {
  logInfo("Groq triage request", { model, prompt_length: prompt.length }, correlationId);
  const response = await fetchWithRetry(
    GROQ_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    },
    { correlationId, label: "groq_triage", timeoutMs: AI_API_TIMEOUT_MS },
  );

  if (response.status === 429 || response.status >= 500) {
    throw new ProviderRetryableError(`Groq retryable error: ${response.status}`, response.status);
  }

  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content ?? "{}";
  logInfo("Groq triage response received", { model }, correlationId);
  return parseModelJson<Record<string, unknown>>(content, {});
}

async function triageAndNormalize(
  cluster: ClusterRow,
  candidates: CandidateRow[],
  correlationId: string,
): Promise<TriageResult> {
  const candidateNames = uniqueStrings(candidates.map((candidate) => candidate.roaster).filter(Boolean));
  logInfo("Starting triage and normalization", {
    cluster_id: cluster.id,
    candidate_count: candidates.length,
    candidate_name_count: candidateNames.length,
  }, correlationId);
  const prompt = `Normalize the roaster name and detect aliases. Return ONLY JSON with keys:
{"display_name": string|null, "normalized_name": string|null, "aliases": string[], "is_roaster": boolean|null, "confidence": number|null, "notes": string|null}.
Cluster display name: ${cluster.display_name ?? ""}
Candidate names: ${candidateNames.join(" | ")}`;

  for (const model of GROQ_TRIAGE_MODELS) {
    try {
      const result = await callGroqJson(prompt, model, correlationId);
      const aliases = safeArray<string>(result.aliases).filter((value) => typeof value === "string");
      logInfo("Triage completed", {
        cluster_id: cluster.id,
        model,
        confidence: typeof result.confidence === "number" ? result.confidence : null,
        aliases_count: aliases.length,
        display_name: typeof result.display_name === "string" ? result.display_name : cluster.display_name,
      }, correlationId);
      return {
        display_name: typeof result.display_name === "string" ? result.display_name : cluster.display_name,
        normalized_name: typeof result.normalized_name === "string" ? result.normalized_name : cluster.normalized_name,
        aliases,
        is_roaster: typeof result.is_roaster === "boolean" ? result.is_roaster : null,
        confidence: typeof result.confidence === "number" ? result.confidence : null,
        notes: typeof result.notes === "string" ? result.notes : null,
        model,
      };
    } catch (error) {
      if (error instanceof ProviderRetryableError) {
        logWarning("Groq triage fallback", { model, status: error.status }, correlationId);
        continue;
      }
      throw error;
    }
  }

  throw new Error("All Groq triage models failed");
}

async function summarizeEvidenceWithDeepSeek(
  bundle: EvidenceBundle,
  triage: TriageResult,
  correlationId: string,
  jobDeadline?: number,
): Promise<EvidenceSummary> {
  // Helper to check deadline if provided
  const isNearDeadline = (bufferMs = 10000) => 
    jobDeadline ? Date.now() + bufferMs > jobDeadline : false;
  const summaryStartTime = Date.now();
  logInfo("Summarizing evidence with DeepSeek", {
    model: "deepseek-chat",
    url_count: bundle.urls.length,
    page_count: bundle.pages.length,
  }, correlationId);
  const prompt = `Summarize the evidence into JSON. Use ONLY the evidence provided.
IMPORTANT: Only include logo URLs that end with .png, .jpg, or .jpeg extensions. Exclude all other image formats.

Return JSON with keys:
{"website": string|null, "logos": string[], "addresses": string[], "city": string|null, "state": string|null, "country": string|null, "socials": string[], "sources": string[], "notes": string|null}
Triage: ${JSON.stringify({ display_name: triage.display_name, aliases: triage.aliases })}
Evidence: ${JSON.stringify({ urls: bundle.urls, pages: bundle.pages })}`;

  const response = await fetchWithRetry(
    DEEPSEEK_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    },
    { correlationId, label: "deepseek_preextract", timeoutMs: AI_API_TIMEOUT_MS },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek request failed: ${response.status} ${body}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content ?? "{}";
  const parsed = parseModelJson<EvidenceSummary>(content, {
    website: null,
    logos: [],
    addresses: [],
    city: null,
    state: null,
    country: null,
    socials: [],
    sources: [],
    notes: null,
  });

  const logos = safeArray<string>(parsed.logos);
  const addresses = safeArray<string>(parsed.addresses);
  const socials = safeArray<string>(parsed.socials);
  const roasterName = triage.display_name || triage.normalized_name || "";

  // Verify each logo candidate with GPT before returning (limit to prevent timeouts)
  const verifiedLogos: string[] = [];
  const logosToVerify = logos.slice(0, MAX_LOGOS_TO_VERIFY);
  
  if (logos.length > MAX_LOGOS_TO_VERIFY) {
    logInfo("Limiting logo verification to prevent timeout", {
      total_logos: logos.length,
      verifying: MAX_LOGOS_TO_VERIFY,
    }, correlationId);
  }
  
  for (const logoUrl of logosToVerify) {
    // Skip logo verification if running low on time
    if (isNearDeadline(15000)) {
      logWarning("Skipping remaining logo verification due to deadline", {}, correlationId);
      break;
    }
    const verification = await verifyLogoWithOpenAI(logoUrl, roasterName, correlationId);

    if (verification.isLogo && verification.confidence >= 0.7) {
      verifiedLogos.push(logoUrl);
      logInfo("Logo verified", {
        url: logoUrl,
        confidence: verification.confidence,
        reason: verification.reason,
      }, correlationId);
    } else {
      logInfo("Logo rejected", {
        url: logoUrl,
        confidence: verification.confidence,
        reason: verification.reason,
      }, correlationId);
    }
  }

  // Add fallback note if no logos passed verification
  let notes = parsed.notes;
  if (verifiedLogos.length === 0 && logos.length > 0) {
    logWarning("No verified logos found", {
      original_logo_count: logos.length,
      roaster_name: roasterName,
    }, correlationId);
    notes = `No verified logo found. ${logos.length} candidates rejected. ${notes ?? ""}`;
  }

  const deepSeekDuration = Date.now() - summaryStartTime;
  logInfo("Evidence summary generated", {
    model: "deepseek-chat",
    duration_ms: deepSeekDuration,
    website: parsed.website ?? null,
    logo_count: verifiedLogos.length,
    address_count: addresses.length,
    socials_count: socials.length,
    original_logos_count: logos.length,
    verified_logos_count: verifiedLogos.length,
  }, correlationId);

  return {
    website: parsed.website ?? null,
    logos: verifiedLogos,
    addresses,
    city: parsed.city ?? null,
    state: parsed.state ?? null,
    country: parsed.country ?? null,
    socials,
    sources: uniqueStrings([...(parsed.sources ?? []), ...bundle.urls]),
    notes,
  };
}

async function extractWithOpenAI(
  summary: EvidenceSummary,
  triage: TriageResult,
  correlationId: string,
): Promise<ExtractionResult> {
  logInfo("Starting GPT extraction", {
    website: summary.website,
    logo_count: summary.logos.length,
    address_count: summary.addresses.length,
    source_count: summary.sources.length,
    model: GPT_EXTRACT_MODEL,
  }, correlationId);
  const prompt = `You are extracting roaster fields from evidence. Return ONLY JSON with keys:
{"proposed": {"roaster_name": string|null, "aliases": string[], "roaster_website_url": string|null, "roaster_logo_url": string|null, "city": string|null, "state": string|null, "country": string|null, "address": string|null, "is_roaster": boolean|null}, "confidence": number|null, "conflicts": string[], "notes": string|null}

CRITICAL REQUIREMENTS:
1. When selecting roaster_logo_url, ONLY choose from the provided logos array - these have been pre-verified as actual logos.
2. Do NOT look for logos in other parts of evidence - only use the provided logos array.
3. If no valid logo exists in logos array, set roaster_logo_url to null.

Evidence summary: ${JSON.stringify(summary)}
Triage: ${JSON.stringify(triage)}`;

  const requestBody = {
    model: GPT_EXTRACT_MODEL,
    reasoning: { effort: "none" },
    text: { format: { type: "json_object" } },
    input: prompt,
  };

  const response = await fetchWithRetry(
    OPENAI_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
    { correlationId, label: "gpt_extract", timeoutMs: OPENAI_EXTRACT_TIMEOUT_MS },
  );

  if (!response.ok) {
    const body = await response.text();
    logWarning("GPT extraction HTTP error", {
      status: response.status,
      body: body.slice(0, 500),
      model: GPT_EXTRACT_MODEL,
    }, correlationId);
    throw new Error(`GPT extraction failed: ${response.status} ${body}`);
  }

  const json = await response.json();
  const outputText = extractOpenAiOutputText(json);
  const parsed = parseModelJson<ExtractionResult>(outputText, {
    proposed: {
      roaster_name: null,
      aliases: [],
      roaster_website_url: null,
      roaster_logo_url: null,
      city: null,
      state: null,
      country: null,
      address: null,
      is_roaster: null,
    },
    confidence: null,
    conflicts: [],
    notes: null,
  });

  const aliases = safeArray<string>(parsed.proposed?.aliases);
  const conflicts = safeArray<string>(parsed.conflicts);
  logInfo("GPT extraction completed", {
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    conflicts_count: conflicts.length,
    proposed_name: parsed.proposed?.roaster_name ?? null,
    proposed_country: parsed.proposed?.country ?? null,
    proposed_website: parsed.proposed?.roaster_website_url ?? null,
  }, correlationId);

  return {
    proposed: {
      roaster_name: parsed.proposed?.roaster_name ?? null,
      aliases,
      roaster_website_url: parsed.proposed?.roaster_website_url ?? null,
      roaster_logo_url: parsed.proposed?.roaster_logo_url ?? null,
      city: parsed.proposed?.city ?? null,
      state: parsed.proposed?.state ?? null,
      country: parsed.proposed?.country ?? null,
      address: parsed.proposed?.address ?? null,
      is_roaster: typeof parsed.proposed?.is_roaster === "boolean" ? parsed.proposed.is_roaster : null,
    },
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    conflicts,
    notes: parsed.notes ?? null,
  };
}

async function validateWithOpenAI(
  summary: EvidenceSummary,
  triage: TriageResult,
  extraction: ExtractionResult,
  searchEvidence: SearchEvidence | null,
  correlationId: string,
): Promise<ValidationResult> {
  logInfo("Starting OpenAI validation", {
    extraction_confidence: extraction.confidence ?? null,
    conflict_count: extraction.conflicts.length,
    search_result_count: searchEvidence?.results.length ?? 0,
    search_source: searchEvidence?.source ?? null,
  }, correlationId);
  const prompt = `Validate and refine the proposed roaster data. Return ONLY JSON with keys:
{"proposed": {"roaster_name": string|null, "aliases": string[], "roaster_website_url": string|null, "roaster_logo_url": string|null, "city": string|null, "state": string|null, "country": string|null, "address": string|null, "is_roaster": boolean|null}, "confidence": number|null, "needs_review": boolean, "notes": string|null}

IMPORTANT: Ensure that roaster_logo_url (if present) ends with .png, .jpg, or .jpeg extension. If the proposed logo is not in this format, either find a .png/.jpg/.jpeg logo from the evidence or set it to null.

Evidence summary: ${JSON.stringify(summary)}
Triage: ${JSON.stringify(triage)}
Search evidence: ${searchEvidence ? JSON.stringify(searchEvidence) : "null"}
Proposed: ${JSON.stringify(extraction)}.`;

  const response = await fetchWithRetry(
    OPENAI_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        reasoning: { effort: "none" },
        text: { format: { type: "json_object" } },
        input: prompt,
      }),
    },
    { correlationId, label: "openai_validate", timeoutMs: OPENAI_VALIDATE_TIMEOUT_MS },
  );

  if (!response.ok) {
    const body = await response.text();
    logWarning("OpenAI validation HTTP error", {
      status: response.status,
      body: body.slice(0, 500),
      model: "gpt-5.2",
    }, correlationId);
    throw new Error(`OpenAI validation failed: ${response.status} ${body}`);
  }

  const json = await response.json();
  const outputItems = safeArray<{ content?: Array<{ type?: string; text?: string }> }>(json?.output);
  const contentItems = outputItems.flatMap((item) =>
    safeArray<{ type?: string; text?: string }>(item?.content)
  );
  const outputText = json?.output_text
    ?? contentItems.find((content) => content?.type === "output_text" && typeof content.text === "string")?.text
    ?? contentItems.find((content) => typeof content?.text === "string")?.text
    ?? "{}";
  const parsed = parseModelJson<ValidationResult>(outputText, {
    proposed: extraction.proposed,
    confidence: extraction.confidence ?? null,
    needs_review: true,
    notes: null,
  });

  logInfo("OpenAI validation completed", {
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    needs_review: typeof parsed.needs_review === "boolean" ? parsed.needs_review : true,
  }, correlationId);

  return {
    proposed: {
      roaster_name: parsed.proposed?.roaster_name ?? null,
      aliases: safeArray<string>(parsed.proposed?.aliases),
      roaster_website_url: parsed.proposed?.roaster_website_url ?? null,
      roaster_logo_url: parsed.proposed?.roaster_logo_url ?? null,
      city: parsed.proposed?.city ?? null,
      state: parsed.proposed?.state ?? null,
      country: parsed.proposed?.country ?? null,
      address: parsed.proposed?.address ?? null,
      is_roaster: typeof parsed.proposed?.is_roaster === "boolean" ? parsed.proposed.is_roaster : null,
    },
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    needs_review: typeof parsed.needs_review === "boolean" ? parsed.needs_review : true,
    notes: parsed.notes ?? null,
  };
}

function getValidationReasons(extraction: ExtractionResult): string[] {
  const reasons: string[] = [];
  const proposed = extraction.proposed;
  if (!proposed.roaster_name || !proposed.roaster_website_url || !proposed.country) {
    reasons.push("missing_required_fields");
  }
  if (extraction.conflicts.length > 0) reasons.push("conflicts");
  if ((extraction.confidence ?? 0) < 0.6) reasons.push("low_confidence");
  return reasons;
}

function needsValidation(extraction: ExtractionResult): boolean {
  return getValidationReasons(extraction).length > 0;
}

function computeRetryDelayMinutes(attempts: number): number | null {
  const index = Math.max(0, attempts - 1);
  return RETRY_BACKOFF_MINUTES[index] ?? null;
}

async function findPotentialMatches(
  cluster: ClusterRow,
  triage: TriageResult,
  correlationId: string,
): Promise<PotentialMatch[]> {
  logInfo("Finding potential roaster matches for admin review", {
    cluster_id: cluster.id,
    normalized_name: cluster.normalized_name,
    display_name: triage.display_name,
  }, correlationId);

  try {
    // Add timeout to RPC call using Promise.race
    const rpcPromise = supabase.rpc("find_potential_roaster_matches", {
      search_normalized_name: cluster.normalized_name,
      search_display_name: triage.display_name || cluster.display_name || "",
      max_results: 3,
      min_confidence: 0.65,
    });
    
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error("RPC timeout")), RPC_TIMEOUT_MS)
    );
    
    const { data: matches, error } = await Promise.race([rpcPromise, timeoutPromise]);

    if (error) {
      logError(
        "Failed to find potential matches",
        toError(error),
        ErrorCategory.DATABASE,
        ErrorSeverity.MEDIUM,
        {},
        correlationId,
      );
      return [];
    }

    const potentialMatches: PotentialMatch[] = (matches || []).map((m: {
      roaster_id: number;
      roaster_name: string;
      confidence: number;
      match_method: string;
    }) => ({
      roaster_id: Number(m.roaster_id),
      roaster_name: m.roaster_name,
      confidence: m.confidence,
      match_method: m.match_method,
    }));

    logInfo("Potential matches found", {
      match_count: potentialMatches.length,
      matches: potentialMatches.map((m) => ({
        name: m.roaster_name,
        confidence: m.confidence,
        method: m.match_method,
      })),
    }, correlationId);

    return potentialMatches;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    // Check if it's a timeout
    if (errorMessage.includes("timeout")) {
      logWarning("Potential matches RPC timed out", {}, correlationId);
    } else {
      logError(
        "Exception finding potential matches",
        toError(error),
        ErrorCategory.DATABASE,
        ErrorSeverity.MEDIUM,
        {},
        correlationId,
      );
    }
    return [];
  }
}

async function persistResult(
  clusterId: string,
  payload: PersistedResult,
  potentialMatches: PotentialMatch[],
  correlationId: string,
): Promise<void> {
  logInfo("Persisting enrichment result", {
    cluster_id: clusterId,
    status: payload.status,
    confidence: payload.confidence,
    potential_match_count: potentialMatches.length,
  }, correlationId);
  
  // Add potential matches to signals
  const signalsWithMatches = {
    ...payload.signals,
    potential_matches: potentialMatches,
  };
  
  const { error } = await supabase
    .schema("service")
    .from("roaster_enrichment_results")
    .insert({
      cluster_id: clusterId,
      status: payload.status,
      proposed: payload.proposed,
      sources: payload.sources,
      signals: signalsWithMatches,
      confidence: payload.confidence,
      error: payload.error,
      potential_matches: potentialMatches,
    });

  if (error) {
    logError("Failed to persist enrichment result", toError(error), ErrorCategory.DATABASE, ErrorSeverity.HIGH, { cluster_id: clusterId }, correlationId);
    throw error;
  }

  logInfo("Enrichment result persisted", {
    cluster_id: clusterId,
    status: payload.status,
    potential_match_count: potentialMatches.length,
  }, correlationId);
}

async function processJob(job: JobRow, correlationId: string): Promise<ProcessResult> {
  logInfo("Processing enrichment job", {
    job_id: job.id,
    cluster_id: job.cluster_id,
    stage: job.stage,
    attempts: job.attempts,
  }, correlationId);
  
  // Stage router - dispatch to appropriate stage handler
  const stageHandlers: Record<string, (job: JobRow, correlationId: string) => Promise<StageResult | PersistedResult>> = {
    triage: processTriageStage,
    // Legacy evidence stage (for backwards compatibility with existing jobs)
    evidence: processEvidenceStage,
    // New micro-stages for evidence collection
    'fetch-candidates': processFetchCandidatesStage,
    'parse-candidates': processParseCandidatesStage,
    'discover-links': processDiscoverLinksStage,
    'fetch-discovered': processFetchDiscoveredStage,
    'parse-discovered': processParseDiscoveredStage,
    'aggregate-evidence': processAggregateEvidenceStage,
    summary: processSummaryStage,
    extract: processExtractStage,
    // Validate micro-stages (split from monolithic validate stage)
    validate: processValidateStage,
    'translate-location': processTranslateLocationStage,
    'find-matches': processFindMatchesStage,
    'persist-result': processPersistResultStage,
  };

  const handler = stageHandlers[job.stage];
  if (!handler) {
    throw new Error(`Unknown stage: ${job.stage}`);
  }

  const result = await handler(job, correlationId);
  
  // If handler returns nextStage, it means the stage advanced but pipeline isn't complete
  if ('nextStage' in result) {
    logInfo("Pipeline stage completed", {
      job_id: job.id,
      stage: job.stage,
      next_stage: result.nextStage
    }, correlationId);
    
    // Return in_progress status - main handler will reset job to queued
    return { status: 'in_progress' };
  }
  
  // Final stage completed
  return { status: 'completed', result };
}

serve(async (req) => {
  const correlationId = generateCorrelationId();
  const origin = req.headers.get("origin") ?? undefined;
  const cors = getCorsHeaders(origin);
  let activeJob: JobRow | null = null;

  logInfo("Roaster enrichment worker invoked", {
    method: req.method,
    url: req.url,
    origin: origin ?? null,
    user_agent: req.headers.get("user-agent") ?? "unknown",
  }, correlationId);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const systemTokenHeader = req.headers.get("x-system-token");
  if (systemTokenHeader !== cronJobSecret) {
    logWarning("Unauthorized cron job access", {
      function: FUNCTION_NAME,
      user_agent: req.headers.get("user-agent") ?? "unknown",
    }, correlationId);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 403,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  logInfo("Authorized cron request", { function: FUNCTION_NAME }, correlationId);

  try {
    // Clean up any jobs stuck in 'running' state before processing new jobs
    const cleanedCount = await cleanupStuckJobs(correlationId);
    if (cleanedCount > 0) {
      logInfo("Stuck job cleanup completed", { cleaned_count: cleanedCount }, correlationId);
    }

    activeJob = await lockNextJob(correlationId);
    if (!activeJob) {
      logInfo("No queued jobs to process", {}, correlationId);
      return new Response(JSON.stringify({ success: true, message: "No queued jobs" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    logInfo("Enrichment job started", { job_id: activeJob.id, cluster_id: activeJob.cluster_id }, correlationId);
    const processResult = await processJob(activeJob, correlationId);
    
    if (processResult.status === 'completed' && processResult.result) {
      // Only mark as done when validate stage completes
      await updateJobState(activeJob.id, "done", null, correlationId);
      logInfo("Enrichment job completed", { 
        job_id: activeJob.id, 
        status: processResult.result.status 
      }, correlationId);

      return new Response(JSON.stringify({
        success: true,
        job_id: activeJob.id,
        status: processResult.result.status,
        confidence: processResult.result.confidence,
      }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } else {
      // Job is still in progress - reset to queued for next cron invocation
      await supabase
        .schema("service")
        .from("roaster_enrichment_jobs")
        .update({
          state: "queued",
          locked_at: null,
          locked_by: null,
          run_after: new Date().toISOString(),
        })
        .eq("id", activeJob.id);
        
      logInfo("Enrichment job stage complete, waiting for next invocation", { 
        job_id: activeJob.id,
        stage: activeJob.stage 
      }, correlationId);

      return new Response(JSON.stringify({
        success: true,
        job_id: activeJob.id,
        status: 'in_progress',
        message: `Stage '${activeJob.stage}' complete, next invocation will continue`,
      }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    const message = getErrorMessage(error);
    logError("Enrichment job failed", error instanceof Error ? error : new Error(message), ErrorCategory.EXTERNAL_API, ErrorSeverity.HIGH, {
      job_id: activeJob?.id,
      cluster_id: activeJob?.cluster_id,
      message,
    }, correlationId);

    if (activeJob) {
      const attempts = activeJob.attempts ?? 0;
      if (attempts >= MAX_JOB_RETRIES) {
        await updateJobState(activeJob.id, "failed", message, correlationId);
        try {
          await persistResult(activeJob.cluster_id, {
            status: "failed",
            proposed: {
              roaster_name: null,
              aliases: [],
              roaster_website_url: null,
              roaster_logo_url: null,
              city: null,
              state: null,
              country: null,
              address: null,
              is_roaster: null,
            },
            sources: [],
            signals: { error: message },
            confidence: 0,
            error: message,
          }, [], correlationId);
        } catch (persistError) {
          logWarning("Failed to persist failed result", {
            job_id: activeJob.id,
            message: getErrorMessage(persistError),
          }, correlationId);
        }
      } else {
        const delayMinutes = computeRetryDelayMinutes(attempts);
        if (delayMinutes !== null) {
          const runAfter = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
          const { error: retryError } = await supabase
            .schema("service")
            .from("roaster_enrichment_jobs")
            .update({
              state: "queued",
              run_after: runAfter,
              locked_at: null,
              locked_by: null,
              last_error: message,
            })
            .eq("id", activeJob.id);

          if (retryError) {
            logError("Failed to re-queue enrichment job", toError(retryError), ErrorCategory.DATABASE, ErrorSeverity.HIGH, {
              job_id: activeJob.id,
              run_after: runAfter,
            }, correlationId);
          } else {
            logWarning("Enrichment job re-queued after failure", {
              job_id: activeJob.id,
              attempt: attempts,
              run_after: runAfter,
              delay_minutes: delayMinutes,
            }, correlationId);
          }
        } else {
          logWarning("Retry delay not configured for attempt", {
            job_id: activeJob.id,
            attempt: attempts,
          }, correlationId);
        }
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error: message,
      job_id: activeJob?.id ?? null,
    }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } finally {
    flushLogsOnExit();
  }
});
