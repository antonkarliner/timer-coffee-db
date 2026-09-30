import { CollectionError, fetchChecked, type Observation } from "./model.ts";

export function parseAppleLookup(
  data: unknown,
  appId: string,
  country: string,
  date: string,
): Observation {
  const result = data as { resultCount?: unknown; results?: unknown[] };
  if (
    !result || !Array.isArray(result.results) ||
    result.resultCount !== result.results.length
  ) {
    throw new CollectionError("apple_invalid_response");
  }
  if (result.resultCount === 0) {
    return {
      country,
      status: "unavailable",
      average_rating: null,
      rating_count: null,
      source_date: date,
    };
  }
  const app = result.results.find((item) =>
    item && typeof item === "object" &&
    String((item as { trackId?: unknown }).trackId) === appId
  ) as {
    averageUserRating?: unknown;
    userRatingCount?: unknown;
    trackViewUrl?: unknown;
  } | undefined;
  if (!app || typeof app.trackViewUrl !== "string") {
    throw new CollectionError("apple_app_mismatch");
  }
  const listingUrl = new URL(app.trackViewUrl);
  if (listingUrl.hostname !== "apps.apple.com") {
    throw new CollectionError("apple_invalid_listing_url");
  }
  const storefront = listingUrl.pathname.split("/")[1];
  if (storefront.toLowerCase() !== country.toLowerCase()) {
    throw new CollectionError("apple_storefront_mismatch");
  }
  const count = app.userRatingCount;
  const average = app.averageUserRating;
  if (
    typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
    (count > 0 &&
      (typeof average !== "number" || !Number.isFinite(average) ||
        average < 1 || average > 5))
  ) {
    throw new CollectionError("apple_invalid_rating");
  }
  return {
    country,
    status: "ok",
    average_rating: count > 0 ? average as number : null,
    rating_count: count,
    source_date: date,
  };
}

export async function collectAppleCountry(
  appId: string,
  country: string,
  date: string,
): Promise<Observation> {
  const url = new URL("https://itunes.apple.com/lookup");
  url.search = new URLSearchParams({ id: appId, country, entity: "software" })
    .toString();
  const response = await fetchChecked(url, {}, 7_000);
  return parseAppleLookup(await response.json(), appId, country, date);
}
