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
