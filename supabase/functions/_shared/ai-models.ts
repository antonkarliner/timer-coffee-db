/**
 * Centralized AI model identifiers shared across edge functions.
 *
 * OpenAI API consumers select a capability tier here. Runtime overrides come
 * from the model environment variables read only by this module; reviewed
 * defaults keep local development and new deployments deterministic.
 */

// Groq default model — currently Qwen 3.6 27B (vision-capable: max 5 images,
// ≤4 MB base64 per request). Used for coffee-label parsing and as the primary
// roaster-enrichment triage model. Replaced Llama 4 Scout ahead of its
// 2026-07-17 deactivation, per Groq's recommended migration.
export const GROQ_DEFAULT_MODEL = "qwen/qwen3.6-27b";

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

// Cerebras default vision model — Gemma 4 31B (multimodal, OpenAI-compatible
// chat completions API). Accepts base64 PNG/JPEG data URIs only, max 5 images
// per request. Used as the primary coffee-label parsing model.
export const CEREBRAS_DEFAULT_MODEL = "gemma-4-31b";
