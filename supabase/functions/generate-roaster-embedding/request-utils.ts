// buildEmbeddingInput moved verbatim to ../_shared/roaster-embedding-core.ts —
// the ONE implementation shared with the roaster-postprocess-worker.
export function parseRoasterId(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return null;
  }

  return value;
}
