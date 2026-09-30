import { APP_STORE_COUNTRIES } from "../_shared/store-ratings/countries.ts";
import { collectAppleCountry } from "../_shared/store-ratings/apple.ts";
import {
  CollectionError,
  errorCode,
  type Observation,
} from "../_shared/store-ratings/model.ts";
import {
  claimRun,
  collectorGate,
  jsonResponse,
} from "../_shared/store-ratings/http.ts";
import { logInfo, logWarning } from "../_shared/monitoring.ts";

export async function handler(req: Request): Promise<Response> {
  const gate = collectorGate(req);
  if (gate) return gate;
  try {
    const appId = Deno.env.get("APP_STORE_APP_ID") ?? "6449322787";
    if (!/^\d+$/.test(appId)) throw new CollectionError("apple_invalid_app_id");
    const { db, date, lease } = await claimRun(
      "app_store",
      appId,
      APP_STORE_COUNTRIES,
    );
    if (!lease.lease_token) return jsonResponse(req, { status: lease.status });
    const observations: Observation[] = [];
    let failure: string | null = null;
    for (const country of lease.countries ?? []) {
      // Apple's documented ~20 requests/minute limit: 3.5s between calls.
      const started = Date.now();
      try {
        observations.push(await collectAppleCountry(appId, country, date));
      } catch (error) {
        failure = errorCode(error);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 3500 - (Date.now() - started)))
      );
    }
    const { data, error } = await db.schema("service").rpc(
      "finish_store_ratings_run",
      {
        p_store: "app_store",
        p_date: date,
        p_token: lease.lease_token,
        p_observations: observations,
        p_snapshot: null,
        p_error_code: failure,
      },
    );
    if (error) throw new CollectionError("database_finish_failed");
    if (failure) {
      logWarning("App Store ratings batch incomplete", {
        code: failure,
        countriesCollected: observations.length,
      });
    } else logInfo("App Store ratings batch collected", { ...data });
    return jsonResponse(req, data, failure ? 502 : 200);
  } catch (error) {
    const code = errorCode(error);
    logWarning("App Store ratings collector failed", { code });
    return jsonResponse(req, { error: code }, 502);
  }
}
if (import.meta.main) Deno.serve(handler);
