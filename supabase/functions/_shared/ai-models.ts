/**
 * Centralized AI model identifiers shared across edge functions.
 *
 * OpenAI API consumers select a capability tier here. Runtime overrides come
 * from the model environment variables read only by this module; reviewed
 * defaults keep local development and new deployments deterministic.
 */

// Groq default model — currently Qwen 3.8 27B (vision-capable: max 5 images,
// ≤4 MB base64 per request). Used for coffee-label parsing and as the primary
// roaster-enrichment triage model. Groq withdrew the Qwen 3.6 ID, which began
// returning 404 on 2026-09-15; Qwen 3.8 is the current Qwen 3 generation.
export const GROQ_DEFAULT_MODEL = "qwen/qwen3.8-27b";

/**
 * Groq-only sampling override that disables Qwen 3 "thinking".
 *
 * Qwen 3 models reason by default on Groq. The thinking tokens are emitted
 * into `content`, which breaks `response_format: { type: "json_object" }` with
 * a 400 `json_validate_failed`, and they consume `max_completion_tokens`
 * before the JSON can finish. `reasoning_effort: "none"` turns reasoning off
 * outright (`reasoning_format: "hidden"` only hides the tokens — they are
 * still generated and still spend the budget).
 *
 * The parameter is qwen3-only: `openai/gpt-oss-120b`, which sits in
 * roaster-enrichment-worker's GROQ_TRIAGE_MODELS cascade, does not accept it,
 * and gpt-oss accepts only low/medium/high. So it must be applied per model
 * rather than unconditionally — spread the result into the request body.
 */
export function groqReasoningOverride(
  model: string,
): { reasoning_effort?: "none" } {
  return model.startsWith("qwen/") ? { reasoning_effort: "none" } : {};
}

export type OpenAiModelTier = "BIG" | "MEDIUM" | "SMALL";

export type OpenAiModelEnvReader = (name: string) => string | undefined;

export interface OpenAiModelSettings {
  readonly models: Readonly<Record<OpenAiModelTier, string>>;
  readonly embedding: string;
  readonly moderation: string;
}

const OPENAI_MODEL_DEFAULTS = Object.freeze({
  BIG: "gpt-5.6-sol",
  MEDIUM: "gpt-5.6-terra",
  SMALL: "gpt-5.6-luna",
  EMBEDDING: "text-embedding-3-small",
  MODERATION: "omni-moderation-latest",
});

function readModelOverride(
  readEnv: OpenAiModelEnvReader,
  name: string,
  fallback: string,
): string {
  const configured = readEnv(name)?.trim();
  return configured || fallback;
}

/**
 * Resolves all OpenAI API model configuration from an injectable environment
 * reader. Keeping this pure makes defaults and overrides testable without
 * mutating the process environment.
 */
export function resolveOpenAiModelSettings(
  readEnv: OpenAiModelEnvReader,
): Readonly<OpenAiModelSettings> {
  const models = Object.freeze({
    BIG: readModelOverride(
      readEnv,
      "OPENAI_MODEL_BIG",
      OPENAI_MODEL_DEFAULTS.BIG,
    ),
    MEDIUM: readModelOverride(
      readEnv,
      "OPENAI_MODEL_MEDIUM",
      OPENAI_MODEL_DEFAULTS.MEDIUM,
    ),
    SMALL: readModelOverride(
      readEnv,
      "OPENAI_MODEL_SMALL",
      OPENAI_MODEL_DEFAULTS.SMALL,
    ),
  });

  return Object.freeze({
    models,
    embedding: readModelOverride(
      readEnv,
      "OPENAI_MODEL_EMBEDDING",
      OPENAI_MODEL_DEFAULTS.EMBEDDING,
    ),
    moderation: readModelOverride(
      readEnv,
      "OPENAI_MODEL_MODERATION",
      OPENAI_MODEL_DEFAULTS.MODERATION,
    ),
  });
}

const openAiModelSettings = resolveOpenAiModelSettings((name) =>
  Deno.env.get(name)
);

/** Generative OpenAI models. Consumers select a capability tier, not a model ID. */
export const OPENAI_MODELS = openAiModelSettings.models;

/** Specialized OpenAI model identifiers that do not belong to a generative tier. */
export const OPENAI_SPECIALIZED_MODELS = Object.freeze({
  EMBEDDING: openAiModelSettings.embedding,
  MODERATION: openAiModelSettings.moderation,
});

// Google Gemini (Vertex AI) default model. GA model, shutdown 2027-05-07.
export const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite";

// Recipe parsing uses Vertex's global endpoint: GA gemini-3.1-flash-lite
// returned 404 on europe-west9 on 2026-10-07. GEMINI_REGION remains in use
// by other callers (moderation and label parsing).
export const GEMINI_DEFAULT_LOCATION: string = "global";

// Cerebras default vision model — Gemma 4 31B (multimodal, OpenAI-compatible
// chat completions API). Accepts base64 PNG/JPEG data URIs only, max 5 images
// per request. Used as the primary coffee-label parsing model.
export const CEREBRAS_DEFAULT_MODEL = "gemma-4-31b";

// Vercel AI Gateway — one OpenAI-compatible endpoint fronting many providers
// at provider list rates with no markup. The free tier grants $5 of credits
// that refresh every 30 days across a subset of the catalog; buying credits
// ends that allocation permanently, so do not top up to "test" something.
//
// google/gemma-4-31b-it served this tier from 2026-08-21 until it lost
// free-tier eligibility on 2026-09-15 (403 RestrictedModelsError, reported
// with type no_providers_available: "Free tier users do not have access to
// this model").
//
// gemma-4-26b-a4b-it replaced it on 2026-09-18 (free-tier eligible, served
// via vertex). Probed on 6 real bag photos x 3 rounds against the Z.ai GLM
// primary: roast dates 6/6 correct including a handwritten DD.MM.YY, never
// invented a date for a blank field, field accuracy comparable to GLM with
// different small misses. But 6 of 18 calls hit 429 at 20s spacing even after
// retries, so the free allowance is thin — acceptable for a fallback tier
// that sees a handful of calls a day, not for a primary. Eligibility changes
// without notice: re-verify with scripts/label-model-probe.ts.
export const VERCEL_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const VERCEL_GATEWAY_DEFAULT_MODEL = "google/gemma-4-26b-a4b-it";

// Z.ai (GLM) — OpenAI-compatible endpoint. Measured against 150 real
// parse-coffee-label user labels: GLM-5.3-flash beat the Vercel-gateway
// Gemma primary 84.8% vs 56% precision on roast dates, 0.7% vs 21% error
// rate, median 2.9s — so it becomes the primary tier.
//
// The /api/coding/ path is required for a coding-plan key: the documented
// /api/paas/v4 endpoint answers 429 "insufficient balance" for such keys.
// Z_AI_BASE_URL exists so moving to a pay-as-you-go key is a config change,
// not a code change.
export const ZAI_BASE_URL = Deno.env.get("Z_AI_BASE_URL") ??
  "https://api.z.ai/api/coding/paas/v4";
export const ZAI_DEFAULT_MODEL = "glm-5.3-flash";

// TypeSafe AI "Jev" — a decision model, not a generative one: callers send
// shared state plus typed questions (noul/choice/score) and receive typed
// answers with calibrated probabilities. It never emits free text, so it
// replaces classification-shaped decisions that would otherwise cost a
// generative call and does not belong in OPENAI_MODELS. Consumed through
// _shared/jev-client.ts.
export const JEV_MODEL = readModelOverride(
  (name) => Deno.env.get(name),
  "TYPESAFE_MODEL",
  "jev-latest",
);
