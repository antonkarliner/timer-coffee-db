/** Shared plan 041 audience shape. Null/absent/empty dimensions are unrestricted. */
export type AudienceFilter = {
  locales?: string[] | null;
  countries?: string[] | null;
  regions?: string[] | null;
  platforms?: ("ios" | "android" | "web")[] | null;
};

type ValidationResult =
  | { ok: true; value: AudienceFilter | null }
  | { ok: false; error: string };

/** Mirrors public.is_valid_audience_filter; never coerces invalid input. */
export function validateAudienceFilter(input: unknown): ValidationResult {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "audience_filter must be an object or null" };
  }
  const value: Record<string, string[] | null> = {};
  for (const [key, dimension] of Object.entries(input)) {
    if (!["locales", "countries", "regions", "platforms"].includes(key)) {
      return { ok: false, error: `Unknown audience_filter key: ${key}` };
    }
    if (dimension === null) {
      value[key] = null;
      continue;
    }
    if (!Array.isArray(dimension)) {
      return {
        ok: false,
        error: `audience_filter.${key} must be an array or null`,
      };
    }
    for (const item of dimension) {
      const valid = typeof item === "string" &&
        (key === "locales"
          ? item.length >= 2 && item.length <= 10 &&
            /^[a-z]{2,10}(-[a-z0-9]+)*$/.test(item)
          : key === "countries"
          ? /^[A-Z]{2}$/.test(item)
          : key === "regions"
          ? /^[A-Z]{2,10}$/.test(item)
          : ["ios", "android", "web"].includes(item));
      if (!valid) {
        return { ok: false, error: `Invalid audience_filter.${key} entry` };
      }
    }
    value[key] = [...dimension];
  }
  return { ok: true, value: value as AudienceFilter };
}
