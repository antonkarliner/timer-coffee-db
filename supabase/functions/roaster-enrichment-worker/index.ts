//v20260128-parse-batch
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  GROQ_DEFAULT_MODEL,
  groqReasoningOverride,
  OPENAI_MODELS,
} from "../_shared/ai-models.ts";
import { fetchWithTimeout } from "../_shared/fetch-with-timeout.ts";
import {
  boundEvidencePayload,
  parseBatchedLogoResults,
  stripHtmlForLlm,
} from "../_shared/enrichment-prompt-utils.ts";
import {
  getEnvVar,
  validateAndLogEnvironment,
} from "../_shared/env-validation.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  flushLogsOnExit,
  generateCorrelationId,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";
import {
  buildPolicyV2Context,
  EVIDENCE_POLICY_VERSION,
  finalDisposition,
  shouldRestartForPolicyV2,
  validationReasons,
} from "./evidence-policy.ts";
import {
  applyInstagramRouting,
  mergeInstagramRoutingRecords,
} from "./instagram-routing.ts";
import {
  buildSearchQueries,
  discoverCandidateSources,
  SearchQuery,
} from "./search-discovery.ts";
validateAndLogEnvironment();
const FUNCTION_NAME = "roaster-enrichment-worker";
const JOB_LOCKED_BY = "roaster-enrichment-worker";
const supabaseUrl = getEnvVar("SUPABASE_URL");
const supabaseServiceRoleKey = getEnvVar("SUPABASE_SERVICE_ROLE_KEY");
const cronJobSecret = getEnvVar("CRON_JOB_SECRET");
const groqApiKey = getEnvVar("GROQ_API_KEY");
const openaiApiKey = getEnvVar("OPENAI_API_KEY_NON_PERSONAL");
if (!supabaseUrl || !supabaseServiceRoleKey || !cronJobSecret) {
  throw new Error(
    "Missing required Supabase configuration for roaster enrichment worker",
  );
}
if (!groqApiKey || !openaiApiKey) {
  throw new Error(
    "Missing required LLM API keys for roaster enrichment worker",
  );
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false,
  },
});
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_JOB_RETRIES = 3;
const RETRY_BACKOFF_MINUTES = [
  15,
  60,
  360,
];
// Timeout configuration (Edge function timeout is ~150s, we need to finish before that)
const AI_API_TIMEOUT_MS = 10000; // 10s max for AI API calls
const OPENAI_VALIDATE_TIMEOUT_MS = 20000; // 20s for OpenAI validation
const OPENAI_EXTRACT_TIMEOUT_MS = 20000; // 20s for OpenAI extraction
const LOGO_VERIFY_TIMEOUT_MS = 8000; // 8s max for logo verification
const LOGO_BATCH_VERIFY_TIMEOUT_MS = 15000; // 15s max for batched logo verification
const RPC_TIMEOUT_MS = 3000; // 3s max for RPC calls
const FETCH_TIMEOUT_MS = 8000; // 8s max for external page fetches
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
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
const MAX_LOGOS_TO_VERIFY = 3; // Verify a small ranked set without blowing the function budget
const PARSE_BATCH_SIZE = 3; // Process 3 pages per invocation (increased from 1)
const FETCH_BATCH_SIZE = 3; // Fetch 3 URLs per invocation (increased from 1)
const GROQ_TRIAGE_MODELS = [
  GROQ_DEFAULT_MODEL,
  // llama-3.3-70b-versatile was decommissioned on 2026-08-16. Keep the
  // fallback outside the qwen/ family so it exercises a different model family.
  "openai/gpt-oss-120b",
];
const ADDRESS_REGEX =
  /\b\d{1,5}\s+[\w\.,'\-\s]{3,120},?\s+[\p{L}\s\.-]{2,80},?\s+[\p{L}\.\-\s]{2,80}\b/giu;
// Shared proposed-roaster JSON schema fragment, reused verbatim by the
// extract and validate prompts so their static prefixes stay byte-identical
// across calls (enables provider prompt-prefix caching at the 5-min cron
// cadence). See plans/001-roaster-enrichment-prompt-optimization.md item 5.
const PROPOSED_SCHEMA_JSON =
  `{"roaster_name": string|null, "aliases": string[], "roaster_website_url": string|null, "instagram_url": string|null, "roaster_logo_url": string|null, "city": string|null, "state": string|null, "country": string|null, "address": string|null, "is_roaster": boolean|null}`;
const EXTRACT_PROMPT_STATIC =
  `You are extracting roaster fields from evidence. Return ONLY JSON with keys:
{"proposed": ${PROPOSED_SCHEMA_JSON}, "confidence": number|null, "conflicts": string[], "notes": string|null}

CRITICAL REQUIREMENTS:
1. When selecting roaster_logo_url, ONLY choose from the provided logos array - these have been pre-verified as actual logos.
2. Do NOT look for logos in other parts of evidence - only use the provided logos array.
3. If no valid logo exists in logos array, set roaster_logo_url to null.
4. Use bean-specific search evidence from candidate_context.search_evidence to disambiguate generic or conflicting roaster names. If the bean-specific evidence points to a different roaster/domain than the proposed website, include a conflict and lower confidence; do not silently pick the generic-domain result.
5. candidate_context.user_contribution (when present) is a website submitted by an app user who logged this roaster's beans — a high-confidence signal of the official site. Prefer it as roaster_website_url when it is consistent with the other evidence, and prefer a roaster_logo_url whose domain matches it. Its instagram_url (when present) is the same kind of high-confidence official-profile signal for the instagram_url field. If it clearly contradicts strong, repeated candidate evidence (e.g. a different country), record a conflict and lower confidence instead of blindly accepting it.
6. Search titles/snippets and contributed city/country values are discovery leads, not proof. Only fetched and parsed page evidence may establish proposed identity, domain, or location fields.
7. Social networks — Instagram, Facebook, TikTok, X/Twitter, Linktree — are not independent websites and must never be put in roaster_website_url. An official Instagram account belongs in instagram_url as https://www.instagram.com/<handle>/. A roaster whose only web presence is an Instagram account is normal: set roaster_website_url to null and put the account in instagram_url.`;
const VALIDATE_PROMPT_STATIC =
  `Validate and refine the proposed roaster data. Return ONLY JSON with keys:
{"proposed": ${PROPOSED_SCHEMA_JSON}, "confidence": number|null, "needs_review": boolean, "notes": string|null}

IMPORTANT: Ensure that roaster_logo_url (if present) ends with .png, .jpg, .jpeg, or .webp extension. If the proposed logo is not in this format, either find a compliant logo from the evidence or set it to null.
IMPORTANT: Review bean-specific search evidence before accepting the proposed identity. If roaster + bean-name results contradict the proposed roaster/domain, set needs_review=true and explain the conflict instead of approving a clean identity.
IMPORTANT: If candidate_context.user_contribution is present, it is a user-submitted official website. Honor it as roaster_website_url when it is consistent with the evidence (and prefer a domain-matching logo); only override it when other strong evidence contradicts it, in which case set needs_review=true and explain. Its instagram_url (when present) is a high-confidence official-profile signal, parallel to the contributed website.
IMPORTANT: Social networks — Instagram, Facebook, TikTok, X/Twitter, Linktree — are not independent websites and must never be put in roaster_website_url; an official Instagram account belongs in instagram_url as https://www.instagram.com/<handle>/, and a roaster with only an Instagram presence is normal (roaster_website_url null). If roaster_website_url and instagram_url name different Instagram accounts, do not choose one: set needs_review=true and explain the conflict.
IMPORTANT: Search titles/snippets and contributed city/country values are discovery leads, not proof. Validate identity, domain, and every location field only against fetched and parsed page evidence; unresolved conflicts require needs_review=true.`;
const SUMMARY_PROMPT_STATIC =
  `Summarize the evidence into JSON. Use ONLY the evidence provided.
IMPORTANT: Only include logo URLs that end with .png, .jpg, .jpeg, or .webp extensions. Exclude all other image formats.
IMPORTANT: Treat roaster-name + coffee-bean-name search results in candidate_context.search_evidence as disambiguation evidence. If bean-specific results point to a different roaster/domain than generic roaster-name results, preserve that conflict in notes and sources instead of collapsing the identity too early.
IMPORTANT: Search titles and snippets are discovery metadata, not proof. Only fetched and parsed page evidence may establish names, addresses, logos, domains, or location. User-contributed city/country values are leads that must be verified against fetched page evidence.

Return JSON with keys:
{"website": string|null, "logos": string[], "addresses": string[], "city": string|null, "state": string|null, "country": string|null, "socials": string[], "sources": string[], "notes": string|null}`;
const EVIDENCE_SUMMARY_FORMAT = {
  type: "json_schema",
  name: "roaster_evidence_summary",
  strict: true,
  schema: {
    type: "object",
    properties: {
      website: { type: ["string", "null"] },
      logos: { type: "array", items: { type: "string" } },
      addresses: { type: "array", items: { type: "string" } },
      city: { type: ["string", "null"] },
      state: { type: ["string", "null"] },
      country: { type: ["string", "null"] },
      socials: { type: "array", items: { type: "string" } },
      sources: { type: "array", items: { type: "string" } },
      notes: { type: ["string", "null"] },
    },
    required: [
      "website",
      "logos",
      "addresses",
      "city",
      "state",
      "country",
      "socials",
      "sources",
      "notes",
    ],
    additionalProperties: false,
  },
};
class ProviderRetryableError extends Error {
  status: number;
  body: string | null;
  constructor(message: string, status: number, body: string | null = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
function buildReenrichmentPromptBlock(opts) {
  const reviewerNotes = opts?.reviewerNotes ?? null;
  const rejectionReason = opts?.rejectionReason ?? null;
  const priorProposed = opts?.priorProposed ?? null;
  const priorConfidence = typeof opts?.priorConfidence === "number"
    ? opts.priorConfidence
    : null;
  const includePriorPayload = opts?.includePriorPayload !== false;
  if (!reviewerNotes && !rejectionReason && !priorProposed) return "";
  const lines = [
    "",
    "RE-ENRICHMENT CONTEXT (a previous attempt was rejected by a human reviewer):",
  ];
  if (rejectionReason) lines.push(`- Rejection reason: ${rejectionReason}`);
  if (reviewerNotes) {
    lines.push(`- Reviewer notes: ${JSON.stringify(reviewerNotes)}`);
  }
  if (includePriorPayload && priorProposed) {
    lines.push(`- Previous proposed output: ${JSON.stringify(priorProposed)}`);
    if (priorConfidence != null) {
      lines.push(`- Previous confidence: ${priorConfidence}`);
    }
  }
  lines.push(
    "Treat the previous output as suspect. Where reviewer notes contradict the previous output or your initial inclination, prefer the reviewer's direction.",
  );
  return lines.join("\n");
}
async function verifyLogoWithOpenAI(imageUrl, roasterName, correlationId) {
  logInfo("Verifying logo with GPT", {
    imageUrl,
    roasterName,
    model: OPENAI_MODELS.MEDIUM,
  }, correlationId);
  const prompt =
    `You are a logo verification expert. Analyze this image and determine if it is a company logo.

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
    model: OPENAI_MODELS.MEDIUM,
    reasoning: {
      effort: "none",
    },
    text: {
      format: {
        type: "json_object",
      },
    },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt,
          },
          {
            type: "input_image",
            image_url: imageUrl,
          },
        ],
      },
    ],
  };
  try {
    const response = await fetchWithRetry(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    }, {
      correlationId,
      label: "gpt_logo_verify",
      timeoutMs: LOGO_VERIFY_TIMEOUT_MS,
      maxAttempts: 1,
    });
    if (!response.ok) {
      const errorBody = await response.text();
      logWarning("Logo verification HTTP error", {
        imageUrl,
        status: response.status,
        body: errorBody.slice(0, 500),
        model: OPENAI_MODELS.MEDIUM,
      }, correlationId);
      return {
        isLogo: false,
        confidence: 0,
        reason: `HTTP error: ${response.status}`,
      };
    }
    const json = await response.json();
    const outputText = extractOpenAiOutputText(json);
    const parsed = parseModelJson(outputText, {
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
      error: errorMessage,
    }, correlationId);
    return {
      isLogo: false,
      confidence: 0,
      reason: `Verification failed: ${errorMessage.slice(0, 50)}`,
    };
  }
}
async function verifyLogosBatchWithOpenAI(
  imageUrls: string[],
  roasterName: string,
  correlationId: string,
) {
  logInfo("Verifying logos with GPT (batch)", {
    imageCount: imageUrls.length,
    roasterName,
    model: OPENAI_MODELS.MEDIUM,
  }, correlationId);
  const n = imageUrls.length;
  const prompt =
    `You are a logo verification expert. You will receive ${n} images, numbered 0..${
      n - 1
    } in order. For each image, determine if it is a company logo.

Expected brand name: ${roasterName}

Logo characteristics to look for:
- Distinctive brand mark or symbol
- Text matching brand name
- Simple, recognizable design
- NOT: product photos, promotional graphics, people, scenery
- NOT: product packaging with logos (the packaging itself, not the logo)
- NOT: store interiors or product displays

Return ONLY JSON: {"results":[{"index":0,"isLogo":true/false,"confidence":0.0-1.0,"reason":"<20 words"}, ...]} with exactly one entry per image.`;
  const requestBody = {
    model: OPENAI_MODELS.MEDIUM,
    reasoning: {
      effort: "none",
    },
    text: {
      format: {
        type: "json_object",
      },
    },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt,
          },
          ...imageUrls.map((imageUrl: string) => ({
            type: "input_image",
            image_url: imageUrl,
          })),
        ],
      },
    ],
  };
  try {
    const response = await fetchWithRetry(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    }, {
      correlationId,
      label: "gpt_logo_verify_batch",
      timeoutMs: LOGO_BATCH_VERIFY_TIMEOUT_MS,
      maxAttempts: 1,
    });
    if (!response.ok) {
      const errorBody = await response.text();
      logWarning("Batched logo verification HTTP error", {
        imageCount: n,
        status: response.status,
        body: errorBody.slice(0, 500),
        model: OPENAI_MODELS.MEDIUM,
      }, correlationId);
      return null;
    }
    const json = await response.json();
    const outputText = extractOpenAiOutputText(json);
    const parsed = parseModelJson(outputText, null);
    const results = parseBatchedLogoResults(parsed, n);
    if (!results) {
      logWarning("Batched logo verification response unparsable", {
        imageCount: n,
        outputText: outputText?.slice?.(0, 500),
      }, correlationId);
      return null;
    }
    return results;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logWarning("Batched logo verification failed", {
      imageCount: n,
      error: errorMessage,
    }, correlationId);
    return null;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return Math.max(0, parsed - Date.now());
  return null;
}
function computeBackoff(attempt, baseMs = 500, maxMs = 8000) {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.random() * exponential * 0.2;
  return exponential + jitter;
}
async function fetchWithRetry(
  url,
  options,
  {
    maxAttempts = 3,
    correlationId,
    label,
    timeoutMs,
  }: {
    maxAttempts?: number;
    correlationId?: string;
    label?: string;
    timeoutMs?: number;
  } = {},
) {
  let lastResponse = null;
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
      const delay = Math.min(
        retryAfter ?? computeBackoff(attempt),
        MAX_RETRY_DELAY_MS,
      );
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
function stripCodeFence(value) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
}
function sanitizeForJson(value) {
  if (!value) return value;
  // Remove UTF-16 surrogate halves + NUL bytes to keep JSONB inserts valid.
  return value.replace(/[\u0000\uD800-\uDFFF]/g, "");
}
function parseModelJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(stripCodeFence(raw));
  } catch {
    return fallback;
  }
}
function extractOpenAiOutputText(json) {
  const outputItems = safeArray(json?.output);
  const contentItems = outputItems.flatMap((item) => safeArray(item?.content));
  return json?.output_text ??
    contentItems.find((content) =>
      content?.type === "output_text" && typeof content.text === "string"
    )?.text ??
    contentItems.find((content) => typeof content?.text === "string")?.text ??
    "{}";
}
function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = error.message;
    if (typeof message === "string") return message;
    const nested = error.error?.message;
    if (typeof nested === "string") return nested;
  }
  return "Unknown error";
}
function toError(error) {
  if (error instanceof Error) return error;
  const message = getErrorMessage(error);
  return new Error(message);
}
function getErrorDetails(error) {
  const message = getErrorMessage(error);
  const name = error instanceof Error ? error.name : undefined;
  const type = error === null ? "null" : typeof error;
  let raw;
  if (error && typeof error === "object") {
    try {
      raw = JSON.stringify(error);
    } catch {
      raw = undefined;
    }
  }
  if (raw && raw.length > 500) raw = raw.slice(0, 500);
  return {
    message,
    type,
    name,
    raw,
  };
}
function isBinaryLikeUrl(value) {
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
function normalizeDomain(value) {
  return value.replace(/^www\./i, "").toLowerCase();
}
function extractDomain(value) {
  try {
    return normalizeDomain(new URL(value).hostname);
  } catch {
    return null;
  }
}
function filterLogosByExtension(urls) {
  const ALLOWED_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
  ];
  return urls.filter((url) => {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      return ALLOWED_EXTENSIONS.some((ext) =>
        pathname.endsWith(ext) || pathname.includes(`${ext}?`)
      );
    } catch {
      return false;
    }
  });
}
function isAggregatorDomain(domain) {
  if (!domain) return false;
  const normalized = normalizeDomain(domain);
  return SEARCH_AGGREGATOR_DOMAINS.some((blocked) =>
    normalized === blocked || normalized.endsWith(`.${blocked}`)
  );
}
function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}
function extractMetaContent(html, property) {
  const regex = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const match = html.match(regex);
  return match?.[1] ?? null;
}
function resolveUrlCandidate(baseUrl, value) {
  if (!value) return null;
  try {
    const parsed = new URL(value, baseUrl);
    if (
      ![
        "http:",
        "https:",
      ].includes(parsed.protocol)
    ) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}
function extractAttributeValue(attrs, name) {
  const regex = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return attrs.match(regex)?.[1] ?? null;
}
function parseSrcsetUrls(value) {
  return value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(
    Boolean,
  );
}
function extractHtmlLogoCandidates(baseUrl, html) {
  const logos = [];
  const pushCandidate = (value) => {
    const normalized = resolveUrlCandidate(baseUrl, value);
    if (normalized) logos.push(normalized);
  };
  for (const match of html.matchAll(/<img\b([^>]+)>/gi)) {
    const attrs = match[1] ?? "";
    pushCandidate(extractAttributeValue(attrs, "src"));
    pushCandidate(extractAttributeValue(attrs, "data-src"));
    const srcset = extractAttributeValue(attrs, "srcset") ??
      extractAttributeValue(attrs, "data-srcset");
    if (srcset) {
      for (const candidate of parseSrcsetUrls(srcset)) {
        pushCandidate(candidate);
      }
    }
  }
  for (const match of html.matchAll(/<source\b([^>]+)>/gi)) {
    const attrs = match[1] ?? "";
    const srcset = extractAttributeValue(attrs, "srcset") ??
      extractAttributeValue(attrs, "data-srcset");
    if (srcset) {
      for (const candidate of parseSrcsetUrls(srcset)) {
        pushCandidate(candidate);
      }
    }
  }
  for (const match of html.matchAll(/<link\b([^>]+)>/gi)) {
    const attrs = match[1] ?? "";
    const rel = extractAttributeValue(attrs, "rel")?.toLowerCase() ?? "";
    if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
    pushCandidate(extractAttributeValue(attrs, "href"));
  }
  for (
    const match of html.matchAll(
      /["'`](https?:\/\/[^"'`\s]+?\.(?:png|jpe?g|webp)(?:\?[^"'`\s]*)?|\/[^"'`\s]+?\.(?:png|jpe?g|webp)(?:\?[^"'`\s]*)?)["'`]/gi,
    )
  ) {
    pushCandidate(match[1]);
  }
  return uniqueStrings(filterLogosByExtension(logos));
}
function slugTokens(value) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}
function rankLogoCandidates(candidates, roasterName, website) {
  const websiteDomain = website ? extractDomain(website) : null;
  const nameTokens = slugTokens(roasterName);
  const scored = candidates.map((url) => {
    let score = 0;
    let pathname = "";
    let hostname = "";
    try {
      const parsed = new URL(url);
      pathname = parsed.pathname.toLowerCase();
      hostname = parsed.hostname.toLowerCase();
      const normalizedDomain = normalizeDomain(hostname);
      if (websiteDomain && normalizedDomain === websiteDomain) score += 5;
      if (pathname.includes("/cdn/shop/files/")) score += 4;
      if (
        /(^|[\/_-])(logo|logos|wordmark|brand|branding|header|site-title|navbar)([\/_.-]|$)/i
          .test(pathname)
      ) score += 8;
      if (/(icon|favicon|apple-touch-icon)/i.test(pathname)) score += 3;
      if (
        /(product|products|collection|collections|article|blog|hero|banner|slide|thumb|gallery)/i
          .test(pathname)
      ) score -= 4;
      if (/(giftcard|gift-card|gift_card)/i.test(pathname)) score -= 1;
    } catch {
      score -= 10;
    }
    const urlLower = url.toLowerCase();
    for (const token of nameTokens) {
      if (urlLower.includes(token)) score += 2;
    }
    return {
      url,
      score,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  return scored.map((entry) => entry.url);
}
function extractJsonLd(html) {
  const matches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  const jsonLd = [];
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
function extractInternalLinks(baseUrl, html) {
  const base = new URL(baseUrl);
  const links = Array.from(html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)).map(
    (match) => match[1],
  ).filter((href) => Boolean(href));
  const resolved = links.map((href) => {
    try {
      const url = new URL(href, base);
      if (url.hostname !== base.hostname) return null;
      if (
        ![
          "http:",
          "https:",
        ].includes(url.protocol)
      ) return null;
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }).filter((href) => Boolean(href));
  return uniqueStrings(resolved);
}
function isAddressPageCandidate(pathname) {
  const normalized = pathname.toLowerCase();
  return ADDRESS_PATH_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
function extractFromJsonLd(data) {
  const logos = [];
  const names = [];
  const addresses = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry;
    const name = record.name;
    if (typeof name === "string") names.push(name);
    const logo = record.logo ?? record.image;
    if (typeof logo === "string") logos.push(logo);
    if (logo && typeof logo === "object") {
      const logoUrl = logo.url;
      if (typeof logoUrl === "string") logos.push(logoUrl);
    }
    const address = record.address;
    if (typeof address === "string") {
      addresses.push(address);
    }
    if (address && typeof address === "object") {
      const addressRecord = address;
      const parts = [
        addressRecord.streetAddress,
        addressRecord.addressLocality,
        addressRecord.addressRegion,
        addressRecord.postalCode,
        addressRecord.addressCountry,
      ].filter((part) => typeof part === "string" && part.trim()).map((part) =>
        String(part).trim()
      );
      if (parts.length) addresses.push(parts.join(", "));
    }
  }
  return {
    logos: uniqueStrings(logos),
    names: uniqueStrings(names),
    addresses: uniqueStrings(addresses),
  };
}
function extractAddresses(html) {
  const matches = Array.from(html.matchAll(ADDRESS_REGEX)).map((match) =>
    match[0]
  );
  return uniqueStrings(matches.map((value) => value.trim())).slice(0, 6);
}
const PARSE_LLM_HTML_CHAR_CAP = 6000;
async function parsePageWithLLM(url, html, correlationId) {
  logInfo("Parsing page with LLM", {
    url,
    model: OPENAI_MODELS.MEDIUM,
  }, correlationId);
  const manualParsed = parsePageEvidence(url, html);
  // Manual (regex-based) parsing already fills title/jsonLd/og-tags/logos
  // deterministically and for free. Only fall through to the LLM when it
  // couldn't find enough — its marginal value is free-text addresses/names.
  if (
    manualParsed.title &&
    (manualParsed.logos.length > 0 || manualParsed.addresses.length > 0)
  ) {
    logInfo("Skipping LLM page parse, manual parse sufficient", {
      url,
      logo_count: manualParsed.logos.length,
      address_count: manualParsed.addresses.length,
    }, correlationId);
    return manualParsed;
  }
  const strippedHtml = stripHtmlForLlm(html).slice(0, PARSE_LLM_HTML_CHAR_CAP);
  const prompt =
    `Parse this web page content and extract structured information about a coffee roaster.
Return ONLY JSON with this exact structure:
{
  "title": string|null,
  "addresses": string[],
  "names": string[]
}

Important instructions:
1. Extract the page title (from a <title> tag or the most prominent heading)
2. Find all physical addresses
3. Find all company/roaster names

Page content (HTML tags stripped, meta tags kept): ${strippedHtml}`;
  try {
    const requestBody = {
      model: OPENAI_MODELS.MEDIUM,
      reasoning: {
        effort: "none",
      },
      text: {
        format: {
          type: "json_object",
        },
      },
      input: prompt,
    };
    const response = await fetchWithRetry(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    }, {
      correlationId,
      label: "gpt_parse",
      timeoutMs: AI_API_TIMEOUT_MS,
    });
    if (!response.ok) {
      const errorBody = await response.text();
      logWarning("GPT parsing HTTP error", {
        url,
        status: response.status,
        body: errorBody.slice(0, 500),
        model: OPENAI_MODELS.MEDIUM,
      }, correlationId);
      throw new Error(`GPT parsing failed: ${response.status}`);
    }
    const json = await response.json();
    const outputText = extractOpenAiOutputText(json);
    const result = parseModelJson(outputText, {});
    return {
      url,
      title: typeof result.title === "string"
        ? result.title
        : manualParsed.title,
      jsonLd: manualParsed.jsonLd,
      ogLogo: manualParsed.ogLogo,
      ogImage: manualParsed.ogImage,
      logos: manualParsed.logos,
      addresses: uniqueStrings([
        ...safeArray(result.addresses),
        ...manualParsed.addresses,
      ]),
      names: uniqueStrings([
        ...safeArray(result.names),
        ...manualParsed.names,
      ]),
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
function parsePageEvidence(url, html) {
  // Limit HTML to 30KB to prevent CPU exhaustion from regex on large pages
  const limitedHtml = html.slice(0, 30000);
  const titleMatch = limitedHtml.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? null;
  const jsonLd = extractJsonLd(limitedHtml);
  const ogLogo = extractMetaContent(limitedHtml, "og:logo");
  const ogImage = extractMetaContent(limitedHtml, "og:image");
  const addresses = extractAddresses(limitedHtml);
  const jsonLdExtracted = extractFromJsonLd(jsonLd);
  const htmlExtracted = extractHtmlLogoCandidates(url, limitedHtml);
  return {
    url,
    title,
    jsonLd,
    ogLogo,
    ogImage,
    logos: filterLogosByExtension(uniqueStrings([
      ...jsonLdExtracted.logos,
      ...htmlExtracted,
      ...ogLogo
        ? [
          ogLogo,
        ]
        : [],
      ...ogImage
        ? [
          ogImage,
        ]
        : [],
    ])),
    addresses: uniqueStrings([
      ...jsonLdExtracted.addresses,
      ...addresses,
    ]),
    names: jsonLdExtracted.names,
  };
}
function sanitizeParsedPage(page) {
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
async function lockNextJob(correlationId) {
  const { data: jobs, error } = await supabase.schema("service").rpc(
    "claim_roaster_enrichment_job",
    { p_locked_by: JOB_LOCKED_BY },
  );
  if (error) {
    logError(
      "Failed to claim enrichment job",
      toError(error),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      {},
      correlationId,
    );
    throw error;
  }
  const updated = jobs?.[0];
  if (!updated) {
    logInfo("No eligible enrichment jobs found", {}, correlationId);
    return null;
  }
  logInfo("Enrichment job locked", {
    job_id: updated.id,
    cluster_id: updated.cluster_id,
    failure_attempts: updated.attempts ?? 0,
  }, correlationId);
  return updated;
}
async function updateJobState(
  jobId,
  state,
  lastError,
  correlationId,
  extraFields = {},
) {
  logInfo("Updating enrichment job state", {
    job_id: jobId,
    state,
  }, correlationId);
  const { error } = await supabase.schema("service").from(
    "roaster_enrichment_jobs",
  ).update({
    ...extraFields,
    state,
    last_error: lastError,
  }).eq("id", jobId);
  if (error) {
    logError(
      "Failed to update job state",
      toError(error),
      ErrorCategory.DATABASE,
      ErrorSeverity.MEDIUM,
      {
        job_id: jobId,
        state,
      },
      correlationId,
    );
    return;
  }
  logInfo("Enrichment job state updated", {
    job_id: jobId,
    state,
  }, correlationId);
}
async function updateJobStage(jobOrId, stage, stageData, correlationId) {
  // Accept either a full job row (preferred) or a bare jobId for backward
  // compatibility. When given the full row, preserve `reenrichment` from the
  // previous stage_data so context survives across pipeline stages.
  let jobId;
  let mergedStageData = stageData;
  if (jobOrId && typeof jobOrId === "object") {
    jobId = jobOrId.id;
    const previousReenrichment = jobOrId.stage_data?.reenrichment ?? null;
    const previousPolicyVersion = jobOrId.stage_data?.evidence_policy_version;
    const previousTelemetry = jobOrId.stage_data?.legacy_upstream_telemetry;
    mergedStageData = {
      ...stageData,
      ...(previousReenrichment && stageData?.reenrichment === undefined
        ? { reenrichment: previousReenrichment }
        : {}),
      ...(previousPolicyVersion &&
          stageData?.evidence_policy_version === undefined
        ? { evidence_policy_version: previousPolicyVersion }
        : {}),
      ...(previousTelemetry &&
          stageData?.legacy_upstream_telemetry === undefined
        ? { legacy_upstream_telemetry: previousTelemetry }
        : {}),
    };
  } else {
    jobId = jobOrId;
  }
  logInfo("Updating job stage", {
    job_id: jobId,
    stage,
  }, correlationId);
  const { error } = await supabase.schema("service").from(
    "roaster_enrichment_jobs",
  ).update({
    stage,
    stage_data: mergedStageData,
    run_after: new Date().toISOString(),
    correlation_id: correlationId,
  }).eq("id", jobId);
  if (error) {
    logError(
      "Failed to update job stage",
      toError(error),
      ErrorCategory.DATABASE,
      ErrorSeverity.MEDIUM,
      {
        job_id: jobId,
        stage,
      },
      correlationId,
    );
    throw error;
  }
  logInfo("Job stage updated", {
    job_id: jobId,
    stage,
  }, correlationId);
}
async function processTriageStage(job, correlationId) {
  logInfo("Processing triage stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const { cluster, candidates, reenrichment, contribution } =
    await loadClusterContext(
      job,
      correlationId,
    );
  if (reenrichment) {
    logInfo("Re-enrichment context detected", {
      cluster_id: cluster.id,
      has_prior_result: !!reenrichment.prior_result_id,
      has_reviewer_notes: !!reenrichment.reviewer_notes,
      rejection_reason: reenrichment.rejection_reason,
    }, correlationId);
  }
  const triage = await triageAndNormalize(
    cluster,
    candidates,
    correlationId,
    reenrichment,
  );
  const policyContext = buildPolicyV2Context({
    candidates,
    userContribution: contribution,
  });
  logInfo("Policy v2 candidate context built", {
    job_id: job.id,
    ...policyContext.legacy_upstream_telemetry,
  }, correlationId);
  await updateJobStage(job, "search-candidates", {
    evidence_policy_version: EVIDENCE_POLICY_VERSION,
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
    candidate_context: policyContext.candidate_context,
    candidate_urls: [],
    legacy_upstream_telemetry: policyContext.legacy_upstream_telemetry,
    reenrichment: reenrichment ?? null,
  }, correlationId);
  logInfo("Triage stage completed, advanced to search-candidates", {
    job_id: job.id,
  }, correlationId);
  return {
    nextStage: "search-candidates",
  };
}

async function runWorkerSearch(query: SearchQuery): Promise<any[]> {
  const apiKey = Deno.env.get("GOOGLE_SEARCH_API_KEY");
  const engineId = Deno.env.get("GOOGLE_PROGRAMMABLE_ENGINE_ID");
  if (!apiKey || !engineId) {
    throw new Error("Missing worker search configuration");
  }
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", engineId);
  url.searchParams.set("q", query.query);
  const response = await fetchWithRetry(url.toString(), { method: "GET" }, {
    maxAttempts: 2,
    label: "worker_cluster_search_v2",
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`Google Custom Search failed: ${response.status}`);
  }
  const payload = await response.json();
  return safeArray(payload?.items);
}

async function processSearchCandidatesStage(job: any, correlationId: string) {
  logInfo("Processing search-candidates stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const candidateContext = stageData.candidate_context;
  const candidates = safeArray(candidateContext?.candidates);
  const clusterName = stageData.cluster?.display_name ??
    stageData.triage?.display_name ?? stageData.cluster?.normalized_name ?? "";
  const queryCount = buildSearchQueries(clusterName, candidates).length;
  const discovery = await discoverCandidateSources({
    clusterName,
    candidates,
    contributedWebsite: candidateContext?.user_contribution?.website_url ??
      null,
    search: runWorkerSearch,
  });
  if (queryCount > 0 && discovery.provider_failure_count === queryCount) {
    throw new Error("All worker candidate searches failed");
  }
  const nextCandidateContext = {
    ...candidateContext,
    search_evidence: discovery.search_evidence,
  };
  await updateJobStage(job, "fetch-candidates", {
    ...stageData,
    evidence_policy_version: EVIDENCE_POLICY_VERSION,
    candidate_context: nextCandidateContext,
    candidate_urls: discovery.candidate_urls,
    fetched_pages: [],
  }, correlationId);
  logInfo("Search-candidates stage completed, advanced to fetch-candidates", {
    job_id: job.id,
    query_count: queryCount,
    result_count: discovery.search_evidence.results.length,
    url_count: discovery.candidate_urls.length,
    provider_failure_count: discovery.provider_failure_count,
  }, correlationId);
  return { nextStage: "fetch-candidates" };
}
async function processEvidenceStage(job, correlationId) {
  logWarning("Legacy evidence stage reached after policy restart guard", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  throw new Error(
    "Legacy evidence stage is not valid under evidence policy v2",
  );
}
// ==================== NEW MICRO-STAGE HANDLERS ====================
async function processFetchCandidatesStage(job, correlationId) {
  logInfo("Processing fetch-candidates stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const { candidate_urls: urls } = stageData;
  // Get already fetched pages (from previous invocations)
  const fetchedPages = stageData.fetched_pages ?? [];
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
    logInfo(`Fetching candidate URL ${i + 1}/${urls.length}`, {
      url,
    }, correlationId);
    try {
      const response = await fetchWithRetry(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
        },
      }, {
        maxAttempts: 2,
        correlationId,
        label: "fetch_candidate",
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      if (response.ok) {
        const contentType =
          response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          contentType && !contentType.includes("text/html") &&
          !contentType.includes("application/xhtml+xml")
        ) {
          logWarning("Skipping non-HTML candidate URL", {
            url,
            status: response.status,
            content_type: contentType,
          }, correlationId);
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
        logInfo(`Successfully fetched candidate URL`, {
          url,
          status: response.status,
          size: html.length,
        }, correlationId);
      } else {
        logWarning(`Candidate URL fetch failed`, {
          url,
          status: response.status,
        }, correlationId);
        fetchedPages.push({
          url,
          html: "",
          status: response.status,
          fetched_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      logWarning(`Candidate URL fetch error`, {
        url,
        error: getErrorMessage(error),
      }, correlationId);
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
    await updateJobStage(job, "fetch-candidates", {
      ...stageData,
      fetched_pages: fetchedPages,
      fetch_progress: {
        next_index: nextIndex,
        total_urls: progress.total_urls,
      },
    }, correlationId);
    logInfo("Fetch-candidates batch complete, more URLs pending", {
      job_id: job.id,
      fetched_count: fetchedPages.length,
      next_index: nextIndex,
      total_urls: progress.total_urls,
    }, correlationId);
    return {
      nextStage: "fetch-candidates",
    };
  } else {
    // All URLs fetched, advance to parse-candidates
    // Clean up progress tracking from stage_data
    const { fetch_progress: _, ...stageDataWithoutProgress } = stageData;
    await updateJobStage(job, "parse-candidates", {
      ...stageDataWithoutProgress,
      fetched_pages: fetchedPages,
    }, correlationId);
    logInfo("Fetch-candidates stage completed, advanced to parse-candidates", {
      job_id: job.id,
      fetched_count: fetchedPages.length,
      total_urls: progress.total_urls,
    }, correlationId);
    return {
      nextStage: "parse-candidates",
    };
  }
}
async function processParseCandidatesStage(job, correlationId) {
  logInfo("Processing parse-candidates stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const { fetched_pages: fetchedPages } = stageData;
  // Get already parsed pages (from previous invocations)
  const parsedPages = stageData.parsed_pages ?? [];
  // Initialize or load progress tracking
  // For backward compatibility: resume from already parsed count if no progress tracked
  const progress = stageData.parse_progress ?? {
    next_index: parsedPages.length,
    total_pages: fetchedPages.length,
  };
  // Calculate batch range
  const startIndex = progress.next_index;
  const endIndex = Math.min(
    startIndex + PARSE_BATCH_SIZE,
    progress.total_pages,
  );
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
      logWarning(`Skipping empty HTML for URL`, {
        url: fetched.url,
        index: i,
      }, correlationId);
      continue;
    }
    try {
      const page = await parsePageWithLLM(
        fetched.url,
        fetched.html,
        correlationId,
      );
      parsedPages.push({
        url: fetched.url,
        page: sanitizeParsedPage(page),
      });
      logInfo(`Parsed candidate page`, {
        url: fetched.url,
        index: i,
        title: page.title,
        logo_count: page.logos.length,
        address_count: page.addresses.length,
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
    await updateJobStage(job, "parse-candidates", {
      ...stageData,
      parsed_pages: parsedPages,
      parse_progress: {
        next_index: nextIndex,
        total_pages: progress.total_pages,
      },
    }, correlationId);
    logInfo("Parse-candidates batch complete, more pages pending", {
      job_id: job.id,
      parsed_count: parsedPages.length,
      next_index: nextIndex,
      total_pages: progress.total_pages,
    }, correlationId);
    return {
      nextStage: "parse-candidates",
    };
  } else {
    // All pages parsed, advance to discover-links
    // Clean up progress tracking from stage_data
    const { parse_progress: _, ...stageDataWithoutProgress } = stageData;
    await updateJobStage(job, "discover-links", {
      ...stageDataWithoutProgress,
      parsed_pages: parsedPages,
    }, correlationId);
    logInfo("Parse-candidates stage completed, advanced to discover-links", {
      job_id: job.id,
      parsed_count: parsedPages.length,
      total_pages: progress.total_pages,
    }, correlationId);
    return {
      nextStage: "discover-links",
    };
  }
}
async function processDiscoverLinksStage(job, correlationId) {
  logInfo("Processing discover-links stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const { parsed_pages: parsedPages, candidate_urls: urls } = stageData;
  const seenUrls = new Set(urls);
  const domainCounts = new Map();
  const discoveredUrls = [];
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
    const fetchedPage = stageData.fetched_pages.find((fp) =>
      fp.url === parsed.url
    );
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
    discovered_urls: discoveredUrls,
  }, correlationId);
  // Advance to fetch-discovered stage - drop raw HTML since it's no longer needed
  const { fetched_pages: _fetchedPages, ...stageDataWithoutFetchedPages } =
    stageData;
  await updateJobStage(job, "fetch-discovered", {
    ...stageDataWithoutFetchedPages,
    discovered_urls: discoveredUrls,
  }, correlationId);
  logInfo("Discover-links stage completed, advanced to fetch-discovered", {
    job_id: job.id,
    discovered_count: discoveredUrls.length,
  }, correlationId);
  return {
    nextStage: "fetch-discovered",
  };
}
async function processFetchDiscoveredStage(job, correlationId) {
  logInfo("Processing fetch-discovered stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const { discovered_urls: urls } = stageData;
  // Get already fetched pages (from previous invocations)
  const fetchedDiscovered = stageData.fetched_discovered ?? [];
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
    logInfo(`Fetching discovered URL ${i + 1}/${urls.length}`, {
      url,
    }, correlationId);
    try {
      const response = await fetchWithRetry(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
        },
      }, {
        maxAttempts: 2,
        correlationId,
        label: "fetch_discovered",
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      if (response.ok) {
        const contentType =
          response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          contentType && !contentType.includes("text/html") &&
          !contentType.includes("application/xhtml+xml")
        ) {
          logWarning("Skipping non-HTML discovered URL", {
            url,
            status: response.status,
            content_type: contentType,
          }, correlationId);
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
        logInfo(`Successfully fetched discovered URL`, {
          url,
          status: response.status,
          size: html.length,
        }, correlationId);
      } else {
        logWarning(`Discovered URL fetch failed`, {
          url,
          status: response.status,
        }, correlationId);
        fetchedDiscovered.push({
          url,
          html: "",
          status: response.status,
          fetched_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      logWarning(`Discovered URL fetch error`, {
        url,
        error: getErrorMessage(error),
      }, correlationId);
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
    await updateJobStage(job, "fetch-discovered", {
      ...stageData,
      fetched_discovered: fetchedDiscovered,
      fetch_discovered_progress: {
        next_index: nextIndex,
        total_urls: progress.total_urls,
      },
    }, correlationId);
    logInfo("Fetch-discovered batch complete, more URLs pending", {
      job_id: job.id,
      fetched_count: fetchedDiscovered.length,
      next_index: nextIndex,
      total_urls: progress.total_urls,
    }, correlationId);
    return {
      nextStage: "fetch-discovered",
    };
  } else {
    // All URLs fetched, advance to parse-discovered
    // Clean up progress tracking from stage_data
    const { fetch_discovered_progress: _, ...stageDataWithoutProgress } =
      stageData;
    await updateJobStage(job, "parse-discovered", {
      ...stageDataWithoutProgress,
      fetched_discovered: fetchedDiscovered,
    }, correlationId);
    logInfo("Fetch-discovered stage completed, advanced to parse-discovered", {
      job_id: job.id,
      fetched_count: fetchedDiscovered.length,
      total_urls: progress.total_urls,
    }, correlationId);
    return {
      nextStage: "parse-discovered",
    };
  }
}
async function processParseDiscoveredStage(job, correlationId) {
  logInfo("Processing parse-discovered stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const { fetched_discovered: fetchedDiscovered } = stageData;
  // Get already parsed pages
  const parsedDiscovered = stageData.parsed_discovered ?? [];
  // Initialize or load progress tracking
  // For backward compatibility: resume from already parsed count if no progress tracked
  const progress = stageData.parse_progress ?? {
    next_index: parsedDiscovered.length,
    total_pages: fetchedDiscovered.length,
  };
  // Calculate batch range
  const startIndex = progress.next_index;
  const endIndex = Math.min(
    startIndex + PARSE_BATCH_SIZE,
    progress.total_pages,
  );
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
      logWarning(`Skipping empty HTML for discovered URL`, {
        url: fetched.url,
        index: i,
      }, correlationId);
      continue;
    }
    try {
      const page = await parsePageWithLLM(
        fetched.url,
        fetched.html,
        correlationId,
      );
      parsedDiscovered.push({
        url: fetched.url,
        page: sanitizeParsedPage(page),
      });
      logInfo(`Parsed discovered page`, {
        url: fetched.url,
        index: i,
        title: page.title,
        logo_count: page.logos.length,
        address_count: page.addresses.length,
      }, correlationId);
    } catch (error) {
      logWarning(`Failed to parse discovered page`, {
        url: fetched.url,
        index: i,
        error: getErrorMessage(error),
      }, correlationId);
    }
  }
  // Check if more pages need parsing
  const nextIndex = endIndex;
  const hasMorePages = nextIndex < progress.total_pages;
  if (hasMorePages) {
    // Stay in parse-discovered stage, update progress
    await updateJobStage(job, "parse-discovered", {
      ...stageData,
      parsed_discovered: parsedDiscovered,
      parse_progress: {
        next_index: nextIndex,
        total_pages: progress.total_pages,
      },
    }, correlationId);
    logInfo("Parse-discovered batch complete, more pages pending", {
      job_id: job.id,
      parsed_count: parsedDiscovered.length,
      next_index: nextIndex,
      total_pages: progress.total_pages,
    }, correlationId);
    return {
      nextStage: "parse-discovered",
    };
  } else {
    // All pages parsed, advance to aggregate-evidence - drop raw HTML blobs no longer needed
    const {
      parse_progress: _,
      fetched_discovered: _fd,
      fetched_pages: _fp,
      ...stageDataWithoutProgress
    } = stageData;
    await updateJobStage(job, "aggregate-evidence", {
      ...stageDataWithoutProgress,
      parsed_discovered: parsedDiscovered,
    }, correlationId);
    logInfo(
      "Parse-discovered stage completed, advanced to aggregate-evidence",
      {
        job_id: job.id,
        parsed_count: parsedDiscovered.length,
        total_pages: progress.total_pages,
      },
      correlationId,
    );
    return {
      nextStage: "aggregate-evidence",
    };
  }
}
async function processAggregateEvidenceStage(job, correlationId) {
  logInfo("Processing aggregate-evidence stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const {
    triage,
    cluster,
    parsed_pages: parsedPages,
    parsed_discovered: parsedDiscovered,
    candidate_urls: urls,
    discovered_urls: discoveredUrls,
    candidate_context: candidateContext,
  } = stageData;
  // Combine all pages
  const allPages = [
    ...parsedPages.map((p) => p.page),
    ...parsedDiscovered.map((p) => p.page),
  ];
  // Aggregate data
  const allLogos = [];
  const allAddresses = [];
  const allNames = [];
  const allJsonLd = [];
  for (const page of allPages) {
    allLogos.push(...page.logos);
    allAddresses.push(...page.addresses);
    allNames.push(...page.names);
    allJsonLd.push(...page.jsonLd);
  }
  const evidenceBundle = {
    urls: uniqueStrings([
      ...urls,
      ...(discoveredUrls ?? []),
    ]),
    pages: allPages,
    jsonLd: allJsonLd,
    logos: uniqueStrings(allLogos),
    addresses: uniqueStrings(allAddresses),
    names: uniqueStrings(allNames),
    candidate_context: candidateContext ?? null,
  };
  logInfo("Evidence aggregated", {
    job_id: job.id,
    total_pages: allPages.length,
    logo_count: evidenceBundle.logos.length,
    address_count: evidenceBundle.addresses.length,
  }, correlationId);
  // Advance to summary stage
  await updateJobStage(job, "summary", {
    triage,
    cluster,
    candidate_context: candidateContext ?? null,
    urls: evidenceBundle.urls,
    evidence_bundle: evidenceBundle,
  }, correlationId);
  logInfo("Aggregate-evidence stage completed, advanced to summary", {
    job_id: job.id,
    url_count: evidenceBundle.urls.length,
    page_count: evidenceBundle.pages.length,
  }, correlationId);
  return {
    nextStage: "summary",
  };
}
async function processSummaryStage(job, correlationId) {
  logInfo("Processing summary stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  // Load stage data from evidence
  const stageData = job.stage_data;
  const {
    triage,
    urls,
    evidence_bundle: evidenceBundle,
    cluster,
    candidate_context: candidateContext,
  } = stageData;
  const reenrichment = stageData.reenrichment ?? null;
  // Run Terra summarization
  const evidenceSummary = await summarizeEvidenceWithTerra(
    evidenceBundle,
    triage,
    correlationId,
    undefined,
    reenrichment,
  );
  // Advance to extract stage - pass cluster through
  await updateJobStage(job, "extract", {
    triage,
    evidence_summary: evidenceSummary,
    evidence_bundle_urls: urls,
    cluster,
    candidate_context: candidateContext ?? null,
  }, correlationId);
  logInfo("Summary stage completed, advanced to extract", {
    job_id: job.id,
    website: evidenceSummary.website,
    logo_count: evidenceSummary.logos.length,
    address_count: evidenceSummary.addresses.length,
  }, correlationId);
  return {
    nextStage: "extract",
  };
}
async function processExtractStage(job, correlationId) {
  logInfo("Processing extract stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  // Load stage data from summary
  const stageData = job.stage_data;
  const {
    triage,
    evidence_summary,
    evidence_bundle_urls: urls,
    cluster,
    candidate_context: candidateContext,
  } = stageData;
  const reenrichment = stageData.reenrichment ?? null;
  // Run GPT extraction
  const extraction = await extractWithOpenAI(
    evidence_summary,
    triage,
    correlationId,
    reenrichment,
    candidateContext ?? null,
  );
  // Advance to validate stage - pass cluster through
  await updateJobStage(job, "validate", {
    triage,
    evidence_summary,
    extraction,
    urls,
    cluster,
    candidate_context: candidateContext ?? null,
  }, correlationId);
  logInfo("Extract stage completed, advanced to validate", {
    job_id: job.id,
    confidence: extraction.confidence,
    proposed_name: extraction.proposed.roaster_name,
  }, correlationId);
  return {
    nextStage: "validate",
  };
}
async function translateLocationToEnglish(city, country, correlationId) {
  if (!city && !country) {
    return {
      city: null,
      country: null,
    };
  }
  logInfo("Translating location to English", {
    city,
    country,
  }, correlationId);
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
          model: OPENAI_MODELS.MEDIUM,
          reasoning: {
            effort: "none",
          },
          text: {
            format: {
              type: "json_object",
            },
          },
          input:
            `Translate these location names to English. Return ONLY JSON with keys: {"city": string|null, "country": string|null}
City: ${city || "null"}
Country: ${country || "null"}`,
        }),
      },
      {
        correlationId,
        label: "translate_location",
        timeoutMs: AI_API_TIMEOUT_MS,
      },
    );
    if (!response.ok) {
      logWarning("Location translation failed, using original", {
        city,
        country,
        status: response.status,
      }, correlationId);
      return {
        city,
        country,
      };
    }
    const json = await response.json();
    const outputText = json?.output_text ??
      json?.output?.[0]?.content?.[0]?.text ?? "{}";
    const parsed = parseModelJson(outputText, {});
    const translatedCity = parsed.city ?? city;
    const translatedCountry = parsed.country ?? country;
    logInfo("Location translated", {
      original_city: city,
      translated_city: translatedCity,
      original_country: country,
      translated_country: translatedCountry,
    }, correlationId);
    return {
      city: translatedCity,
      country: translatedCountry,
    };
  } catch (error) {
    logWarning("Location translation error, using original", {
      city,
      country,
      error: getErrorMessage(error),
    }, correlationId);
    return {
      city,
      country,
    };
  }
}
async function processValidateStage(job, correlationId) {
  logInfo("Processing validate stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  // Load stage data from extract
  // Support both new format (with cluster) and legacy format (without cluster)
  const stageData = job.stage_data;
  const {
    triage,
    evidence_summary,
    extraction,
    urls,
    candidate_context: candidateContext,
  } = stageData;
  // Load cluster from stage_data or fetch it (backward compatibility)
  let cluster;
  if (stageData.cluster) {
    cluster = stageData.cluster;
  } else {
    const context = await loadClusterContext(job, correlationId);
    cluster = context.cluster;
  }
  const reenrichment = stageData.reenrichment ?? null;
  let validation = undefined;
  const reasons = validationReasons({ extraction, reenrichment });
  const requiresValidation = reasons.length > 0;
  logInfo("Validation gating decision", {
    job_id: job.id,
    requires_validation: requiresValidation,
    validation_reasons: reasons,
  }, correlationId);
  if (requiresValidation) {
    const searchEvidence = candidateContext?.search_evidence ?? {
      source: "worker_cluster_search_v2",
      results: [],
    };
    validation = await validateWithOpenAI(
      evidence_summary,
      triage,
      extraction,
      searchEvidence,
      correlationId,
      reenrichment,
      candidateContext ?? null,
    );
  }
  logInfo("Validation completed", {
    job_id: job.id,
    required_validation: requiresValidation,
    had_validation: !!validation,
  }, correlationId);
  // Advance to translate-location stage
  await updateJobStage(job, "translate-location", {
    triage,
    evidence_summary,
    extraction,
    urls,
    cluster,
    candidate_context: candidateContext ?? null,
    validation,
    requires_validation: requiresValidation,
    validation_reasons: reasons,
  }, correlationId);
  logInfo("Validate stage completed, advanced to translate-location", {
    job_id: job.id,
    required_validation: requiresValidation,
  }, correlationId);
  return {
    nextStage: "translate-location",
  };
}
async function processTranslateLocationStage(job, correlationId) {
  logInfo("Processing translate-location stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const {
    triage,
    evidence_summary,
    extraction,
    urls,
    cluster,
    candidate_context: candidateContext,
    validation,
    requires_validation,
    validation_reasons: validationReasonsList,
  } = stageData;
  // Determine final proposed fields
  let finalProposed = validation?.proposed ?? {
    ...extraction.proposed,
  };
  // Plan 030: deterministic Instagram/website routing on the final proposed
  // record, merged with the decisions already recorded after the extract and
  // validate stages. A conflict forces needs_review via unresolvedConflicts.
  const routingOutcome = applyInstagramRouting(finalProposed);
  finalProposed = routingOutcome.proposed;
  const instagramRouting = mergeInstagramRoutingRecords([
    extraction.instagram_routing,
    validation?.instagram_routing,
    {
      routed: routingOutcome.routed,
      conflict: routingOutcome.conflict,
      notes: routingOutcome.notes,
    },
  ]);
  const unresolvedConflicts = instagramRouting.conflict
    ? [
      ...(Array.isArray(extraction.conflicts) ? extraction.conflicts : []),
      instagramRouting.conflict,
    ]
    : extraction.conflicts;
  // Translate location to English if needed
  if (finalProposed.city || finalProposed.country) {
    const translation = await translateLocationToEnglish(
      finalProposed.city,
      finalProposed.country,
      correlationId,
    );
    finalProposed.city = translation.city;
    finalProposed.country = translation.country;
  }
  // Determine status and confidence
  const finalConfidence = validation?.confidence ?? extraction.confidence ??
    0.5;
  const status = finalDisposition({
    confidence: finalConfidence,
    validatorNeedsReview: validation?.needs_review,
    unresolvedConflicts,
  });
  logInfo("Location translation completed", {
    job_id: job.id,
    city: finalProposed.city,
    country: finalProposed.country,
    status,
    confidence: finalConfidence,
    instagram_routing: instagramRouting,
  }, correlationId);
  // Advance to find-matches stage. The merged routing record rides on the
  // extraction object because later stages forward extraction verbatim.
  await updateJobStage(job, "find-matches", {
    triage,
    evidence_summary,
    extraction: { ...extraction, instagram_routing: instagramRouting },
    urls,
    cluster,
    candidate_context: candidateContext ?? null,
    validation,
    requires_validation,
    validation_reasons: validationReasonsList,
    final_proposed: finalProposed,
    final_confidence: finalConfidence,
    status,
  }, correlationId);
  logInfo("Translate-location stage completed, advanced to find-matches", {
    job_id: job.id,
    status,
    confidence: finalConfidence,
  }, correlationId);
  return {
    nextStage: "find-matches",
  };
}
async function processFindMatchesStage(job, correlationId) {
  logInfo("Processing find-matches stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const {
    triage,
    evidence_summary,
    extraction,
    urls,
    cluster,
    candidate_context: candidateContext,
    validation,
    requires_validation,
    validation_reasons: validationReasonsList,
    final_proposed,
    final_confidence,
    status,
  } = stageData;
  // Find potential roaster matches. find-matches runs after extract and
  // validate, so the resolved official website is already in stage_data —
  // pass it through as the strongest available duplicate signal.
  const potentialMatches = await findPotentialMatches(
    cluster,
    triage,
    correlationId,
    final_proposed?.roaster_website_url ?? null,
  );
  logInfo("Potential matches found", {
    job_id: job.id,
    match_count: potentialMatches.length,
  }, correlationId);
  // Advance to persist-result stage
  await updateJobStage(job, "persist-result", {
    triage,
    evidence_summary,
    extraction,
    urls,
    cluster,
    candidate_context: candidateContext ?? null,
    validation,
    requires_validation,
    validation_reasons: validationReasonsList,
    final_proposed,
    final_confidence,
    status,
    potential_matches: potentialMatches,
  }, correlationId);
  logInfo("Find-matches stage completed, advanced to persist-result", {
    job_id: job.id,
    match_count: potentialMatches.length,
  }, correlationId);
  return {
    nextStage: "persist-result",
  };
}
async function processPersistResultStage(job, correlationId) {
  logInfo("Processing persist-result stage", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const stageData = job.stage_data;
  const {
    triage,
    extraction,
    urls,
    validation,
    candidate_context: candidateContext,
    validation_reasons: validationReasonsList,
    final_proposed,
    final_confidence,
    status,
    potential_matches,
  } = stageData;
  const reenrichment = stageData.reenrichment ?? null;
  // Plan 030: persist the deterministic Instagram/website routing decisions
  // recorded after the extract, validate, and translate-location stages.
  const instagramRouting = mergeInstagramRoutingRecords([
    extraction.instagram_routing,
    validation?.instagram_routing,
  ]);
  // Build signals object
  const signals = {
    models: {
      triage: triage.model,
      evidence: OPENAI_MODELS.MEDIUM,
      extraction: OPENAI_MODELS.BIG,
      validation: validation ? OPENAI_MODELS.BIG : null,
    },
    triage,
    extraction: {
      conflicts: extraction.conflicts,
      notes: extraction.notes,
    },
    validation: validation
      ? {
        needs_review: validation.needs_review,
        notes: validation.notes,
      }
      : null,
    instagram_routing: instagramRouting,
    validation_reasons: validationReasonsList ?? [],
    candidate_context: candidateContext
      ? {
        evidence_policy_version: EVIDENCE_POLICY_VERSION,
        search_result_count: candidateContext.search_evidence?.results.length ??
          0,
        candidate_count: candidateContext.candidates?.length ?? 0,
        user_contribution_present: !!candidateContext.user_contribution,
      }
      : null,
    reenriched_from: reenrichment
      ? {
        prior_result_id: reenrichment.prior_result_id ?? null,
        rejection_reason: reenrichment.rejection_reason ?? null,
        reviewer_notes_present: !!reenrichment.reviewer_notes,
      }
      : null,
  };
  // Build persisted result
  const persisted = {
    status,
    proposed: final_proposed,
    sources: urls.map((url) => ({
      url,
    })),
    signals,
    confidence: final_confidence,
    error: null,
  };
  // Persist result
  await persistResult(
    job.cluster_id,
    persisted,
    potential_matches,
    correlationId,
  );
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
async function cleanupStuckJobs(correlationId) {
  const stuckThreshold = new Date(
    Date.now() - STUCK_JOB_TIMEOUT_MINUTES * 60 * 1000,
  ).toISOString();
  logInfo("Checking for stuck enrichment jobs", {
    stuck_threshold: stuckThreshold,
    timeout_minutes: STUCK_JOB_TIMEOUT_MINUTES,
  }, correlationId);
  // Find jobs stuck in 'running' state for more than the timeout period
  const { data: stuckJobs, error: fetchError } = await supabase.schema(
    "service",
  ).from("roaster_enrichment_jobs").select(
    "id, cluster_id, locked_at, attempts",
  ).eq("state", "running").lt("locked_at", stuckThreshold);
  if (fetchError) {
    logError(
      "Failed to fetch stuck jobs",
      toError(fetchError),
      ErrorCategory.DATABASE,
      ErrorSeverity.MEDIUM,
      {},
      correlationId,
    );
    return 0;
  }
  if (!stuckJobs || stuckJobs.length === 0) {
    logInfo("No stuck jobs found", {}, correlationId);
    return 0;
  }
  logInfo(`Found ${stuckJobs.length} stuck job(s)`, {
    job_ids: stuckJobs.map((j) => j.id),
  }, correlationId);
  // Treat an external runtime kill like any other failed attempt. Incrementing
  // attempts and applying backoff prevents the oldest poison job from being
  // immediately locked again and starving every newer queued job.
  let recoveredCount = 0;
  for (const job of stuckJobs) {
    const failedAttempt = (job.attempts ?? 0) + 1;
    const retryDelayMinutes = computeRetryDelayMinutes(failedAttempt);
    const permanentlyFailed = failedAttempt >= MAX_JOB_RETRIES ||
      retryDelayMinutes === null;
    const runAfter = permanentlyFailed
      ? null
      : new Date(Date.now() + retryDelayMinutes * 60 * 1000).toISOString();
    const lastError =
      `Auto-recovered: job stuck in running state for >${STUCK_JOB_TIMEOUT_MINUTES} minutes`;
    const { data: updatedJob, error: updateError } = await supabase.schema(
      "service",
    ).from(
      "roaster_enrichment_jobs",
    ).update({
      state: permanentlyFailed ? "failed" : "queued",
      attempts: failedAttempt,
      locked_at: null,
      locked_by: null,
      last_error: lastError,
      ...(runAfter ? { run_after: runAfter } : {}),
    }).eq("id", job.id).eq("state", "running").select("id").maybeSingle();
    if (updateError) {
      logError(
        "Failed to recover stuck job",
        toError(updateError),
        ErrorCategory.DATABASE,
        ErrorSeverity.HIGH,
        {
          job_id: job.id,
          failed_attempt: failedAttempt,
        },
        correlationId,
      );
      continue;
    }
    if (!updatedJob) {
      logWarning("Stuck job changed state before recovery", {
        job_id: job.id,
      }, correlationId);
      continue;
    }
    recoveredCount += 1;
    logWarning(
      permanentlyFailed ? "Stuck job marked as failed" : "Stuck job re-queued",
      {
        job_id: job.id,
        failed_attempt: failedAttempt,
        run_after: runAfter,
      },
      correlationId,
    );
  }
  return recoveredCount;
}
async function loadClusterContext(job, correlationId) {
  logInfo("Loading cluster context", {
    job_id: job.id,
    cluster_id: job.cluster_id,
  }, correlationId);
  const { data: cluster, error: clusterError } = await supabase.schema(
    "service",
  ).from("roaster_candidate_clusters").select("*").eq("id", job.cluster_id)
    .maybeSingle();
  if (clusterError || !cluster) {
    logError(
      "Failed to load cluster",
      clusterError ? toError(clusterError) : new Error("Cluster not found"),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      {
        cluster_id: job.cluster_id,
      },
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
  const { data: candidates, error: candidatesError } = await supabase.schema(
    "service",
  ).from("new_roaster_candidates").select("*").eq("cluster_id", job.cluster_id)
    .order("inserted_at", {
      ascending: false,
    });
  if (candidatesError) {
    logError(
      "Failed to load candidates",
      toError(candidatesError),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      {
        cluster_id: job.cluster_id,
      },
      correlationId,
    );
    throw candidatesError;
  }
  logInfo("Cluster candidates loaded", {
    cluster_id: job.cluster_id,
    candidate_count: (candidates ?? []).length,
  }, correlationId);
  // User-submitted contribution (plan 011): an app user provided the roaster's
  // official website to expedite review. Treat it as a high-confidence identity
  // lead downstream (still subject to verification). Latest one wins.
  const { data: contributionRows, error: contributionError } = await supabase
    .schema("service")
    .from("roaster_candidate_contributions")
    .select(
      "website_url, website_domain, instagram_url, city, country, created_at",
    )
    .eq("cluster_id", job.cluster_id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (contributionError) {
    logWarning("Failed to load roaster contributions", {
      cluster_id: job.cluster_id,
      error: getErrorMessage(contributionError),
    }, correlationId);
  }
  const contribution = contributionRows && contributionRows.length > 0
    ? contributionRows[0]
    : null;
  if (contribution) {
    logInfo("User contribution detected for cluster", {
      cluster_id: job.cluster_id,
      website_domain: contribution.website_domain ?? null,
    }, correlationId);
  }
  const reviewerNotes = typeof job.reviewer_notes === "string"
    ? job.reviewer_notes
    : null;
  const rejectionReason = typeof job.rejection_reason === "string"
    ? job.rejection_reason
    : null;
  const priorResultId = typeof job.prior_result_id === "string"
    ? job.prior_result_id
    : null;
  let priorResult = null;
  if (priorResultId) {
    const { data: explicitPrior, error: explicitPriorError } = await supabase
      .schema("service")
      .from("roaster_enrichment_results")
      .select("id, cluster_id, proposed, confidence, status, updated_at")
      .eq("id", priorResultId)
      .maybeSingle();
    if (explicitPriorError) {
      logWarning("Failed to load explicit prior result", {
        prior_result_id: priorResultId,
        error: getErrorMessage(explicitPriorError),
      }, correlationId);
    } else if (explicitPrior && explicitPrior.cluster_id !== job.cluster_id) {
      logWarning("Prior result cluster mismatch; ignoring", {
        prior_result_id: priorResultId,
        prior_cluster_id: explicitPrior.cluster_id,
        job_cluster_id: job.cluster_id,
      }, correlationId);
    } else if (explicitPrior) {
      priorResult = explicitPrior;
    }
  }
  if (!priorResult) {
    const { data: latestPrior } = await supabase.schema("service").from(
      "roaster_enrichment_results",
    )
      .select("id, cluster_id, proposed, confidence, status, updated_at")
      .eq("cluster_id", job.cluster_id)
      .order("updated_at", {
        ascending: false,
      })
      .limit(1)
      .maybeSingle();
    if (latestPrior) {
      priorResult = latestPrior;
    }
  }
  const reenrichment = (priorResult || reviewerNotes || rejectionReason)
    ? {
      reviewer_notes: reviewerNotes,
      rejection_reason: rejectionReason,
      prior_result_id: priorResult?.id ?? priorResultId ?? null,
      prior_proposed: priorResult?.proposed ?? null,
      prior_confidence: typeof priorResult?.confidence === "number"
        ? priorResult.confidence
        : null,
    }
    : null;
  return {
    cluster: cluster,
    candidates: candidates ?? [],
    priorResult,
    reenrichment,
    contribution,
  };
}
async function buildEvidenceBundle(urls, correlationId) {
  const pages = [];
  const jsonLd = [];
  const logos = [];
  const addresses = [];
  const names = [];
  const discoveredUrls = [];
  const domainCounts = new Map();
  const seenUrls = new Set();
  logInfo("Building evidence bundle", {
    url_count: urls.length,
    urls,
  }, correlationId);
  for (const url of urls) {
    try {
      seenUrls.add(url);
      const baseDomain = extractDomain(url);
      if (baseDomain) {
        domainCounts.set(baseDomain, (domainCounts.get(baseDomain) ?? 0) + 1);
      }
      logInfo("Fetching evidence URL", {
        url,
      }, correlationId);
      const response = await fetchWithRetry(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
        },
      }, {
        maxAttempts: 2,
        correlationId,
        label: "website_fetch",
      });
      if (!response.ok) {
        logWarning("Website fetch failed", {
          url,
          status: response.status,
        }, correlationId);
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
      const internalLinks = extractInternalLinks(url, html).filter((link) => {
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
      logWarning("Website fetch error", {
        url,
        message: getErrorMessage(error),
      }, correlationId);
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
      logInfo("Fetching discovered address page", {
        url,
      }, correlationId);
      const response = await fetchWithRetry(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
        },
      }, {
        maxAttempts: 2,
        correlationId,
        label: "website_fetch",
      });
      if (!response.ok) {
        logWarning("Discovered page fetch failed", {
          url,
          status: response.status,
        }, correlationId);
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
      logWarning("Discovered page fetch error", {
        url,
        message: getErrorMessage(error),
      }, correlationId);
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
    urls: uniqueStrings([
      ...urls,
      ...discoveredUrls,
    ]),
    pages,
    jsonLd,
    logos: uniqueStrings(logos),
    addresses: uniqueStrings(addresses),
    names: uniqueStrings(names),
  };
}
async function callGroqJson(prompt, model, correlationId) {
  logInfo("Groq triage request", {
    model,
    prompt_length: prompt.length,
  }, correlationId);
  const response = await fetchWithRetry(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: {
        type: "json_object",
      },
      temperature: 0.2,
      // Qwen 3 reasons by default; its thinking tokens land in `content` and
      // break json_object enforcement with 400 json_validate_failed. Applied
      // per model because the openai/gpt-oss-120b fallback in
      // GROQ_TRIAGE_MODELS does not accept reasoning_effort.
      ...groqReasoningOverride(model),
    }),
  }, {
    correlationId,
    label: "groq_triage",
    timeoutMs: AI_API_TIMEOUT_MS,
  });
  if (!response.ok) {
    const errorText = await response.text();
    // Retry on transient errors (429/5xx) and on a decommissioned/unavailable
    // model, so the loop cascades to the next GROQ_TRIAGE_MODELS entry. Groq
    // withdraws both deprecated production models and superseded preview IDs,
    // and those failures can be 4xx responses rather than 5xx responses.
    const code = errorText.toLowerCase();
    const modelUnavailable = response.status === 404 ||
      code.includes("decommission") || code.includes("deactiv") ||
      code.includes("model_not_found") || code.includes("does not exist") ||
      code.includes("does_not_exist");
    if (response.status === 429 || response.status >= 500 || modelUnavailable) {
      throw new ProviderRetryableError(
        `Groq retryable error: ${response.status}`,
        response.status,
        errorText,
      );
    }
    throw new Error(`Groq request failed: ${response.status}`);
  }
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content ?? "{}";
  logInfo("Groq triage response received", {
    model,
  }, correlationId);
  return parseModelJson(content, {});
}
async function triageAndNormalize(
  cluster: any,
  candidates: any[],
  correlationId: string,
  reenrichment: any,
) {
  const candidateNames = uniqueStrings(
    candidates.map((candidate) => candidate.roaster).filter(Boolean),
  );
  logInfo("Starting triage and normalization", {
    cluster_id: cluster.id,
    candidate_count: candidates.length,
    candidate_name_count: candidateNames.length,
    reenrichment: !!reenrichment,
  }, correlationId);
  const reenrichmentBlock = buildReenrichmentPromptBlock({
    reviewerNotes: reenrichment?.reviewer_notes ?? null,
    rejectionReason: reenrichment?.rejection_reason ?? null,
    priorProposed: reenrichment?.prior_proposed ?? null,
    priorConfidence: reenrichment?.prior_confidence ?? null,
    includePriorPayload: true,
  });
  const prompt =
    `Normalize the roaster name and detect aliases. Return ONLY JSON with keys:
{"display_name": string|null, "normalized_name": string|null, "aliases": string[], "is_roaster": boolean|null, "confidence": number|null, "notes": string|null}.
At this stage, use only the raw candidate names. Do not infer identity, aliases, domains, or location from name similarity alone.
Cluster display name: ${cluster.display_name ?? ""}
Candidate names: ${candidateNames.join(" | ")}${reenrichmentBlock}`;
  for (const model of GROQ_TRIAGE_MODELS) {
    try {
      const result = await callGroqJson(prompt, model, correlationId);
      const aliases = safeArray(result.aliases).filter((value) =>
        typeof value === "string"
      );
      logInfo("Triage completed", {
        cluster_id: cluster.id,
        model,
        confidence: typeof result.confidence === "number"
          ? result.confidence
          : null,
        aliases_count: aliases.length,
        display_name: typeof result.display_name === "string"
          ? result.display_name
          : cluster.display_name,
      }, correlationId);
      return {
        display_name: typeof result.display_name === "string"
          ? result.display_name
          : cluster.display_name,
        normalized_name: typeof result.normalized_name === "string"
          ? result.normalized_name
          : cluster.normalized_name,
        aliases,
        is_roaster: typeof result.is_roaster === "boolean"
          ? result.is_roaster
          : null,
        confidence: typeof result.confidence === "number"
          ? result.confidence
          : null,
        notes: typeof result.notes === "string" ? result.notes : null,
        model,
      };
    } catch (error) {
      if (error instanceof ProviderRetryableError) {
        logWarning("Groq triage fallback", {
          model,
          status: error.status,
          body: error.body?.slice(0, 300) ?? null,
        }, correlationId);
        continue;
      }
      throw error;
    }
  }
  throw new Error("All Groq triage models failed");
}
async function summarizeEvidenceWithTerra(
  bundle: any,
  triage: any,
  correlationId: string,
  jobDeadline: number | null | undefined,
  reenrichment: any,
) {
  // Helper to check deadline if provided
  const isNearDeadline = (bufferMs = 10000) =>
    jobDeadline ? Date.now() + bufferMs > jobDeadline : false;
  const summaryStartTime = Date.now();
  logInfo("Summarizing evidence with OpenAI", {
    model: OPENAI_MODELS.MEDIUM,
    url_count: bundle.urls.length,
    page_count: bundle.pages.length,
    reenrichment: !!reenrichment,
  }, correlationId);
  // Summary stage focuses on faithfully summarizing evidence; we pass the
  // reviewer's reason/notes so the model can flag relevant evidence, but we
  // deliberately do NOT include the prior proposed payload here to avoid
  // contaminating the evidence summary.
  const reenrichmentBlock = buildReenrichmentPromptBlock({
    reviewerNotes: reenrichment?.reviewer_notes ?? null,
    rejectionReason: reenrichment?.rejection_reason ?? null,
    priorProposed: null,
    priorConfidence: null,
    includePriorPayload: false,
  });
  const boundedEvidence = boundEvidencePayload({
    urls: bundle.urls,
    pages: bundle.pages,
    candidate_context: bundle.candidate_context ?? null,
  });
  if (boundedEvidence.truncated) {
    logWarning("Evidence payload truncated for OpenAI summary prompt", {
      original_chars: boundedEvidence.originalChars,
      final_chars: boundedEvidence.finalChars,
      page_count: boundedEvidence.payload.pages.length,
    }, correlationId);
  }
  // Static instruction/schema block first (byte-identical every call, so
  // provider prefix caching applies), then all dynamic JSON, with the
  // reenrichment block appended last.
  const prompt = `${SUMMARY_PROMPT_STATIC}

Triage: ${
    JSON.stringify({
      display_name: triage.display_name,
      aliases: triage.aliases,
    })
  }
Evidence: ${JSON.stringify(boundedEvidence.payload)}${reenrichmentBlock}`;
  const response = await fetchWithRetry(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODELS.MEDIUM,
      reasoning: {
        effort: "none",
      },
      text: {
        format: EVIDENCE_SUMMARY_FORMAT,
      },
      input: prompt,
    }),
  }, {
    correlationId,
    label: "openai_evidence_summary",
    timeoutMs: AI_API_TIMEOUT_MS,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI summary request failed: ${response.status} ${body}`,
    );
  }
  const json = await response.json();
  const content = extractOpenAiOutputText(json);
  const parsed = parseModelJson(content, {
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
  const logos = safeArray(parsed.logos);
  const addresses = safeArray(parsed.addresses);
  const socials = safeArray(parsed.socials);
  const roasterName = triage.display_name || triage.normalized_name || "";
  const rankedLogos = rankLogoCandidates(
    filterLogosByExtension(uniqueStrings(logos)),
    roasterName,
    parsed.website ?? null,
  );
  // Verify logo candidates with GPT before returning (limit to prevent timeouts).
  // Prefer a single batched call; fall back to per-logo calls if the batch
  // is unavailable or unparsable.
  const verifiedLogos: string[] = [];
  const logosToVerify = rankedLogos.slice(0, MAX_LOGOS_TO_VERIFY);
  if (rankedLogos.length > MAX_LOGOS_TO_VERIFY) {
    logInfo("Limiting logo verification to prevent timeout", {
      total_logos: rankedLogos.length,
      verifying: MAX_LOGOS_TO_VERIFY,
    }, correlationId);
  }
  const recordLogoVerification = (
    logoUrl: string,
    verification: { isLogo: boolean; confidence: number; reason: string },
  ) => {
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
  };
  if (logosToVerify.length > 0) {
    if (isNearDeadline(20000)) {
      logWarning(
        "Skipping all logo verification due to deadline",
        { logo_count: logosToVerify.length },
        correlationId,
      );
    } else {
      const batchResults = await verifyLogosBatchWithOpenAI(
        logosToVerify,
        roasterName,
        correlationId,
      );
      if (batchResults) {
        for (let i = 0; i < logosToVerify.length; i += 1) {
          recordLogoVerification(logosToVerify[i], batchResults[i]);
        }
      } else {
        logWarning(
          "Batched logo verification unavailable, falling back to per-logo verification",
          { logo_count: logosToVerify.length },
          correlationId,
        );
        for (const logoUrl of logosToVerify) {
          // Skip logo verification if running low on time
          if (isNearDeadline(15000)) {
            logWarning(
              "Skipping remaining logo verification due to deadline",
              {},
              correlationId,
            );
            break;
          }
          const verification = await verifyLogoWithOpenAI(
            logoUrl,
            roasterName,
            correlationId,
          );
          recordLogoVerification(logoUrl, verification);
        }
      }
    }
  }
  // Add fallback note if no logos passed verification
  let notes = parsed.notes;
  if (verifiedLogos.length === 0 && logos.length > 0) {
    logWarning("No verified logos found", {
      original_logo_count: rankedLogos.length,
      roaster_name: roasterName,
    }, correlationId);
    notes =
      `No verified logo found. ${rankedLogos.length} candidates rejected. ${
        notes ?? ""
      }`;
  }
  const summaryDuration = Date.now() - summaryStartTime;
  logInfo("Evidence summary generated", {
    model: OPENAI_MODELS.MEDIUM,
    duration_ms: summaryDuration,
    website: parsed.website ?? null,
    logo_count: verifiedLogos.length,
    address_count: addresses.length,
    socials_count: socials.length,
    original_logos_count: rankedLogos.length,
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
    sources: uniqueStrings([
      ...parsed.sources ?? [],
      ...bundle.urls,
    ]),
    notes,
  };
}
async function extractWithOpenAI(
  summary: any,
  triage: any,
  correlationId: string,
  reenrichment: any,
  candidateContext: any,
) {
  logInfo("Starting GPT extraction", {
    website: summary.website,
    logo_count: summary.logos.length,
    address_count: summary.addresses.length,
    source_count: summary.sources.length,
    model: OPENAI_MODELS.BIG,
    reenrichment: !!reenrichment,
  }, correlationId);
  const reenrichmentBlock = buildReenrichmentPromptBlock({
    reviewerNotes: reenrichment?.reviewer_notes ?? null,
    rejectionReason: reenrichment?.rejection_reason ?? null,
    priorProposed: reenrichment?.prior_proposed ?? null,
    priorConfidence: reenrichment?.prior_confidence ?? null,
    includePriorPayload: true,
  });
  // Static instruction/schema block first (byte-identical every call, so
  // provider prefix caching applies), then all dynamic JSON, with the
  // reenrichment block appended last.
  const prompt = `${EXTRACT_PROMPT_STATIC}

Evidence summary: ${JSON.stringify(summary)}
Candidate context from check-new-roaster: ${
    candidateContext ? JSON.stringify(candidateContext) : "null"
  }
Triage: ${JSON.stringify(triage)}${reenrichmentBlock}`;
  const requestBody = {
    model: OPENAI_MODELS.BIG,
    reasoning: {
      effort: "none",
    },
    text: {
      format: {
        type: "json_object",
      },
    },
    input: prompt,
  };
  const response = await fetchWithRetry(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  }, {
    correlationId,
    label: "gpt_extract",
    timeoutMs: OPENAI_EXTRACT_TIMEOUT_MS,
  });
  if (!response.ok) {
    const body = await response.text();
    logWarning("GPT extraction HTTP error", {
      status: response.status,
      body: body.slice(0, 500),
      model: OPENAI_MODELS.BIG,
    }, correlationId);
    throw new Error(`GPT extraction failed: ${response.status} ${body}`);
  }
  const json = await response.json();
  const outputText = extractOpenAiOutputText(json);
  const parsed = parseModelJson(outputText, {
    proposed: {
      roaster_name: null,
      aliases: [],
      roaster_website_url: null,
      instagram_url: null,
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
  const aliases = safeArray(parsed.proposed?.aliases);
  const conflicts = safeArray(parsed.conflicts);
  logInfo("GPT extraction completed", {
    confidence: typeof parsed.confidence === "number"
      ? parsed.confidence
      : null,
    conflicts_count: conflicts.length,
    proposed_name: parsed.proposed?.roaster_name ?? null,
    proposed_country: parsed.proposed?.country ?? null,
    proposed_website: parsed.proposed?.roaster_website_url ?? null,
    proposed_instagram: parsed.proposed?.instagram_url ?? null,
  }, correlationId);
  // Plan 030: deterministic Instagram/website routing after the model stage.
  // A conflicting pair escalates through extraction.conflicts so the job can
  // never complete cleanly (finalDisposition treats conflicts as unresolved).
  const routingOutcome = applyInstagramRouting({
    roaster_name: parsed.proposed?.roaster_name ?? null,
    aliases,
    roaster_website_url: parsed.proposed?.roaster_website_url ?? null,
    instagram_url: parsed.proposed?.instagram_url ?? null,
    roaster_logo_url: parsed.proposed?.roaster_logo_url ?? null,
    city: parsed.proposed?.city ?? null,
    state: parsed.proposed?.state ?? null,
    country: parsed.proposed?.country ?? null,
    address: parsed.proposed?.address ?? null,
    is_roaster: typeof parsed.proposed?.is_roaster === "boolean"
      ? parsed.proposed.is_roaster
      : null,
  });
  const resultConflicts = routingOutcome.conflict
    ? [...conflicts, routingOutcome.conflict]
    : conflicts;
  const resultNotes = routingOutcome.notes.length > 0
    ? parsed.notes
      ? `${parsed.notes} ${routingOutcome.notes.join(" ")}`
      : routingOutcome.notes.join(" ")
    : parsed.notes ?? null;
  return {
    proposed: routingOutcome.proposed,
    instagram_routing: {
      routed: routingOutcome.routed,
      conflict: routingOutcome.conflict,
      notes: routingOutcome.notes,
    },
    confidence: typeof parsed.confidence === "number"
      ? parsed.confidence
      : null,
    conflicts: resultConflicts,
    notes: resultNotes,
  };
}
async function validateWithOpenAI(
  summary: any,
  triage: any,
  extraction: any,
  searchEvidence: any,
  correlationId: string,
  reenrichment: any,
  candidateContext: any,
) {
  logInfo("Starting OpenAI validation", {
    extraction_confidence: extraction.confidence ?? null,
    conflict_count: extraction.conflicts.length,
    search_result_count: searchEvidence?.results.length ?? 0,
    search_source: searchEvidence?.source ?? null,
    reenrichment: !!reenrichment,
  }, correlationId);
  const reenrichmentBlock = buildReenrichmentPromptBlock({
    reviewerNotes: reenrichment?.reviewer_notes ?? null,
    rejectionReason: reenrichment?.rejection_reason ?? null,
    priorProposed: reenrichment?.prior_proposed ?? null,
    priorConfidence: reenrichment?.prior_confidence ?? null,
    includePriorPayload: true,
  });
  // Static instruction/schema block first (byte-identical every call, so
  // provider prefix caching applies), then all dynamic JSON, with the
  // reenrichment block appended last.
  const prompt = `${VALIDATE_PROMPT_STATIC}

Evidence summary: ${JSON.stringify(summary)}
Triage: ${JSON.stringify(triage)}
Search evidence: ${searchEvidence ? JSON.stringify(searchEvidence) : "null"}
Candidate context from check-new-roaster: ${
    candidateContext ? JSON.stringify(candidateContext) : "null"
  }
Proposed: ${JSON.stringify(extraction)}.${reenrichmentBlock}`;
  const response = await fetchWithRetry(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODELS.BIG,
      reasoning: {
        effort: "none",
      },
      text: {
        format: {
          type: "json_object",
        },
      },
      input: prompt,
    }),
  }, {
    correlationId,
    label: "openai_validate",
    timeoutMs: OPENAI_VALIDATE_TIMEOUT_MS,
  });
  if (!response.ok) {
    const body = await response.text();
    logWarning("OpenAI validation HTTP error", {
      status: response.status,
      body: body.slice(0, 500),
      model: OPENAI_MODELS.BIG,
    }, correlationId);
    throw new Error(`OpenAI validation failed: ${response.status} ${body}`);
  }
  const json = await response.json();
  const outputItems = safeArray(json?.output);
  const contentItems = outputItems.flatMap((item) => safeArray(item?.content));
  const outputText = json?.output_text ??
    contentItems.find((content) =>
      content?.type === "output_text" && typeof content.text === "string"
    )?.text ??
    contentItems.find((content) => typeof content?.text === "string")?.text ??
    "{}";
  const parsed = parseModelJson(outputText, {
    proposed: extraction.proposed,
    confidence: extraction.confidence ?? null,
    needs_review: true,
    notes: null,
  });
  logInfo("OpenAI validation completed", {
    confidence: typeof parsed.confidence === "number"
      ? parsed.confidence
      : null,
    needs_review: typeof parsed.needs_review === "boolean"
      ? parsed.needs_review
      : true,
  }, correlationId);
  // Plan 030: deterministic Instagram/website routing after the model stage.
  // A conflicting pair forces needs_review so the job is never completed.
  const routingOutcome = applyInstagramRouting({
    roaster_name: parsed.proposed?.roaster_name ?? null,
    aliases: safeArray(parsed.proposed?.aliases),
    roaster_website_url: parsed.proposed?.roaster_website_url ?? null,
    instagram_url: parsed.proposed?.instagram_url ?? null,
    roaster_logo_url: parsed.proposed?.roaster_logo_url ?? null,
    city: parsed.proposed?.city ?? null,
    state: parsed.proposed?.state ?? null,
    country: parsed.proposed?.country ?? null,
    address: parsed.proposed?.address ?? null,
    is_roaster: typeof parsed.proposed?.is_roaster === "boolean"
      ? parsed.proposed.is_roaster
      : null,
  });
  const resultNotes = routingOutcome.notes.length > 0
    ? parsed.notes
      ? `${parsed.notes} ${routingOutcome.notes.join(" ")}`
      : routingOutcome.notes.join(" ")
    : parsed.notes ?? null;
  return {
    proposed: routingOutcome.proposed,
    instagram_routing: {
      routed: routingOutcome.routed,
      conflict: routingOutcome.conflict,
      notes: routingOutcome.notes,
    },
    confidence: typeof parsed.confidence === "number"
      ? parsed.confidence
      : null,
    needs_review: routingOutcome.conflict
      ? true
      : typeof parsed.needs_review === "boolean"
      ? parsed.needs_review
      : true,
    notes: resultNotes,
  };
}
function computeRetryDelayMinutes(attempts) {
  const index = Math.max(0, attempts - 1);
  return RETRY_BACKOFF_MINUTES[index] ?? null;
}
async function findPotentialMatches(
  cluster,
  triage,
  correlationId,
  websiteUrl: string | null = null,
) {
  logInfo("Finding potential roaster matches for admin review", {
    cluster_id: cluster.id,
    normalized_name: cluster.normalized_name,
    display_name: triage.display_name,
    has_website: !!websiteUrl,
  }, correlationId);
  try {
    // Add timeout to RPC call using Promise.race
    // search_website_url is the enrichment-resolved official URL. Name
    // matching alone cannot connect a cluster like "Southern Weather" (a
    // coffee blend a user entered as the roaster) to Onyx Coffee Lab, but
    // both resolve to onyxcoffeelab.com.
    const rpcPromise = supabase.rpc("find_potential_roaster_matches", {
      search_normalized_name: cluster.normalized_name,
      search_display_name: triage.display_name || cluster.display_name || "",
      max_results: 3,
      min_confidence: 0.65,
      search_website_url: websiteUrl,
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("RPC timeout")), RPC_TIMEOUT_MS)
    );
    const { data: matches, error } = await Promise.race([
      rpcPromise,
      timeoutPromise,
    ]) as any;
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
    const potentialMatches = (matches || []).map((m) => ({
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
  clusterId,
  payload,
  potentialMatches,
  correlationId,
) {
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
  const { error } = await supabase.schema("service").from(
    "roaster_enrichment_results",
  ).insert({
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
    logError(
      "Failed to persist enrichment result",
      toError(error),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      {
        cluster_id: clusterId,
      },
      correlationId,
    );
    throw error;
  }
  logInfo("Enrichment result persisted", {
    cluster_id: clusterId,
    status: payload.status,
    potential_match_count: potentialMatches.length,
  }, correlationId);
}
async function processJob(job, correlationId) {
  logInfo("Processing enrichment job", {
    job_id: job.id,
    cluster_id: job.cluster_id,
    stage: job.stage,
    attempts: job.attempts,
  }, correlationId);
  if (shouldRestartForPolicyV2(job)) {
    logWarning(
      "Restarting legacy active job at triage for evidence policy v2",
      {
        job_id: job.id,
        previous_stage: job.stage,
        reason: "missing_evidence_policy_v2",
      },
      correlationId,
    );
    await updateJobStage(job, "triage", {
      policy_v2_restart_applied: true,
      reenrichment: job.stage_data?.reenrichment ?? null,
    }, correlationId);
    return { status: "in_progress" };
  }
  // Stage router - dispatch to appropriate stage handler
  const stageHandlers = {
    triage: processTriageStage,
    "search-candidates": processSearchCandidatesStage,
    // Legacy evidence stage (for backwards compatibility with existing jobs)
    evidence: processEvidenceStage,
    // New micro-stages for evidence collection
    "fetch-candidates": processFetchCandidatesStage,
    "parse-candidates": processParseCandidatesStage,
    "discover-links": processDiscoverLinksStage,
    "fetch-discovered": processFetchDiscoveredStage,
    "parse-discovered": processParseDiscoveredStage,
    "aggregate-evidence": processAggregateEvidenceStage,
    summary: processSummaryStage,
    extract: processExtractStage,
    // Validate micro-stages (split from monolithic validate stage)
    validate: processValidateStage,
    "translate-location": processTranslateLocationStage,
    "find-matches": processFindMatchesStage,
    "persist-result": processPersistResultStage,
  };
  const handler = stageHandlers[job.stage];
  if (!handler) {
    throw new Error(`Unknown stage: ${job.stage}`);
  }
  const result = await handler(job, correlationId);
  // If handler returns nextStage, it means the stage advanced but pipeline isn't complete
  if ("nextStage" in result) {
    logInfo("Pipeline stage completed", {
      job_id: job.id,
      stage: job.stage,
      next_stage: result.nextStage,
    }, correlationId);
    // Return in_progress status - main handler will reset job to queued
    return {
      status: "in_progress",
    };
  }
  // Final stage completed
  return {
    status: "completed",
    result,
  };
}
serve(async (req) => {
  const correlationId = generateCorrelationId();
  const origin = req.headers.get("origin") ?? undefined;
  const cors = getCorsHeaders(origin);
  let activeJob = null;
  logInfo("Roaster enrichment worker invoked", {
    method: req.method,
    url: req.url,
    origin: origin ?? null,
    user_agent: req.headers.get("user-agent") ?? "unknown",
  }, correlationId);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors,
    });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        error: "Method Not Allowed",
      }),
      {
        status: 405,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      },
    );
  }
  const systemTokenHeader = req.headers.get("x-system-token");
  if (systemTokenHeader !== cronJobSecret) {
    logWarning("Unauthorized cron job access", {
      function: FUNCTION_NAME,
      user_agent: req.headers.get("user-agent") ?? "unknown",
    }, correlationId);
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
      }),
      {
        status: 403,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      },
    );
  }
  logInfo("Authorized cron request", {
    function: FUNCTION_NAME,
  }, correlationId);
  try {
    // Clean up any jobs stuck in 'running' state before processing new jobs
    const cleanedCount = await cleanupStuckJobs(correlationId);
    if (cleanedCount > 0) {
      logInfo("Stuck job cleanup completed", {
        cleaned_count: cleanedCount,
      }, correlationId);
    }
    activeJob = await lockNextJob(correlationId);
    if (!activeJob) {
      logInfo("No queued jobs to process", {}, correlationId);
      return new Response(
        JSON.stringify({
          success: true,
          message: "No queued jobs",
        }),
        {
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        },
      );
    }
    logInfo("Enrichment job started", {
      job_id: activeJob.id,
      cluster_id: activeJob.cluster_id,
    }, correlationId);
    const processResult = await processJob(activeJob, correlationId);
    if (processResult.status === "completed" && processResult.result) {
      // Final stage completed; clear lock and failure retry state.
      await updateJobState(activeJob.id, "done", null, correlationId, {
        attempts: 0,
        locked_at: null,
        locked_by: null,
      });
      logInfo("Enrichment job completed", {
        job_id: activeJob.id,
        status: processResult.result.status,
      }, correlationId);
      return new Response(
        JSON.stringify({
          success: true,
          job_id: activeJob.id,
          status: processResult.result.status,
          confidence: processResult.result.confidence,
        }),
        {
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        },
      );
    } else {
      // Job is still in progress. Reset failure retry state because this stage
      // completed successfully; the next stage gets its own retry budget.
      await supabase.schema("service").from("roaster_enrichment_jobs").update({
        state: "queued",
        locked_at: null,
        locked_by: null,
        run_after: new Date().toISOString(),
        attempts: 0,
        last_error: null,
      }).eq("id", activeJob.id);
      logInfo("Enrichment job stage complete, waiting for next invocation", {
        job_id: activeJob.id,
        stage: activeJob.stage,
      }, correlationId);
      return new Response(
        JSON.stringify({
          success: true,
          job_id: activeJob.id,
          status: "in_progress",
          message:
            `Stage '${activeJob.stage}' complete, next invocation will continue`,
        }),
        {
          headers: {
            ...cors,
            "Content-Type": "application/json",
          },
        },
      );
    }
  } catch (error) {
    const message = getErrorMessage(error);
    logError(
      "Enrichment job failed",
      error instanceof Error ? error : new Error(message),
      ErrorCategory.EXTERNAL_API,
      ErrorSeverity.HIGH,
      {
        job_id: activeJob?.id,
        cluster_id: activeJob?.cluster_id,
        message,
      },
      correlationId,
    );
    if (activeJob) {
      const failedAttempt = (activeJob.attempts ?? 0) + 1;
      if (failedAttempt >= MAX_JOB_RETRIES) {
        await updateJobState(activeJob.id, "failed", message, correlationId, {
          attempts: failedAttempt,
          locked_at: null,
          locked_by: null,
        });
        try {
          await persistResult(
            activeJob.cluster_id,
            {
              status: "failed",
              proposed: {
                roaster_name: null,
                aliases: [],
                roaster_website_url: null,
                instagram_url: null,
                roaster_logo_url: null,
                city: null,
                state: null,
                country: null,
                address: null,
                is_roaster: null,
              },
              sources: [],
              signals: {
                error: message,
              },
              confidence: 0,
              error: message,
            },
            [],
            correlationId,
          );
        } catch (persistError) {
          logWarning("Failed to persist failed result", {
            job_id: activeJob.id,
            message: getErrorMessage(persistError),
          }, correlationId);
        }
      } else {
        const delayMinutes = computeRetryDelayMinutes(failedAttempt);
        if (delayMinutes !== null) {
          const runAfter = new Date(Date.now() + delayMinutes * 60 * 1000)
            .toISOString();
          const { error: retryError } = await supabase.schema("service").from(
            "roaster_enrichment_jobs",
          ).update({
            state: "queued",
            run_after: runAfter,
            locked_at: null,
            locked_by: null,
            last_error: message,
            attempts: failedAttempt,
          }).eq("id", activeJob.id);
          if (retryError) {
            logError(
              "Failed to re-queue enrichment job",
              toError(retryError),
              ErrorCategory.DATABASE,
              ErrorSeverity.HIGH,
              {
                job_id: activeJob.id,
                run_after: runAfter,
              },
              correlationId,
            );
          } else {
            logWarning("Enrichment job re-queued after failure", {
              job_id: activeJob.id,
              attempt: failedAttempt,
              run_after: runAfter,
              delay_minutes: delayMinutes,
            }, correlationId);
          }
        } else {
          logWarning("Retry delay not configured for attempt", {
            job_id: activeJob.id,
            attempt: failedAttempt,
          }, correlationId);
        }
      }
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: message,
        job_id: activeJob?.id ?? null,
      }),
      {
        status: 500,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      },
    );
  } finally {
    flushLogsOnExit();
  }
});
