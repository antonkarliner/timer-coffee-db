/**
 * Centralized AI model identifiers shared across edge functions.
 *
 * Keep model strings here so a version bump (or provider swap) happens in one
 * place instead of being duplicated across functions. Names are intentionally
 * version-agnostic (PROVIDER_DEFAULT_MODEL) so swapping the underlying model is
 * a one-line change here.
 */

// Groq default model — currently Llama 4 Scout (vision-capable). Used for
// coffee-label parsing and as the primary roaster-enrichment triage model.
// NOTE: Llama 4 Scout is scheduled for deactivation on 2026-07-17; swap the
// value below before then (the parse-coffee-label fallback chain degrades
// gracefully if it disappears, but other callers rely on this directly).
export const GROQ_DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// OpenAI default model (api.openai.com). General-purpose small model used for
// vision parsing and translations.
export const OPENAI_DEFAULT_MODEL = "gpt-5.4-mini";

// Google Gemini (Vertex AI) default model. GA model, shutdown 2027-05-07.
export const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite";

// Cerebras default vision model — Gemma 4 31B (multimodal, OpenAI-compatible
// chat completions API). Accepts base64 PNG/JPEG data URIs only, max 5 images
// per request. Used as the primary coffee-label parsing model.
export const CEREBRAS_DEFAULT_MODEL = "gemma-4-31b";
