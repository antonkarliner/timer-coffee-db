/**
 * Durable roaster post-processing worker.
 *
 * The ONLY caller of `service.claim_roaster_jobs` / `service.finish_roaster_job`.
 * Invoked by the cron dispatcher with `POST {}` (no body required). Replaces
 * the trigger-inline network + heavy-decode work on the coffee_roasters write
 * path that produced silent HTTP 503/546 failures with no retry.
 *
 * Job kinds:
 *   attach_beans  -> RPC public.attach_pending_global_beans_for_roaster
 *   mirror_logo   -> _shared/roaster-logo-mirror-core.ts (mirror pipeline)
 *   extract_color -> _shared/roaster-color-core.ts (dominant colour)
 *
 * Every failure is classified (retryable vs terminal) into the durable job
 * ledger, so a failed logo job is database-visible and retried with
 * exponential backoff instead of being lost.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { ensureImageMagickReady } from "../_shared/magick-init.ts";
import { getEnvVar } from "../_shared/env-validation.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  flushLogsOnExit,
  generateCorrelationId,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";
import { authorizeServiceRole } from "../_shared/service-role-auth.ts";
import type { ServiceRoleAuthorization } from "../_shared/service-role-auth.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  fetchLogoWithGuards,
  MIRROR_BUCKET,
  MirrorCoreDeps,
  MirrorCoreLogger,
  mirrorRoasterLogo,
  realImageEncoders,
} from "../_shared/roaster-logo-mirror-core.ts";
import {
  decodeColorWithImageMagick,
  extractRoasterDominantColor,
} from "../_shared/roaster-color-core.ts";
import { DbError } from "../_shared/roaster-postprocess-errors.ts";
import { classifyFailure, errorToMessage } from "./failure-classification.ts";
import {
  JOB_KINDS,
  JobLogger,
  PostprocessJob,
  RoasterSnapshot,
  runBatch,
  RunnerDeps,
} from "./runner.ts";

const FUNCTION_NAME = "roaster-postprocess-worker";

const supabaseUrl = getEnvVar("SUPABASE_URL");
const serviceRoleKey = getEnvVar("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing required Supabase configuration for roaster-postprocess-worker",
  );
}

// Default-schema client: coffee_roasters + public RPCs.
const publicClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});
// service-schema client: the job-ledger RPCs live in `service`.
const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
  db: { schema: "service" },
});

/**
 * Claim batch sizing. Edge functions have a ~150s budget; image jobs are the
 * long pole (fetch up to 20s + decode) at concurrency 2, so the default of 8
 * bounds the worst case at ~4 sequential image rounds. Hard-clamped so an
 * operator override cannot exceed the budget by much.
 */
const DEFAULT_JOB_LIMIT = 8;
const MAX_JOB_LIMIT = 20;

/**
 * pg_net (cron dispatcher) may send the service key as `Authorization: Bearer
 * <legacy service JWT>` OR in the `apikey` header — accept both.
 */
function extractAuthorization(req: Request): ServiceRoleAuthorization {
  const authorizationHeader = req.headers.get("Authorization");
  const bearerMatch = authorizationHeader
    ? /^Bearer\s+(.+)$/iu.exec(authorizationHeader)
    : null;
  let auth = authorizeServiceRole(
    bearerMatch ? `Bearer ${bearerMatch[1]}` : null,
    serviceRoleKey,
  );
  if (!auth.authorized) {
    const apiKeyHeader = req.headers.get("apikey");
    if (apiKeyHeader) {
      auth = authorizeServiceRole(`Bearer ${apiKeyHeader}`, serviceRoleKey);
    }
  }
  return auth;
}

function parseClaimedJobs(
  data: unknown,
): { jobs: PostprocessJob[]; malformed: unknown[] } {
  const jobs: PostprocessJob[] = [];
  const malformed: unknown[] = [];
  if (!Array.isArray(data)) return { jobs, malformed };
  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      malformed.push(row);
      continue;
    }
    const candidate = row as Record<string, unknown>;
    const id = typeof candidate.id === "number"
      ? candidate.id
      : Number(candidate.id);
    const roasterId = typeof candidate.roaster_id === "number"
      ? candidate.roaster_id
      : Number(candidate.roaster_id);
    const kind = candidate.kind;
    if (
      !Number.isFinite(id) || !Number.isFinite(roasterId) ||
      typeof kind !== "string" || !JOB_KINDS.includes(kind as never)
    ) {
      malformed.push(row);
      continue;
    }
    jobs.push({
      id,
      roaster_id: roasterId,
      kind: kind as PostprocessJob["kind"],
      source_revision: typeof candidate.source_revision === "string"
        ? candidate.source_revision
        : "",
      attempts: typeof candidate.attempts === "number" ? candidate.attempts : 0,
      correlation_id: typeof candidate.correlation_id === "string"
        ? candidate.correlation_id
        : "unknown",
    });
  }
  return { jobs, malformed };
}

function workerLogger(correlationId: string): JobLogger & MirrorCoreLogger {
  return {
    info: (message, details) =>
      logInfo(`[${FUNCTION_NAME}] ${message}`, details, correlationId),
    warn: (message, details) =>
      logWarning(`[${FUNCTION_NAME}] ${message}`, details, correlationId),
    error: (message, details) => {
      logError(
        `[${FUNCTION_NAME}] ${message}`,
        new Error(
          typeof details?.error === "string" ? details.error : "job failure",
        ),
        ErrorCategory.SYSTEM,
        ErrorSeverity.HIGH,
        details,
        correlationId,
      );
    },
  };
}

function buildRunnerDeps(
  owner: string,
  logger: JobLogger & MirrorCoreLogger,
): RunnerDeps {
  const storage = publicClient.storage.from(MIRROR_BUCKET);

  const mirrorDeps: MirrorCoreDeps = {
    fetchLogo: fetchLogoWithGuards,
    encoders: realImageEncoders,
    logger,
    ensureReady: ensureImageMagickReady,
    uploadObject: async (path, bytes, contentType) => {
      const { error } = await storage.upload(path, bytes, {
        contentType,
        cacheControl: "31536000",
        upsert: true,
      });
      if (error) throw error; // core wraps into StorageUploadError
    },
    getPublicUrl: (path) => storage.getPublicUrl(path).data.publicUrl,
    updateRoasterMirrorUrl: async (roasterId, url) => {
      const { error } = await publicClient
        .from("coffee_roasters")
        .update({ roaster_logo_mirror_url: url })
        .eq("id", roasterId);
      if (error) {
        throw new DbError(
          `Failed to set roaster_logo_mirror_url: ${error.message}`,
        );
      }
    },
  };

  return {
    log: logger,
    loadRoasterSnapshot: async (roasterId) => {
      const { data, error } = await publicClient
        .from("coffee_roasters")
        .select(
          "id, roaster_name, normalized_name, normalized_aliases, roaster_logo_url, roaster_logo_mirror_url",
        )
        .eq("id", roasterId)
        .maybeSingle();
      if (error) {
        throw new DbError(
          `Failed to load roaster ${roasterId}: ${error.message}`,
        );
      }
      return (data as RoasterSnapshot | null);
    },
    processMirrorLogo: async (job, snapshot) => {
      await mirrorRoasterLogo(mirrorDeps, {
        roasterId: job.roaster_id,
        roasterName: snapshot.roaster_name ?? String(job.roaster_id),
        logoUrl: snapshot.roaster_logo_url,
      });
    },
    processExtractColor: async (job, snapshot) => {
      await extractRoasterDominantColor({
        fetchAsset: fetchLogoWithGuards,
        decodeColor: decodeColorWithImageMagick,
        ensureReady: ensureImageMagickReady,
        updateDominantColor: async (roasterId, hex) => {
          const { error } = await publicClient
            .from("coffee_roasters")
            .update({ dominant_color_hex: hex })
            .eq("id", roasterId);
          if (error) {
            throw new DbError(
              `Failed to set dominant_color_hex: ${error.message}`,
            );
          }
        },
      }, {
        roasterId: job.roaster_id,
        mirrorUrl: snapshot.roaster_logo_mirror_url,
      });
    },
    processAttachBeans: async (job) => {
      const { error } = await publicClient.rpc(
        "attach_pending_global_beans_for_roaster",
        { p_roaster_id: job.roaster_id },
      );
      if (error) {
        throw new DbError(
          `attach_pending_global_beans_for_roaster failed: ${error.message}`,
        );
      }
    },
    finishJob: async (job, outcome) => {
      const { error } = await serviceClient.rpc("finish_roaster_job", {
        p_job_id: job.id,
        p_owner: owner,
        p_success: outcome.success,
        p_error: outcome.success ? null : outcome.error,
        p_error_class: outcome.success
          ? (outcome.errorClass ?? null)
          : outcome.errorClass,
        p_terminal: outcome.success ? false : outcome.terminal,
      });
      if (error) {
        throw new DbError(`finish_roaster_job failed: ${error.message}`);
      }
    },
  };
}

Deno.serve(async (req: Request) => {
  const correlationId = generateCorrelationId();
  const corsHeaders = getCorsHeaders(req.headers.get("origin") ?? undefined);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return createSecureResponse(
      JSON.stringify({ error: "Method Not Allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const auth = extractAuthorization(req);
  if (!auth.authorized) {
    return createSecureResponse(
      JSON.stringify({ error: auth.error }),
      {
        status: auth.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // POST {} — body is optional; tolerate an entirely absent body.
  let body: Record<string, unknown> = {};
  const rawBody = await req.text();
  if (rawBody.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawBody);
      if (typeof parsed === "object" && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return createSecureResponse(
        JSON.stringify({ error: "Request body must be valid JSON." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  }

  const requestedLimit = typeof body.limit === "number"
    ? body.limit
    : DEFAULT_JOB_LIMIT;
  const limit = Math.max(
    1,
    Math.min(MAX_JOB_LIMIT, Math.floor(requestedLimit)),
  );

  // One owner per invocation ties every claim to exactly one finisher.
  const owner = `worker-${crypto.randomUUID()}`;
  const logger = workerLogger(correlationId);

  try {
    const { data, error } = await serviceClient.rpc("claim_roaster_jobs", {
      p_kinds: [...JOB_KINDS],
      p_limit: limit,
      p_owner: owner,
    });
    if (error) {
      throw new DbError(`claim_roaster_jobs failed: ${error.message}`);
    }

    const { jobs, malformed } = parseClaimedJobs(data);
    for (const row of malformed) {
      logger.warn(
        "claimed malformed job row — cannot finish without a valid id",
        {
          row,
        },
      );
    }

    const deps = buildRunnerDeps(owner, logger);
    const summary = await runBatch(deps, jobs);

    logInfo(
      `[${FUNCTION_NAME}] batch complete`,
      { summary, owner },
      correlationId,
    );
    flushLogsOnExit();
    return createSecureResponse(
      JSON.stringify(summary),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const classified = classifyFailure(error);
    logError(
      `[${FUNCTION_NAME}] invocation failed`,
      error instanceof Error ? error : new Error(errorToMessage(error)),
      ErrorCategory.DATABASE,
      ErrorSeverity.HIGH,
      { error_class: classified.errorClass, owner },
      correlationId,
    );
    flushLogsOnExit();
    return createSecureResponse(
      JSON.stringify({ error: errorToMessage(error) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
