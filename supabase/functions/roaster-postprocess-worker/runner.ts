/**
 * Batch runner for the roaster post-processing worker.
 *
 * Pure orchestration with all side effects injected (DB RPCs, image
 * pipeline, logging) so it is unit-testable without Supabase or network:
 *   - stale source-revision guard (never overwrite a newer logo);
 *   - image-job concurrency cap (mirror_logo + extract_color COMBINED);
 *   - attach_beans pool with its own higher concurrency;
 *   - generate_embedding pool with the same higher concurrency (a cheap
 *     network call, no ImageMagick working set);
 *   - per-job try/catch — one throwing job never takes down the invocation;
 *   - every claimed job is finished exactly once;
 *   - summary tally { claimed, succeeded, failed, retried, skipped }.
 */

import { classifyFailure, errorToMessage } from "./failure-classification.ts";

export const JOB_KINDS = [
  "mirror_logo",
  "extract_color",
  "attach_beans",
  "generate_embedding",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Image-job concurrency cap (mirror_logo + extract_color COMBINED).
 * The plan fixes this at 2 initially: each image job loads the ImageMagick
 * WASM pipeline whose decoded-pixel working set is the OOM risk that killed
 * the inline trigger path — parallel decodes multiply peak memory. Tune from
 * observed memory/duration before raising.
 */
export const IMAGE_JOB_CONCURRENCY = 2;

/** attach_beans only invokes a cheap DB RPC — safe to run 5 at a time. */
export const ATTACH_JOB_CONCURRENCY = 5;

/**
 * generate_embedding sits with attach_beans rather than the image cap: it is
 * a single OpenAI HTTP call with no ImageMagick working set, so its memory
 * profile is negligible and the real limit is provider rate limiting, not
 * peak memory.
 */
export const EMBEDDING_JOB_CONCURRENCY = 5;

/** A row of service.roaster_postprocess_jobs as returned by claim_roaster_jobs. */
export interface PostprocessJob {
  id: number;
  roaster_id: number;
  kind: JobKind;
  source_revision: string;
  attempts: number;
  correlation_id: string;
}

/** The coffee_roasters columns the runner needs, re-read at claim time. */
export interface RoasterSnapshot {
  id: number;
  roaster_name: string | null;
  /** Raw alias list — the generate_embedding input is built from this. */
  aliases: string | null;
  normalized_name: string | null;
  normalized_aliases: string | null;
  roaster_logo_url: string | null;
  roaster_logo_mirror_url: string | null;
}

export interface JobLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface RunnerDeps {
  log: JobLogger;
  loadRoasterSnapshot(roasterId: number): Promise<RoasterSnapshot | null>;
  processMirrorLogo(
    job: PostprocessJob,
    snapshot: RoasterSnapshot,
  ): Promise<void>;
  processExtractColor(
    job: PostprocessJob,
    snapshot: RoasterSnapshot,
  ): Promise<void>;
  processAttachBeans(
    job: PostprocessJob,
    snapshot: RoasterSnapshot,
  ): Promise<void>;
  processGenerateEmbedding(
    job: PostprocessJob,
    snapshot: RoasterSnapshot,
  ): Promise<void>;
  finishJob(job: PostprocessJob, outcome: FinishOutcome): Promise<void>;
}

export type FinishOutcome =
  | { success: true; errorClass?: string }
  | {
    success: false;
    error: string;
    errorClass: string;
    terminal: boolean;
  };

export interface RunSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
}

/**
 * Current identity of the input a job of `kind` would process.
 * MUST stay byte-identical to the source_revision semantics in the
 * `service.roaster_postprocess_jobs` contract:
 *   mirror_logo        -> coffee_roasters.roaster_logo_url
 *   extract_color      -> coffee_roasters.roaster_logo_mirror_url
 *   attach_beans       -> coalesce(normalized_name,'') || '|' || coalesce(normalized_aliases,'')
 *   generate_embedding -> coalesce(roaster_name,'') || '|' || coalesce(aliases,'')
 * (generate_embedding uses the RAW columns, not the normalized ones, because
 * the embedded text is built from the raw columns.)
 */
export function currentSourceRevision(
  kind: JobKind,
  snapshot: RoasterSnapshot,
): string {
  switch (kind) {
    case "mirror_logo":
      return snapshot.roaster_logo_url ?? "";
    case "extract_color":
      return snapshot.roaster_logo_mirror_url ?? "";
    case "attach_beans":
      return `${snapshot.normalized_name ?? ""}|${
        snapshot.normalized_aliases ?? ""
      }`;
    case "generate_embedding":
      return `${snapshot.roaster_name ?? ""}|${snapshot.aliases ?? ""}`;
  }
}

/**
 * Process a claimed batch. Never throws: job-level failures are finished as
 * retryable/terminal failures and reflected in the summary.
 */
export async function runBatch(
  deps: RunnerDeps,
  jobs: readonly PostprocessJob[],
): Promise<RunSummary> {
  const summary: RunSummary = {
    claimed: jobs.length,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
  };
  if (jobs.length === 0) return summary;

  const imageJobs = jobs.filter((job) => isImageJob(job.kind));
  const attachJobs = jobs.filter((job) => job.kind === "attach_beans");
  const embeddingJobs = jobs.filter((job) => job.kind === "generate_embedding");

  // The three pools run concurrently; the caps are per-pool so an attach or
  // embedding burst can never add to the image pipeline's peak memory.
  await Promise.all([
    runPool(deps, summary, imageJobs, IMAGE_JOB_CONCURRENCY),
    runPool(deps, summary, attachJobs, ATTACH_JOB_CONCURRENCY),
    runPool(deps, summary, embeddingJobs, EMBEDDING_JOB_CONCURRENCY),
  ]);
  return summary;
}

function isImageJob(kind: JobKind): boolean {
  return kind === "mirror_logo" || kind === "extract_color";
}

async function runPool(
  deps: RunnerDeps,
  summary: RunSummary,
  jobs: readonly PostprocessJob[],
  concurrency: number,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, jobs.length);
  const workers = Array.from(
    { length: workerCount },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= jobs.length) return;
        await processOne(deps, summary, jobs[index]);
      }
    },
  );
  await Promise.all(workers);
}

async function processOne(
  deps: RunnerDeps,
  summary: RunSummary,
  job: PostprocessJob,
): Promise<void> {
  const fields = jobLogFields(job);
  try {
    const snapshot = await deps.loadRoasterSnapshot(job.roaster_id);
    if (!snapshot) {
      deps.log.warn(
        "roaster row not found for job — finishing terminal",
        fields,
      );
      await finishSafely(deps, job, {
        success: false,
        error: `roaster ${job.roaster_id} not found`,
        errorClass: "roaster_missing",
        terminal: true,
      });
      summary.failed += 1;
      return;
    }

    // Stale source-revision guard: if the input this job was created for no
    // longer matches the current column value, a newer job already covers it.
    // Finishing as SUCCESS (no work) stops a slow retry from overwriting a
    // newer logo.
    const currentRevision = currentSourceRevision(job.kind, snapshot);
    if (!job.source_revision || currentRevision !== job.source_revision) {
      deps.log.info(
        "skipping job — stale source_revision, a newer job covers this input",
        { ...fields, current_revision: currentRevision },
      );
      await finishSafely(deps, job, {
        success: true,
        errorClass: "stale_revision",
      });
      summary.skipped += 1;
      return;
    }

    deps.log.info("processing job", fields);
    switch (job.kind) {
      case "mirror_logo":
        await deps.processMirrorLogo(job, snapshot);
        break;
      case "extract_color":
        await deps.processExtractColor(job, snapshot);
        break;
      case "attach_beans":
        await deps.processAttachBeans(job, snapshot);
        break;
      case "generate_embedding":
        await deps.processGenerateEmbedding(job, snapshot);
        break;
    }

    await finishSafely(deps, job, { success: true });
    summary.succeeded += 1;
  } catch (error) {
    const classified = classifyFailure(error);
    const message = errorToMessage(error);
    const logDetails = {
      ...fields,
      error_class: classified.errorClass,
      error: message,
    };
    if (classified.terminal) {
      deps.log.error("job failed terminally", logDetails);
    } else {
      deps.log.warn("job failed, scheduled for retry", logDetails);
    }
    await finishSafely(deps, job, {
      success: false,
      error: message,
      errorClass: classified.errorClass,
      terminal: classified.terminal,
    });
    if (classified.terminal) {
      summary.failed += 1;
    } else {
      summary.retried += 1;
    }
  }
}

/**
 * finish_roaster_job failures must never break the batch (or double-count a
 * job): the row simply stays 'running' until recover_stale_roaster_jobs
 * requeues it.
 */
async function finishSafely(
  deps: RunnerDeps,
  job: PostprocessJob,
  outcome: FinishOutcome,
): Promise<void> {
  try {
    await deps.finishJob(job, outcome);
  } catch (error) {
    deps.log.error("failed to finish job — left for stale-job recovery", {
      ...jobLogFields(job),
      outcome,
      error: errorToMessage(error),
    });
  }
}

/** job_id, roaster_id, kind, source_revision, attempt, correlation_id — every line. */
export function jobLogFields(job: PostprocessJob): Record<string, unknown> {
  return {
    job_id: job.id,
    roaster_id: job.roaster_id,
    kind: job.kind,
    source_revision: job.source_revision,
    attempt: job.attempts,
    correlation_id: job.correlation_id,
  };
}
