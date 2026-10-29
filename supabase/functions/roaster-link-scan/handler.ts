// Scheduled re-check of the links saved on roaster pages (website + links in
// the description) with Google Web Risk. Flagged links are quarantined by
// service.quarantine_roaster_link (20261029111556_roaster_link_quarantine.sql);
// fully checked pages are marked with service.mark_roaster_links_checked.
//
// Failure policy:
// - no Web Risk key: 500, nothing is looked up or marked;
// - a lookup error/timeout: that page is not marked (it stays due), the run
//   continues with the others;
// - quota/rate limit (or a refused key): the run stops early and only the
//   pages fully checked so far are marked;
// - email failures are logged and never fail the run.
//
// Logs carry hosts only, never full URLs (which can hold query strings) or
// the API key.

import {
  authorizeServiceRequest,
  type ServiceRoleAuthorization,
} from "../_shared/service-role-auth.ts";
import type { WebRiskLookupResult } from "../_shared/web-risk.ts";
import {
  buildAdminSummaryEmail,
  buildRoasterEmail,
  type EmailMessage,
  type QuarantinedLink,
} from "./emails.ts";
import { collectPageLinks, type LinkField, type PageLink } from "./links.ts";

export const DEFAULT_LIMIT = 300;
export const MAX_LIMIT = 1000;
export const DEFAULT_CONCURRENCY = 5;
/** Stop taking new pages after this long, well inside the edge wall clock. */
export const DEFAULT_TIME_BUDGET_MS = 110_000;

export interface ScanPage {
  roaster_profile_id: string;
  website_url: string | null;
  description: string | null;
  admin_user_id: string | null;
}

export interface RoasterPageInfo {
  id: string;
  slug: string | null;
  roaster_name: string | null;
}

export interface QuarantineArgs {
  roasterProfileId: string;
  field: LinkField;
  url: string;
  threatTypes: string[];
}

export interface ScanLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface RoasterLinkScanDeps {
  authorize(req: Request): ServiceRoleAuthorization;
  getWebRiskApiKey(): string | undefined;
  createLookUp(apiKey: string): (uri: string) => Promise<WebRiskLookupResult>;
  fetchBatch(limit: number): Promise<ScanPage[]>;
  /** The new flag id, or null when the value already changed. */
  quarantineLink(args: QuarantineArgs): Promise<string | null>;
  markChecked(roasterProfileIds: string[]): Promise<void>;
  getRoasterPages(ids: string[]): Promise<RoasterPageInfo[]>;
  getUserEmail(userId: string): Promise<string | null>;
  /** Throws on failure. */
  sendEmail(message: EmailMessage): Promise<void>;
  adminEmail?: string;
  getCorsHeaders(origin?: string): Record<string, string>;
  createResponse(
    body: string,
    init: ResponseInit & { headers?: Record<string, string> },
  ): Response;
  logger: ScanLogger;
  now?(): number;
  timeBudgetMs?: number;
  concurrency?: number;
}

export interface ScanSummary {
  checked: number;
  flagged: number;
  quarantined: number;
  skipped_errors: number;
  stopped_early: boolean;
}

type StopReason = "quota" | "auth_error" | "time_budget";

interface NewFlag {
  flagId: string;
  page: ScanPage;
  field: LinkField;
  host: string;
  threatTypes: string[];
}

/**
 * The scheduler's credential, as public.roaster_link_scan_cron() sends it
 * (20261029120000_roaster_link_scan_cron.sql, header construction copied from
 * 20260708171500_migrate_pgnet_callers_to_apikey.sql): the service-role key
 * as `Authorization: Bearer` (legacy fallback) or in `apikey`, or the
 * new-style `edge_functions_api_key` in `apikey` once it is provisioned in
 * Vault and mirrored as EDGE_FUNCTIONS_API_KEY. Same set export-user-data's
 * cleanup action accepts. A user's JWT or the anon key is never enough.
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

function parseLimit(
  raw: string,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, limit: DEFAULT_LIMIT };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Request body must be JSON." };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const limit = (body as { limit?: unknown }).limit;
  if (limit === undefined || limit === null) {
    return { ok: true, limit: DEFAULT_LIMIT };
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    return { ok: false, error: "limit must be a positive integer." };
  }
  return { ok: true, limit: Math.min(limit, MAX_LIMIT) };
}

export function createRoasterLinkScanHandler(deps: RoasterLinkScanDeps) {
  const now = deps.now ?? (() => Date.now());
  const timeBudgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
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

    const apiKey = deps.getWebRiskApiKey()?.trim();
    if (!apiKey) {
      log.error("GOOGLE_WEB_RISK_API_KEY is not configured; scan not run");
      return json(500, {
        error:
          "GOOGLE_WEB_RISK_API_KEY is not configured; the link scan did not run.",
      });
    }

    let rawBody = "";
    try {
      rawBody = await req.text();
    } catch {
      return json(400, { error: "Could not read the request body." });
    }
    const parsed = parseLimit(rawBody);
    if (!parsed.ok) return json(400, { error: parsed.error });

    let batch: ScanPage[];
    try {
      batch = await deps.fetchBatch(parsed.limit);
    } catch (error) {
      log.error("roaster_link_scan_batch failed", {
        error: errorMessage(error),
      });
      return json(500, { error: "Could not load the scan batch." });
    }

    const lookUp = deps.createLookUp(apiKey);
    const startedAt = now();
    const summary: ScanSummary = {
      checked: 0,
      flagged: 0,
      quarantined: 0,
      skipped_errors: 0,
      stopped_early: false,
    };
    // An object so the closures below and the code after them share it.
    const state: { stopReason: StopReason | null } = { stopReason: null };
    const checkedIds: string[] = [];
    const newFlags: NewFlag[] = [];

    const stop = (reason: StopReason) => {
      if (!state.stopReason) state.stopReason = reason;
    };

    async function quarantine(
      page: ScanPage,
      link: PageLink,
      threatTypes: string[],
    ): Promise<boolean> {
      let ok = true;
      for (const occurrence of link.occurrences) {
        try {
          const flagId = await deps.quarantineLink({
            roasterProfileId: page.roaster_profile_id,
            field: occurrence.field,
            url: occurrence.value,
            threatTypes,
          });
          log.info("Flagged link", {
            roaster_profile_id: page.roaster_profile_id,
            field: occurrence.field,
            host: link.host,
            threat_types: threatTypes,
            quarantined: flagId !== null,
          });
          if (flagId) {
            summary.quarantined += 1;
            newFlags.push({
              flagId,
              page,
              field: occurrence.field,
              host: link.host,
              threatTypes,
            });
          }
        } catch (error) {
          ok = false;
          log.error("quarantine_roaster_link failed", {
            roaster_profile_id: page.roaster_profile_id,
            field: occurrence.field,
            host: link.host,
            error: errorMessage(error),
          });
        }
      }
      return ok;
    }

    async function scanPage(page: ScanPage): Promise<void> {
      const links = collectPageLinks(page);
      let complete = true;
      for (const link of links) {
        // Checked before every lookup (not just every page), so a page with
        // many slow links can't carry the run past the edge request timeout.
        if (!state.stopReason && now() - startedAt > timeBudgetMs) {
          stop("time_budget");
        }
        if (state.stopReason) {
          complete = false;
          break;
        }
        const result = await lookUp(link.href);
        if (result.status === "clean") continue;
        if (result.status === "flagged") {
          summary.flagged += 1;
          if (!(await quarantine(page, link, result.threatTypes))) {
            complete = false;
          }
          continue;
        }
        complete = false;
        if (result.status === "quota" || result.status === "auth_error") {
          // A refused key needs an operator; a quota stop clears by itself.
          const message = "Web Risk refused the lookup; stopping the run";
          const details = {
            roaster_profile_id: page.roaster_profile_id,
            status: result.status,
            http_status: result.httpStatus,
          };
          if (result.status === "auth_error") log.error(message, details);
          else log.warn(message, details);
          stop(result.status);
          break;
        }
        log.warn("Web Risk lookup failed; page stays due", {
          roaster_profile_id: page.roaster_profile_id,
          host: link.host,
          reason: result.reason,
          http_status: result.httpStatus ?? null,
        });
      }
      if (complete) {
        checkedIds.push(page.roaster_profile_id);
      } else {
        summary.skipped_errors += 1;
      }
    }

    let nextIndex = 0;
    async function worker(): Promise<void> {
      while (nextIndex < batch.length) {
        if (state.stopReason) return;
        if (now() - startedAt > timeBudgetMs) {
          stop("time_budget");
          return;
        }
        const page = batch[nextIndex];
        nextIndex += 1;
        await scanPage(page);
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, batch.length) },
        () => worker(),
      ),
    );
    summary.stopped_early = state.stopReason !== null;

    let markFailed = false;
    if (checkedIds.length > 0) {
      try {
        await deps.markChecked(checkedIds);
        summary.checked = checkedIds.length;
      } catch (error) {
        markFailed = true;
        log.error("mark_roaster_links_checked failed", {
          pages: checkedIds.length,
          error: errorMessage(error),
        });
      }
    }

    if (newFlags.length > 0) {
      await sendNotifications(newFlags);
    }

    log.info("Roaster link scan finished", {
      ...summary,
      batch_size: batch.length,
      stop_reason: state.stopReason,
    });

    if (markFailed) {
      return json(500, {
        error: "Could not mark the checked pages.",
        ...summary,
      });
    }
    return json(200, summary);
  };

  async function sendNotifications(flags: NewFlag[]): Promise<void> {
    const pageIds = [
      ...new Set(flags.map((flag) => flag.page.roaster_profile_id)),
    ];
    let info = new Map<string, RoasterPageInfo>();
    try {
      const pages = await deps.getRoasterPages(pageIds);
      info = new Map(pages.map((page) => [page.id, page]));
    } catch (error) {
      log.warn("Could not load roaster names for the scan emails", {
        error: errorMessage(error),
      });
    }

    const toLink = (flag: NewFlag): QuarantinedLink => {
      const page = info.get(flag.page.roaster_profile_id);
      return {
        roasterProfileId: flag.page.roaster_profile_id,
        roasterName: page?.roaster_name ?? null,
        slug: page?.slug ?? null,
        field: flag.field,
        host: flag.host,
        threatTypes: flag.threatTypes,
      };
    };

    const sends: Promise<void>[] = [];

    if (deps.adminEmail) {
      sends.push(
        deps.sendEmail(
          buildAdminSummaryEmail(deps.adminEmail, flags.map(toLink)),
        )
          .catch((error) => {
            log.error("Admin link scan email failed", {
              error: errorMessage(error),
            });
          }),
      );
    } else {
      log.warn("ADMIN_EMAIL is not configured; admin summary not sent");
    }

    for (const pageId of pageIds) {
      const pageFlags = flags.filter((flag) =>
        flag.page.roaster_profile_id === pageId
      );
      const adminUserId = pageFlags[0].page.admin_user_id;
      if (!adminUserId) continue;
      sends.push((async () => {
        try {
          const email = await deps.getUserEmail(adminUserId);
          if (!email) {
            log.warn("Managing roaster has no email; notice not sent", {
              roaster_profile_id: pageId,
            });
            return;
          }
          await deps.sendEmail(buildRoasterEmail(email, pageFlags.map(toLink)));
        } catch (error) {
          log.error("Roaster link scan email failed", {
            roaster_profile_id: pageId,
            error: errorMessage(error),
          });
        }
      })());
    }

    await Promise.all(sends);
  }
}
