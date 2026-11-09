// global-stats-insert-watchdog: pg_cron check (every 30 minutes) that brews
// still reach public.global_stats. The app writes each brew directly as
// `authenticated` and catches insert errors with only a local log, so a
// broken insert path (a new grant, an RLS change, an app release chaining
// .select() on the insert) would lose brews silently. When no row has been
// inserted for SILENCE_THRESHOLD_MINUTES, email the operator.
//
// Failure policy — data that looks unhealthy is never reported as healthy:
// - latest-insert query fails: 500;
// - no global_stats row at or before now: 500 (a future-dated row cannot
//   blind the check because the query bounds created_at with lte);
// - an alert is due but ADMIN_EMAIL is unset: 500;
// - the Resend send fails: 502.
//
// Invoked only by pg_cron (public.global_stats_insert_watchdog_cron, see
// 20261109130000_global_stats_insert_watchdog_cron.sql). It authenticates
// the request itself with the same scheduler credential as
// roaster-link-scan (verify_jwt = false in config.toml).

import {
  authorizeServiceRequest,
  type ServiceRoleAuthorization,
} from "../_shared/service-role-auth.ts";

/** Silence at least this long means something is probably broken. */
export const SILENCE_THRESHOLD_MINUTES = 120;
/** Cron cadence the watchdog is scheduled at. */
export const RUN_INTERVAL_MINUTES = 30;
/** While the silence continues, re-alert at this interval. */
export const REALERT_EVERY_MINUTES = 360;

/** Same sender as the other operator emails (roaster-link-scan). */
export const ALERT_EMAIL_FROM = "roasters@timer.coffee";

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface WatchdogLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface GlobalStatsWatchdogDeps {
  authorize(req: Request): ServiceRoleAuthorization;
  /**
   * The latest created_at at or before nowIso, or null when there is none.
   * The lte bound matters: authenticated clients can set created_at, so a
   * single future-dated row must not blind the watchdog.
   */
  getLatestInsertAt(nowIso: string): Promise<string | null>;
  /** Throws on failure. */
  sendEmail(message: EmailMessage): Promise<void>;
  adminEmail?: string;
  getCorsHeaders(origin?: string): Record<string, string>;
  createResponse(
    body: string,
    init: ResponseInit & { headers?: Record<string, string> },
  ): Response;
  logger: WatchdogLogger;
  now?(): Date;
}

/**
 * Stateless alert gate: fire in the first run past the 120-minute threshold,
 * then in the first run past every following 6-hour boundary. Runs land
 * every RUN_INTERVAL_MINUTES, so each gate window contains exactly one run.
 */
export function shouldAlert(silenceMinutes: number): boolean {
  const sinceThreshold = silenceMinutes - SILENCE_THRESHOLD_MINUTES;
  return silenceMinutes >= SILENCE_THRESHOLD_MINUTES &&
    sinceThreshold % REALERT_EVERY_MINUTES < RUN_INTERVAL_MINUTES;
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function buildSilenceAlertEmail(
  to: string,
  latestInsertAt: string,
  silenceMinutes: number,
): EmailMessage {
  const hours = Math.max(1, Math.floor(silenceMinutes / 60));
  const lastInsertUtc = escapeHtml(new Date(latestInsertAt).toISOString());
  const threshold = `${SILENCE_THRESHOLD_MINUTES} minutes`;
  const intro =
    `No brew has been recorded in public.global_stats for ${hours}h. The last recorded insert is ${lastInsertUtc} UTC (silence ${silenceMinutes} minutes; alert threshold ${threshold}).`;
  const whyItIsSilent =
    "The app catches insert errors with only a local log, so users will not report this: brews are being lost silently.";
  const whereToLook = [
    "A recent migration, or the grants on public.global_stats (client SELECT on user_id was revoked in 20261109123435_global_stats_revoke_user_id.sql).",
    "The table's RLS INSERT policy.",
    "tests/security/f19_global_stats_client_access.sql.",
    "A recent app release chaining .select() on the global_stats insert.",
  ];
  return {
    from: ALERT_EMAIL_FROM,
    to,
    subject: `Timer.Coffee: no brews recorded for ${hours}h`,
    text: [
      intro,
      "",
      whyItIsSilent,
      "",
      "Where to look:",
      ...whereToLook.map((line) => `- ${line}`),
      "",
      "Timer.Coffee global-stats-insert-watchdog",
    ].join("\n"),
    html: `<p>${escapeHtml(intro)}</p><p>${
      escapeHtml(whyItIsSilent)
    }</p><p>Where to look:</p><ul>${
      whereToLook.map((line) => `<li>${escapeHtml(line)}</li>`).join("")
    }</ul>`,
  };
}

/**
 * The scheduler's credential, as public.global_stats_insert_watchdog_cron()
 * sends it: the service-role key as `Authorization: Bearer` (legacy
 * fallback) or in `apikey`, or the new-style `edge_functions_api_key` in
 * `apikey` once it is provisioned in Vault and mirrored as
 * EDGE_FUNCTIONS_API_KEY. A user's JWT or the anon key is never enough.
 * Same logic as roaster-link-scan's authorizeSchedulerRequest, kept local so
 * importing this handler pulls in none of the scan's code.
 */
export function authorizeSchedulerRequest(
  req: Request,
  serviceRoleKey: string,
  edgeFunctionsApiKey = "",
): ServiceRoleAuthorization {
  const primary = authorizeServiceRequest(req, serviceRoleKey);
  if (primary.authorized || !edgeFunctionsApiKey) return primary;
  const secondary = authorizeServiceRequest(req, edgeFunctionsApiKey);
  return secondary.authorized ? secondary : primary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGlobalStatsInsertWatchdogHandler(
  deps: GlobalStatsWatchdogDeps,
) {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger;

  return async function handleRequest(req: Request): Promise<Response> {
    const cors = deps.getCorsHeaders(req.headers.get("origin") ?? undefined);
    const json = (status: number, body: unknown) =>
      deps.createResponse(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    if (req.method === "OPTIONS") {
      return deps.createResponse("ok", { headers: cors });
    }
    if (req.method !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const authorization = deps.authorize(req);
    if (!authorization.authorized) {
      return json(authorization.status, { error: authorization.error });
    }

    const nowDate = now();
    const nowIso = nowDate.toISOString();
    let latestInsertAt: string | null;
    try {
      latestInsertAt = await deps.getLatestInsertAt(nowIso);
    } catch (error) {
      log.error("global_stats latest-insert query failed", {
        error: errorMessage(error),
      });
      return json(500, {
        error: "Could not read the latest global_stats insert time.",
      });
    }
    if (latestInsertAt === null) {
      log.error(
        "global_stats has no row at or before now; insert path looks broken",
        { checked_against: nowIso },
      );
      return json(500, {
        error:
          "No global_stats row at or before now; the insert path may be broken.",
      });
    }

    // Whole minutes, floored.
    const silenceMinutes = Math.floor(
      (nowDate.getTime() - new Date(latestInsertAt).getTime()) / 60_000,
    );

    if (!shouldAlert(silenceMinutes)) {
      log.info("global_stats inserts look healthy", {
        latest_insert_at: latestInsertAt,
        silence_minutes: silenceMinutes,
      });
      return json(200, {
        status: "ok",
        latest_insert_at: latestInsertAt,
        silence_minutes: silenceMinutes,
      });
    }

    if (!deps.adminEmail) {
      log.error("ADMIN_EMAIL is not configured; silence alert not sent", {
        latest_insert_at: latestInsertAt,
        silence_minutes: silenceMinutes,
      });
      return json(500, {
        error: "ADMIN_EMAIL is not configured; the silence alert was not sent.",
      });
    }

    try {
      await deps.sendEmail(
        buildSilenceAlertEmail(deps.adminEmail, latestInsertAt, silenceMinutes),
      );
    } catch (error) {
      log.error("global_stats silence alert email failed", {
        error: errorMessage(error),
      });
      return json(502, {
        error: "The global_stats silence alert email could not be sent.",
      });
    }

    log.warn("global_stats insert-silence alert sent", {
      latest_insert_at: latestInsertAt,
      silence_minutes: silenceMinutes,
    });
    return json(200, {
      status: "alerted",
      latest_insert_at: latestInsertAt,
      silence_minutes: silenceMinutes,
    });
  };
}
