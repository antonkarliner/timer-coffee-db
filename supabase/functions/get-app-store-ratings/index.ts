import { database, jsonResponse } from "../_shared/store-ratings/http.ts";

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return jsonResponse(req, {});
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonResponse(req, { error: "method_not_allowed" }, 405, {
      Allow: "GET, HEAD, OPTIONS",
    });
  }
  try {
    const { data, error } = await database().from("app_store_ratings")
      .select(
        "store,app_id,average_rating,rating_count,source_date,fetched_at,methodology,is_approximate,coverage",
      )
      .order("store");
    if (error) return jsonResponse(req, { error: "ratings_unavailable" }, 503);
    const ratings = (data ?? []).map((row) => ({
      store: row.store,
      appId: row.app_id,
      averageRating: row.average_rating,
      ratingCount: row.rating_count,
      scope: "worldwide",
      sourceDate: row.source_date,
      fetchedAt: row.fetched_at,
      methodology: row.methodology,
      isApproximate: row.is_approximate,
      coverage: row.coverage,
    }));
    const body = {
      ratings,
      missingStores: ["app_store", "google_play"].filter((store) =>
        !ratings.some((rating) => rating.store === store)
      ),
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(body)),
    );
    const etag = '"' + Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, "0")).join("") +
      '"';
    const headers: Record<string, string> = ratings.length
      ? {
        "Cache-Control":
          "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400",
        "ETag": etag,
        "Access-Control-Expose-Headers": "ETag",
        "Pragma": "",
        "Expires": "",
      }
      : { "Cache-Control": "no-store" };
    if (req.headers.get("If-None-Match") === etag && ratings.length) {
      return jsonResponse(req, undefined, 304, headers);
    }
    return jsonResponse(
      req,
      req.method === "HEAD" ? undefined : body,
      200,
      headers,
    );
  } catch {
    return jsonResponse(req, { error: "ratings_unavailable" }, 503);
  }
}
if (import.meta.main) Deno.serve(handler);
