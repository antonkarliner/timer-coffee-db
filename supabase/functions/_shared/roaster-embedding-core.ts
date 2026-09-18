/**
 * Roaster name-embedding generation for the pgvector `name_embedding` column.
 *
 * ONE implementation used by BOTH callers:
 *   - `generate-roaster-embedding/index.ts` (hand-dispatched operator path)
 *   - `roaster-postprocess-worker/index.ts` (the `generate_embedding` job kind)
 *
 * Vector-space constraint: every stored `name_embedding` must live in the SAME
 * 384-dimensional space — the OpenAI embedding model resolved through
 * `_shared/ai-models.ts` (`OPENAI_SPECIALIZED_MODELS.EMBEDDING`), requested at
 * `dimensions: 384`, authenticated with the `OPENAI_API_KEY` secret (the
 * personal key, NOT `OPENAI_API_KEY_NON_PERSONAL`, which serves the
 * operational workloads). The existing 2,000+ stored vectors were produced
 * that way; a vector from any other key/model/dimension combination would not
 * be comparable and would silently corrupt `search_roasters_by_vector` and
 * `find_potential_roaster_matches_with_vector`.
 *
 * No supabase-js import and no Deno.env access at module scope: importing
 * this module stays cheap and side-effect free, so unit tests need no
 * environment variables. All side effects (HTTP, DB write) are injected as
 * deps.
 */

import {
  EmbeddingConfigError,
  EmbeddingInputError,
  EmbeddingResponseError,
  HttpSourceError,
} from "./roaster-postprocess-errors.ts";

/** The pgvector column and the provider request are pinned to this width. */
export const ROASTER_EMBEDDING_DIMENSIONS = 384;

/**
 * Build the text whose embedding is stored in `coffee_roasters.name_embedding`.
 * This function produced every stored vector — its output is load-bearing and
 * must not change behaviour. Returns null when there is no canonical name.
 */
export function buildEmbeddingInput(
  roasterName: string,
  aliases: string | null,
): string | null {
  const canonicalName = roasterName.trim();
  if (!canonicalName) {
    return null;
  }

  const normalizedAliases = aliases
    ?.split(",")
    .map((alias) => alias.trim())
    .filter(Boolean)
    .join(" ");

  return normalizedAliases
    ? `${canonicalName} ${normalizedAliases}`
    : canonicalName;
}

export interface EmbeddingCoreDeps {
  /** `OPENAI_API_KEY` — read by the caller at job time, never at module scope. */
  openAiApiKey: string | null | undefined;
  /** OpenAI embedding model id (from `OPENAI_SPECIALIZED_MODELS.EMBEDDING`). */
  model: string;
  /** Injectable fetch so tests never touch the network. */
  fetchImpl: typeof fetch;
  /** Persists the vector; the caller wraps storage errors (e.g. in DbError). */
  updateRoasterEmbedding(roasterId: number, embedding: number[]): Promise<void>;
}

export interface EmbeddingCoreInput {
  roasterId: number;
  roasterName: string | null;
  aliases: string | null;
}

export interface RoasterNameEmbeddingResult {
  embedding: number[];
  /** The exact text that was embedded — useful in tests and logs. */
  embeddedText: string;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: unknown }>;
}

/**
 * Generate and persist the 384-dim name embedding for one roaster.
 * Throws typed errors; callers classify them for the job ledger or map them
 * to HTTP statuses.
 */
export async function generateRoasterNameEmbedding(
  deps: EmbeddingCoreDeps,
  input: EmbeddingCoreInput,
): Promise<RoasterNameEmbeddingResult> {
  if (!deps.openAiApiKey) {
    throw new EmbeddingConfigError(
      "OPENAI_API_KEY is not configured; cannot generate roaster embeddings",
    );
  }

  const embeddedText = buildEmbeddingInput(
    input.roasterName ?? "",
    input.aliases,
  );
  if (!embeddedText) {
    throw new EmbeddingInputError(
      `Roaster ${input.roasterId} has no canonical name to embed`,
    );
  }

  // Request body identical to the one that produced every stored vector.
  const response = await deps.fetchImpl(
    "https://api.openai.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${deps.openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: embeddedText,
        model: deps.model,
        dimensions: ROASTER_EMBEDDING_DIMENSIONS,
      }),
    },
  );

  if (!response.ok) {
    // Log only the status — never the api key or the provider response body.
    console.error("Embedding provider request failed", {
      status: response.status,
    });
    throw new HttpSourceError(
      response.status,
      `Embedding provider request failed with HTTP ${response.status}`,
    );
  }

  const payload = await response.json() as OpenAiEmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (
    !Array.isArray(embedding) ||
    embedding.length !== ROASTER_EMBEDDING_DIMENSIONS ||
    !embedding.every((value) => typeof value === "number")
  ) {
    console.error("Embedding provider returned an invalid payload");
    throw new EmbeddingResponseError(
      `Embedding provider returned an invalid payload (expected an array of ${ROASTER_EMBEDDING_DIMENSIONS} numbers)`,
    );
  }

  await deps.updateRoasterEmbedding(input.roasterId, embedding);

  return { embedding, embeddedText };
}
