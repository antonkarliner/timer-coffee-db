/**
 * Client for TypeSafe AI's "Jev" decision model (POST /v1/systemone).
 *
 * Jev is not a generative model: the caller sends shared state plus typed
 * questions (noul = yes/no, choice, score) and receives typed answers with
 * calibrated probabilities under the caller's own question keys. It never
 * emits free text, which makes it a cheap, structured replacement for
 * classification-shaped decisions that would otherwise cost a generative
 * model call.
 *
 * Design constraints, and why:
 * - ONE batched entry point (`jevAsk`). The API evaluates every question in
 *   a request in parallel against one shared state, so a single request per
 *   decision set is both the cheapest and the simplest shape. The
 *   `jevChoose` / `jevNoul` / `jevScore` wrappers delegate to `jevAsk`; none
 *   of them opens its own request path.
 * - `jevAsk` NEVER throws and returns `null` on any failure (missing key,
 *   timeout, non-2xx, unparseable or contract-violating body). Callers fall
 *   back to their existing non-Jev path, so a Jev outage must be invisible
 *   to app users. Every failure logs the stable marker `jev_fallback` so
 *   fallback frequency can be counted in production logs.
 * - No npm SDK dependency: a single fetch is enough, and the vendor SDK's
 *   built-in retry policy conflicts with our abort budget.
 *
 * This file does not talk to OpenAI; the model id comes from
 * `ai-models.ts` like every other provider.
 */

import { JEV_MODEL } from "./ai-models.ts";
import { fetchWithTimeout } from "./fetch-with-timeout.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  logError,
  logInfo,
} from "./monitoring.ts";
import type { Json } from "./types.ts";

/** Single exported endpoint constant; the only place the URL is written. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Reserved choice option key for "none of the above". Callers must not use
 * it for their own options; `withNoneOfTheAbove` appends it with a real
 * description so thresholds can be applied against it downstream.
 */
export const JEV_NONE_OPTION_KEY = "__none__";

/** Default description for the reserved none-of-the-above option. */
export const DEFAULT_JEV_NONE_DESCRIPTION =
  "None of the listed options applies to the state described.";

/** User-facing calls must fit inside an interactive request budget. */
const DEFAULT_TIMEOUT_MS = 800;

/** Vendor contract: a choice question accepts at most 255 options. */
const MAX_CHOICE_OPTIONS = 255;

/** Retries are opt-in only (see `JevAskOptions.maxRetries`). */
const DEFAULT_MAX_RETRIES = 0;
const MAX_ALLOWED_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

/**
 * Text fields on the wire (`state`, `instructions`) accept a plain string, a
 * structured object, or an array of strings, so the shared JSON type covers
 * them exactly.
 */
export type JevInstructions = Json;

/** Yes/no question. `criteria` optionally describes what true/false mean. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: JevInstructions;
  criteria?: { true: string; false: string };
}

/**
 * Single-select question. `criteria` maps option key -> rubric description
 * (null when the key is self-describing). 1..255 options.
 */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevInstructions;
  criteria: Record<string, string | null>;
}

/**
 * Rubric question. `criteria` is an ORDERED array of at least two level
 * descriptions — it is a legend, not a numeric range.
 */
export interface JevScoreQuestion {
  type: "score";
  instructions: JevInstructions;
  criteria: string[];
}

export type JevQuestion =
  | JevNoulQuestion
  | JevChoiceQuestion
  | JevScoreQuestion;

/**
 * Yes/no answer. Deliberately has NO `confidence` field — verified on the
 * wire 2026-09-17; the API does not send one, so we must not invent one.
 */
export interface JevNoulAnswer {
  type: "noul";
  /** Calibrated probability of the "yes" answer, 0..1. */
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  /** The winning option key, from the caller's own criteria keys. */
  choice: string;
  probabilities: Record<string, number>;
  /** 0..1, derived from the shape of the probability distribution. */
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  /** Expected score along the rubric; NOT guaranteed to be a level index. */
  score: number;
  /** Level index (as string) -> level description, echoing the rubric. */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  /** Wall-clock time of the whole request including body read. */
  latencyMs: number;
}

export interface JevAskOptions {
  /** Per-attempt deadline, including the response body read. Default 800 ms. */
  timeoutMs?: number;
  /** Passed through to the structured logger for request tracing. */
  correlationId?: string;
  /** Overrides `Deno.env.get("TYPESAFE_API_KEY")`; mainly for tests. */
  apiKey?: string;
  /**
   * Opt-in retries for 429/529 only, for batch/offline callers with generous
   * timeouts. Off by default (0): a retry cannot fit inside a user-facing
   * budget when `timeoutMs` is at or below ~2000 ms. Capped at 3. Each
   * attempt gets its own full `timeoutMs`; the retry delay itself is not
   * covered by the deadline.
   */
  maxRetries?: number;
  /** Delay between opted-in retries. Default 500 ms. */
  retryDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) &&
    Object.values(value).every((v) => typeof v === "string");
}

/**
 * Validate one answer against the wire contract and rebuild it so callers
 * only ever see exactly the documented fields (e.g. a noul answer never
 * gains a `confidence` field, even if the API ever sent one).
 */
function parseAnswer(value: unknown): JevAnswer | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "noul":
      return isFiniteNumber(value.noul)
        ? { type: "noul", noul: value.noul }
        : null;
    case "choice":
      if (typeof value.choice !== "string") return null;
      if (!isNumberRecord(value.probabilities)) return null;
      if (!isFiniteNumber(value.confidence)) return null;
      return {
        type: "choice",
        choice: value.choice,
        probabilities: value.probabilities,
        confidence: value.confidence,
      };
    case "score":
      if (!isFiniteNumber(value.score)) return null;
      if (!isStringRecord(value.legend)) return null;
      if (!isNumberRecord(value.probabilities)) return null;
      if (!isFiniteNumber(value.confidence)) return null;
      return {
        type: "score",
        score: value.score,
        legend: value.legend,
        probabilities: value.probabilities,
        confidence: value.confidence,
      };
    default:
      return null;
  }
}

/**
 * Client-side preflight of the question set, mirroring the vendor contract
 * closely enough to avoid spending a network round trip on a request that
 * can only come back 422. Returns the sanitized wire form, containing only
 * the documented per-type fields.
 */
function toWireQuestions(
  questions: Record<string, JevQuestion>,
): Record<string, unknown> | null {
  const wire: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!isRecord(question)) return null;
    if (question.instructions === undefined) return null;
    switch (question.type) {
      case "noul": {
        const entry: Record<string, unknown> = {
          type: "noul",
          instructions: question.instructions,
        };
        if (question.criteria !== undefined) entry.criteria = question.criteria;
        wire[key] = entry;
        break;
      }
      case "choice": {
        if (!isRecord(question.criteria)) return null;
        const optionCount = Object.keys(question.criteria).length;
        if (optionCount < 1 || optionCount > MAX_CHOICE_OPTIONS) return null;
        wire[key] = {
          type: "choice",
          instructions: question.instructions,
          criteria: question.criteria,
        };
        break;
      }
      case "score": {
        const criteria = question.criteria;
        if (
          !Array.isArray(criteria) || criteria.length < 2 ||
          !criteria.every((level) => typeof level === "string")
        ) {
          return null;
        }
        wire[key] = {
          type: "score",
          instructions: question.instructions,
          criteria,
        };
        break;
      }
      default:
        return null;
    }
  }
  return Object.keys(wire).length > 0 ? wire : null;
}

/**
 * Validate the success body against the contract. Every requested question
 * key must have a well-formed answer; anything half-formed returns null so
 * callers never receive a partially parsed result.
 */
function parseJevResponse(
  body: unknown,
  requestedKeys: string[],
): { answers: Record<string, JevAnswer>; usage: JevUsage } | null {
  if (!isRecord(body) || !isRecord(body.answers)) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const key of requestedKeys) {
    const answer = parseAnswer(body.answers[key]);
    if (answer === null) return null;
    answers[key] = answer;
  }
  if (
    !isRecord(body.usage) ||
    !isFiniteNumber(body.usage.input_tokens) ||
    !isFiniteNumber(body.usage.output_tokens)
  ) {
    return null;
  }
  return {
    answers,
    usage: {
      input_tokens: body.usage.input_tokens,
      output_tokens: body.usage.output_tokens,
    },
  };
}

/**
 * Return a copy of a choice question with the reserved `__none__` option
 * appended, so callers can threshold on an explicit "none of the above"
 * instead of forcing a best-fit choice. The description is a real sentence,
 * not null, per the vendor's guidance. Idempotent, and a no-op when the
 * caller opts out with `{ includeNone: false }`.
 */
export function withNoneOfTheAbove(
  question: JevChoiceQuestion,
  opts?: { includeNone?: boolean; noneDescription?: string },
): JevChoiceQuestion {
  if (opts?.includeNone === false) return question;
  if (question.criteria[JEV_NONE_OPTION_KEY] !== undefined) return question;
  return {
    ...question,
    criteria: {
      ...question.criteria,
      [JEV_NONE_OPTION_KEY]: opts?.noneDescription ??
        DEFAULT_JEV_NONE_DESCRIPTION,
    },
  };
}

/**
 * Ask Jev one batch of typed questions against one shared state.
 *
 * Returns `null` on ANY failure — missing API key, invalid question set,
 * timeout, non-2xx status, unparseable body, or a body that violates the
 * response contract — and never throws. A `null` means "fall back to the
 * caller's non-Jev path"; failures are logged with the `jev_fallback`
 * marker for production counting.
 */
export async function jevAsk(
  state: Json,
  questions: Record<string, JevQuestion>,
  opts: JevAskOptions = {},
): Promise<JevResult | null> {
  const correlationId = opts.correlationId;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nQuestions = Object.keys(questions).length;

  const apiKey = opts.apiKey ?? Deno.env.get("TYPESAFE_API_KEY");
  if (!apiKey) {
    // Absence is a supported state, not an error: every consumer must
    // degrade to its non-Jev path. Log once at info level.
    logInfo(
      "jev_fallback: TYPESAFE_API_KEY is not configured; skipping Jev call",
      {
        marker: "jev_fallback",
        reason: "missing_api_key",
        n_questions: nQuestions,
        correlation_id: correlationId,
      },
      correlationId,
    );
    return null;
  }

  let wireQuestions: Record<string, unknown>;
  let body: string;
  try {
    const sanitized = toWireQuestions(questions);
    if (sanitized === null) {
      logError(
        "jev_fallback: Jev question set failed client-side validation",
        undefined,
        ErrorCategory.VALIDATION,
        ErrorSeverity.LOW,
        {
          marker: "jev_fallback",
          reason: "invalid_questions",
          n_questions: nQuestions,
          correlation_id: correlationId,
        },
        correlationId,
      );
      return null;
    }
    wireQuestions = sanitized;
    body = JSON.stringify({
      state,
      model: JEV_MODEL,
      questions: wireQuestions,
    });
  } catch (error) {
    logError(
      "jev_fallback: failed to serialize Jev request body",
      error instanceof Error ? error : undefined,
      ErrorCategory.VALIDATION,
      ErrorSeverity.LOW,
      {
        marker: "jev_fallback",
        reason: "serialization_failed",
        n_questions: nQuestions,
        correlation_id: correlationId,
      },
      correlationId,
    );
    return null;
  }

  const requestedKeys = Object.keys(wireQuestions);
  const maxRetries = Math.min(
    Math.max(opts.maxRetries ?? DEFAULT_MAX_RETRIES, 0),
    MAX_ALLOWED_RETRIES,
  );
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const startedAt = Date.now();

  for (let attempt = 0;; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        JEV_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        },
        timeoutMs,
      );
    } catch (error) {
      logError(
        "jev_fallback: Jev request failed before a response arrived",
        error instanceof Error ? error : undefined,
        ErrorCategory.NETWORK,
        ErrorSeverity.LOW,
        {
          marker: "jev_fallback",
          reason: "request_failed",
          n_questions: nQuestions,
          attempt,
          correlation_id: correlationId,
        },
        correlationId,
      );
      return null;
    }

    if (!response.ok) {
      const retryableStatus = response.status === 429 ||
        response.status === 529;
      if (retryableStatus && attempt < maxRetries) {
        // Opt-in only (see JevAskOptions.maxRetries): wait and try again.
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      logError(
        `jev_fallback: Jev returned HTTP ${response.status}`,
        undefined,
        retryableStatus ? ErrorCategory.RATE_LIMIT : ErrorCategory.EXTERNAL_API,
        ErrorSeverity.LOW,
        {
          marker: "jev_fallback",
          reason: "http_error",
          status: response.status,
          n_questions: nQuestions,
          attempt,
          correlation_id: correlationId,
        },
        correlationId,
      );
      return null;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch (error) {
      logError(
        "jev_fallback: Jev response body was not valid JSON",
        error instanceof Error ? error : undefined,
        ErrorCategory.EXTERNAL_API,
        ErrorSeverity.LOW,
        {
          marker: "jev_fallback",
          reason: "unparseable_body",
          status: response.status,
          n_questions: nQuestions,
          correlation_id: correlationId,
        },
        correlationId,
      );
      return null;
    }

    const parsed = parseJevResponse(parsedBody, requestedKeys);
    if (parsed === null) {
      logError(
        "jev_fallback: Jev response shape did not match the contract",
        undefined,
        ErrorCategory.EXTERNAL_API,
        ErrorSeverity.LOW,
        {
          marker: "jev_fallback",
          reason: "contract_violation",
          status: response.status,
          n_questions: nQuestions,
          correlation_id: correlationId,
        },
        correlationId,
      );
      return null;
    }

    const latencyMs = Date.now() - startedAt;
    logInfo(
      "jev_ask completed",
      {
        n_questions: nQuestions,
        latency_ms: latencyMs,
        status: response.status,
        input_tokens: parsed.usage.input_tokens,
        correlation_id: correlationId,
      },
      correlationId,
    );
    return { answers: parsed.answers, usage: parsed.usage, latencyMs };
  }
}

/** Single-question wrapper. Delegates to `jevAsk`; never fetches itself. */
export async function jevChoose(
  state: Json,
  question: JevChoiceQuestion,
  opts?: JevAskOptions,
): Promise<JevChoiceAnswer | null> {
  const result = await jevAsk(state, { q: question }, opts);
  const answer = result?.answers.q;
  return answer && answer.type === "choice" ? answer : null;
}

/** Single-question wrapper. Delegates to `jevAsk`; never fetches itself. */
export async function jevNoul(
  state: Json,
  question: JevNoulQuestion,
  opts?: JevAskOptions,
): Promise<JevNoulAnswer | null> {
  const result = await jevAsk(state, { q: question }, opts);
  const answer = result?.answers.q;
  return answer && answer.type === "noul" ? answer : null;
}

/** Single-question wrapper. Delegates to `jevAsk`; never fetches itself. */
export async function jevScore(
  state: Json,
  question: JevScoreQuestion,
  opts?: JevAskOptions,
): Promise<JevScoreAnswer | null> {
  const result = await jevAsk(state, { q: question }, opts);
  const answer = result?.answers.q;
  return answer && answer.type === "score" ? answer : null;
}

/** Pre-warms run alongside other work and must never hold up a request. */
const PREWARM_DEFAULT_TIMEOUT_MS = 3000;

/**
 * Open a keep-alive connection to the TypeSafe origin so the real Jev call
 * later in the same request does not pay DNS + TCP + TLS again (measured:
 * ~654-667 ms from the Supabase edge cold vs ~246 ms warm; plan 034
 * pre-warm experiment). Callers start it at the top of a request and keep
 * the promise without awaiting it.
 *
 * Never billed, never attributable: a bare GET to the origin derived from
 * `JEV_ENDPOINT`, without the API key and without a question. Any HTTP
 * status counts as success — the point is the handshake, not the response —
 * so a 404/405 from the origin is a fine outcome.
 *
 * Returns elapsed milliseconds when any HTTP response arrived, null on
 * network error or timeout. Never throws.
 */
export async function prewarmJevConnection(
  opts?: { timeoutMs?: number },
): Promise<number | null> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(
      new URL(JEV_ENDPOINT).origin,
      // Deliberately no Authorization header and no body: a pre-warm must
      // never be a billable model call.
      { method: "GET" },
      opts?.timeoutMs ?? PREWARM_DEFAULT_TIMEOUT_MS,
    );
    // The body must be read to the end. In Deno an unconsumed body keeps the
    // socket checked out instead of returning it to the keep-alive pool,
    // which would silently defeat the whole experiment. Cancelling is not a
    // safe substitute: over HTTP/2 it resets only this stream, but over
    // HTTP/1.1 it typically closes the connection. api.typesafe.ai answers
    // HTTP/2 today (a 22-byte 404, checked 2026-09-18), yet reading those
    // bytes is free and keeps the connection reusable whichever protocol the
    // runtime negotiates. fetchWithTimeout keeps its deadline alive while the
    // body is read, so a stalled body cannot hang here.
    await response.arrayBuffer();
    return Date.now() - startedAt;
  } catch (error) {
    // Low-level logging only: a failed pre-warm is harmless (the real Jev
    // call just pays the handshake) and must stay invisible to callers.
    logInfo(
      "jev_prewarm: connection pre-warm failed",
      {
        marker: "jev_prewarm",
        reason: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}
