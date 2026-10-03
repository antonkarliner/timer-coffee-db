/** Shared reference data cache; database failures retain geoip's WW fallback. */
export function createCountryRegionLookup(
  load: () => PromiseLike<{
    data: { country_code: string; region: string }[] | null;
    error: { message: string } | null;
  }>,
  warn: (message: string) => void,
  now: () => number = Date.now,
) {
  let cache: Map<string, string> | null = null;
  let expiresAt = 0;
  let pending: Promise<Map<string, string> | null> | null = null;
  return async (country: string): Promise<string> => {
    if (!cache || now() >= expiresAt) {
      pending ??= (async () => {
        try {
          const { data, error } = await load();
          if (error) throw new Error(error.message);
          cache = new Map(
            (data ?? []).map((row) => [row.country_code, row.region]),
          );
          expiresAt = now() + 60 * 60 * 1000;
          return cache;
        } catch (error) {
          warn(error instanceof Error ? error.message : String(error));
          return null;
        }
      })();
      const loaded = await pending;
      pending = null;
      if (!loaded) return "WW";
    }
    return cache?.get(country) ?? "WW";
  };
}
