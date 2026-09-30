import {
  collectGoogleReport,
  getGoogleStorageToken,
} from "../_shared/store-ratings/google.ts";
import { CollectionError, errorCode } from "../_shared/store-ratings/model.ts";
import {
  claimRun,
  collectorGate,
  jsonResponse,
  requiredEnv,
} from "../_shared/store-ratings/http.ts";
import { logInfo, logWarning } from "../_shared/monitoring.ts";

export async function handler(req: Request): Promise<Response> {
  const gate = collectorGate(req);
  if (gate) return gate;
  try {
    if (new URL(req.url).searchParams.get("diagnostics") === "identity") {
      // Privileged, uncached metadata only; no key, token, or DB mutation.
      const account = JSON.parse(requiredEnv("GOOGLE_PLAY_SERVICE_ACCOUNT"));
      const email = account?.client_email;
      if (
        typeof email !== "string" || email.length > 320 ||
        !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(email)
      ) {
        throw new CollectionError("google_invalid_credentials");
      }
      return jsonResponse(req, { serviceAccountEmail: email });
    }
    const packageName = requiredEnv("GOOGLE_PLAY_PACKAGE_NAME");
    const bucket = requiredEnv("GOOGLE_PLAY_REPORTS_BUCKET");
    const credentials = requiredEnv("GOOGLE_PLAY_SERVICE_ACCOUNT");
    const { db, date, lease } = await claimRun("google_play", packageName, []);
    if (!lease.lease_token) return jsonResponse(req, { status: lease.status });
    let failure: string | null = null;
    let report: Awaited<ReturnType<typeof collectGoogleReport>> | null = null;
    try {
      const token = await getGoogleStorageToken(credentials);
      report = await collectGoogleReport(bucket, packageName, token, date);
    } catch (error) {
      failure = errorCode(error);
    }
    const { data, error } = await db.schema("service").rpc(
      "finish_store_ratings_run",
      {
        p_store: "google_play",
        p_date: date,
        p_token: lease.lease_token,
        p_observations: report?.observations ?? [],
        p_snapshot: report?.snapshot ?? null,
        p_error_code: failure,
      },
    );
    if (error) throw new CollectionError("database_finish_failed");
    if (failure || !report?.snapshot) {
      logWarning("Google Play ratings snapshot not refreshed", {
        code: failure ?? "google_no_overall_rating",
        countriesCollected: report?.observations.length ?? 0,
      });
    } else {logInfo("Google Play ratings snapshot refreshed", {
        sourceDate: report.sourceDate,
      });}
    return jsonResponse(req, {
      ...data,
      sourceDate: report?.sourceDate ?? null,
      ...(failure ? { error: failure } : {}),
    }, failure ? 502 : 200);
  } catch (error) {
    const code = errorCode(error);
    logWarning("Google Play ratings collector failed", { code });
    return jsonResponse(req, { error: code }, 502);
  }
}
if (import.meta.main) Deno.serve(handler);
