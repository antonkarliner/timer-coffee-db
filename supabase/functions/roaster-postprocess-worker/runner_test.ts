import {
  ATTACH_JOB_CONCURRENCY,
  currentSourceRevision,
  EMBEDDING_JOB_CONCURRENCY,
  type FinishOutcome,
  IMAGE_JOB_CONCURRENCY,
  jobLogFields,
  type PostprocessJob,
  type RoasterSnapshot,
  runBatch,
  type RunnerDeps,
  type RunSummary,
} from "./runner.ts";
import { StorageUploadError } from "../_shared/roaster-postprocess-errors.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function makeJob(overrides: Partial<PostprocessJob> = {}): PostprocessJob {
  return {
    id: 1,
    roaster_id: 42,
    kind: "mirror_logo",
    source_revision: "https://src/logo.png",
    attempts: 1,
    correlation_id: "00000000-0000-0000-0000-000000000000",
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<RoasterSnapshot> = {},
): RoasterSnapshot {
  return {
    id: 42,
    roaster_name: "Test Roaster",
    aliases: "Test Alias",
    normalized_name: "test roaster",
    normalized_aliases: "test",
    roaster_logo_url: "https://src/logo.png",
    roaster_logo_mirror_url: null,
    ...overrides,
  };
}

interface Recorded {
  processed: PostprocessJob[];
  finishes: Array<{ job: PostprocessJob; outcome: FinishOutcome }>;
  logs: string[];
}

function stubDeps(
  snapshots: Map<number, RoasterSnapshot | null>,
  handlers: {
    mirror?: (job: PostprocessJob) => Promise<void>;
    extract?: (job: PostprocessJob) => Promise<void>;
    attach?: (job: PostprocessJob) => Promise<void>;
    embed?: (job: PostprocessJob) => Promise<void>;
  } = {},
): { deps: RunnerDeps; recorded: Recorded } {
  const recorded: Recorded = { processed: [], finishes: [], logs: [] };
  const deps: RunnerDeps = {
    log: {
      info: (m) => recorded.logs.push(`info: ${m}`),
      warn: (m) => recorded.logs.push(`warn: ${m}`),
      error: (m) => recorded.logs.push(`error: ${m}`),
    },
    loadRoasterSnapshot: async (roasterId) => snapshots.get(roasterId) ?? null,
    processMirrorLogo: async (job) => {
      recorded.processed.push(job);
      await handlers.mirror?.(job);
    },
    processExtractColor: async (job) => {
      recorded.processed.push(job);
      await handlers.extract?.(job);
    },
    processAttachBeans: async (job) => {
      recorded.processed.push(job);
      await handlers.attach?.(job);
    },
    processGenerateEmbedding: async (job) => {
      recorded.processed.push(job);
      await handlers.embed?.(job);
    },
    finishJob: async (job, outcome) => {
      recorded.finishes.push({ job, outcome });
    },
  };
  return { deps, recorded };
}

function outcomeOf(
  recorded: Recorded,
  jobId: number,
): FinishOutcome | undefined {
  return recorded.finishes.find((f) => f.job.id === jobId)?.outcome;
}

Deno.test("currentSourceRevision follows the contract exactly", () => {
  const snapshot = makeSnapshot({
    roaster_logo_url: "https://a.png",
    roaster_logo_mirror_url: "https://m.webp",
    normalized_name: "name",
    normalized_aliases: "alias one,alias two",
  });
  assertEquals(
    currentSourceRevision("mirror_logo", snapshot),
    "https://a.png",
    "mirror_logo → roaster_logo_url",
  );
  assertEquals(
    currentSourceRevision("extract_color", snapshot),
    "https://m.webp",
    "extract_color → roaster_logo_mirror_url",
  );
  assertEquals(
    currentSourceRevision("attach_beans", snapshot),
    "name|alias one,alias two",
    "attach_beans → coalesce(name)||'|'||coalesce(aliases)",
  );
  assertEquals(
    currentSourceRevision(
      "attach_beans",
      makeSnapshot({ normalized_name: null, normalized_aliases: null }),
    ),
    "|",
    "null name/aliases coalesce to empty strings",
  );
  assertEquals(
    currentSourceRevision("generate_embedding", snapshot),
    "Test Roaster|Test Alias",
    "generate_embedding → coalesce(roaster_name)||'|'||coalesce(aliases) on the RAW columns",
  );
  assertEquals(
    currentSourceRevision(
      "generate_embedding",
      makeSnapshot({ roaster_name: "Swerl", aliases: "TW, TW Oslo" }),
    ),
    "Swerl|TW, TW Oslo",
    "generate_embedding keeps the raw alias text verbatim",
  );
  assertEquals(
    currentSourceRevision(
      "generate_embedding",
      makeSnapshot({ roaster_name: null, aliases: null }),
    ),
    "|",
    "generate_embedding: null name/aliases coalesce to empty strings",
  );
});

Deno.test("stale source_revision finishes as success and performs NO external work", async () => {
  // The snapshot's logo has moved on since the job was enqueued.
  const { deps, recorded } = stubDeps(
    new Map([[
      42,
      makeSnapshot({ roaster_logo_url: "https://src/newer-logo.png" }),
    ]]),
    {
      mirror: async () => {
        throw new Error("TRIPWIRE: no external work may run for a stale job");
      },
    },
  );
  const summary = await runBatch(deps, [
    makeJob({ source_revision: "https://src/logo.png" }),
  ]);
  assertEquals(recorded.processed.length, 0, "tripwire not hit");
  assertEquals(
    outcomeOf(recorded, 1),
    { success: true, errorClass: "stale_revision" },
    "finished as success with the stale_revision marker",
  );
  assertEquals(
    summary,
    { claimed: 1, succeeded: 0, failed: 0, retried: 0, skipped: 1 },
    "counted as skipped",
  );
});

Deno.test("a matching revision processes and finishes as success", async () => {
  const { deps, recorded } = stubDeps(new Map([[42, makeSnapshot()]]));
  const summary = await runBatch(deps, [makeJob()]);
  assertEquals(recorded.processed.length, 1, "processor ran");
  assertEquals(outcomeOf(recorded, 1), { success: true }, "plain success");
  assertEquals(
    summary,
    { claimed: 1, succeeded: 1, failed: 0, retried: 0, skipped: 0 },
    "counted as succeeded",
  );
});

Deno.test("a missing roaster row finishes terminally as roaster_missing", async () => {
  const { deps, recorded } = stubDeps(new Map([[42, null]]));
  const summary = await runBatch(deps, [makeJob()]);
  assertEquals(
    outcomeOf(recorded, 1),
    {
      success: false,
      error: "roaster 42 not found",
      errorClass: "roaster_missing",
      terminal: true,
    },
    "terminal failure",
  );
  assertEquals(summary.failed, 1, "counted as failed");
});

Deno.test("retryable failures finish with terminal=false and count as retried", async () => {
  const { deps, recorded } = stubDeps(new Map([[42, makeSnapshot()]]), {
    mirror: async () => {
      throw new StorageUploadError("Storage upload failed: bucket offline");
    },
  });
  const summary = await runBatch(deps, [makeJob()]);
  assertEquals(
    outcomeOf(recorded, 1),
    {
      success: false,
      error: "Storage upload failed: bucket offline",
      errorClass: "storage_upload_failed",
      terminal: false,
    },
    "retryable outcome for the ledger",
  );
  assertEquals(
    summary,
    { claimed: 1, succeeded: 0, failed: 0, retried: 1, skipped: 0 },
    "counted as retried",
  );
});

Deno.test("terminal failures finish with terminal=true and count as failed", async () => {
  const { SourceTooLargeError } = await import(
    "../_shared/roaster-postprocess-errors.ts"
  );
  const { deps, recorded } = stubDeps(new Map([[42, makeSnapshot()]]), {
    mirror: async () => {
      throw new SourceTooLargeError(
        "source_too_large: 6543x6543 (42.8 Mpx) exceeds 16 Mpx cap — replace roaster_logo_url",
      );
    },
  });
  const summary = await runBatch(deps, [makeJob()]);
  const outcome = outcomeOf(recorded, 1);
  assertEquals(
    outcome && outcome.success === false && outcome.terminal,
    true,
    "source_too_large finishes terminal",
  );
  assertEquals(summary.failed, 1, "counted as failed");
  assertEquals(summary.retried, 0, "not retried");
});

Deno.test("one throwing job never takes down the batch", async () => {
  const { deps, recorded } = stubDeps(
    new Map([
      [42, makeSnapshot()],
      [43, makeSnapshot({ id: 43, roaster_logo_url: "https://src/two.png" })],
    ]),
    {
      mirror: async (job) => {
        if (job.roaster_id === 42) throw new Error("exploding job");
      },
    },
  );
  const summary = await runBatch(deps, [
    makeJob({ id: 1, roaster_id: 42 }),
    makeJob({ id: 2, roaster_id: 43, source_revision: "https://src/two.png" }),
  ]);
  assertEquals(summary.succeeded, 1, "healthy job still succeeded");
  assertEquals(summary.retried, 1, "exploding job retried");
  assertEquals(recorded.finishes.length, 2, "every job finished exactly once");
});

Deno.test("attach_beans jobs route to their processor and pool", async () => {
  const { deps, recorded } = stubDeps(new Map([[42, makeSnapshot()]]), {
    attach: async () => {},
  });
  const summary = await runBatch(deps, [
    makeJob({ kind: "attach_beans", source_revision: "test roaster|test" }),
  ]);
  assertEquals(recorded.processed.length, 1, "attach processor ran");
  assertEquals(summary.succeeded, 1, "succeeded");
});

Deno.test("generate_embedding jobs route to their processor and pool", async () => {
  const { deps, recorded } = stubDeps(new Map([[42, makeSnapshot()]]), {
    embed: async () => {},
  });
  const summary = await runBatch(deps, [
    makeJob({
      kind: "generate_embedding",
      source_revision: "Test Roaster|Test Alias",
    }),
  ]);
  assertEquals(
    recorded.processed.length,
    1,
    "generate_embedding processor ran",
  );
  assertEquals(
    outcomeOf(recorded, 1),
    { success: true },
    "finished as success",
  );
  assertEquals(summary.succeeded, 1, "counted as succeeded");
});

Deno.test("a stale generate_embedding source_revision finishes as success with NO embedding work", async () => {
  // The roaster's name has moved on since the job was enqueued; a newer job
  // already covers the current input.
  const { deps, recorded } = stubDeps(
    new Map([[
      42,
      makeSnapshot({ roaster_name: "Renamed Roaster", aliases: "New Alias" }),
    ]]),
    {
      embed: async () => {
        throw new Error("TRIPWIRE: no external work may run for a stale job");
      },
    },
  );
  const summary = await runBatch(deps, [
    makeJob({
      kind: "generate_embedding",
      source_revision: "Test Roaster|Test Alias",
    }),
  ]);
  assertEquals(recorded.processed.length, 0, "tripwire not hit");
  assertEquals(
    outcomeOf(recorded, 1),
    { success: true, errorClass: "stale_revision" },
    "finished as success with the stale_revision marker",
  );
  assertEquals(
    summary,
    { claimed: 1, succeeded: 0, failed: 0, retried: 0, skipped: 1 },
    "counted as skipped",
  );
});

Deno.test("generate_embedding pool concurrency is capped at 5", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
  const { deps } = stubDeps(new Map([[42, makeSnapshot()]]), {
    embed: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay();
      inFlight -= 1;
    },
  });
  const jobs = Array.from(
    { length: 12 },
    (_, i) =>
      makeJob({
        id: i + 1,
        kind: "generate_embedding",
        source_revision: "Test Roaster|Test Alias",
      }),
  );
  await runBatch(deps, jobs);
  assertEquals(
    maxInFlight,
    EMBEDDING_JOB_CONCURRENCY,
    `peak concurrent embedding jobs = cap (${EMBEDDING_JOB_CONCURRENCY})`,
  );
});

Deno.test("image-job concurrency is capped at 2 across BOTH image kinds combined", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const { deps } = stubDeps(
    new Map([[
      42,
      makeSnapshot({ roaster_logo_mirror_url: "https://src/logo.png" }),
    ]]),
    {
      mirror: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay();
        inFlight -= 1;
      },
      extract: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay();
        inFlight -= 1;
      },
    },
  );
  const jobs = Array.from({ length: 6 }, (_, i) =>
    makeJob({
      id: i + 1,
      kind: i % 2 === 0 ? "mirror_logo" : "extract_color",
    }));
  const summary = await runBatch(deps, jobs);
  assertEquals(
    maxInFlight,
    IMAGE_JOB_CONCURRENCY,
    `peak concurrent image jobs = cap (${IMAGE_JOB_CONCURRENCY})`,
  );
  assertEquals(summary.succeeded, 6, "all jobs still completed");
  assertEquals(IMAGE_JOB_CONCURRENCY, 2, "the plan fixes the cap at 2");
});

Deno.test("attach_beans pool concurrency is capped at 5", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
  const { deps } = stubDeps(new Map([[42, makeSnapshot()]]), {
    attach: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay();
      inFlight -= 1;
    },
  });
  const jobs = Array.from(
    { length: 12 },
    (_, i) =>
      makeJob({
        id: i + 1,
        kind: "attach_beans",
        source_revision: "test roaster|test",
      }),
  );
  await runBatch(deps, jobs);
  assertEquals(
    maxInFlight,
    ATTACH_JOB_CONCURRENCY,
    `peak concurrent attach jobs = cap (${ATTACH_JOB_CONCURRENCY})`,
  );
});

Deno.test("every log line carries job_id, roaster_id, kind, source_revision, attempt, correlation_id", async () => {
  const { deps, recorded } = stubDeps(new Map([[42, makeSnapshot()]]));
  await runBatch(deps, [
    makeJob({ id: 77, attempts: 3, correlation_id: "corr-1" }),
  ]);
  assertEquals(
    jobLogFields(makeJob({ id: 77, attempts: 3, correlation_id: "corr-1" })),
    {
      job_id: 77,
      roaster_id: 42,
      kind: "mirror_logo",
      source_revision: "https://src/logo.png",
      attempt: 3,
      correlation_id: "corr-1",
    },
    "jobLogFields shape",
  );
  assertEquals(
    recorded.logs.some((line) => line.includes("processing job")),
    true,
    "processing is logged",
  );
});

Deno.test("a finishJob failure does not break the batch or double-count", async () => {
  const snapshots = new Map([[42, makeSnapshot()]]);
  const recorded: Recorded = { processed: [], finishes: [], logs: [] };
  const deps: RunnerDeps = {
    log: {
      info: (m) => recorded.logs.push(`info: ${m}`),
      warn: (m) => recorded.logs.push(`warn: ${m}`),
      error: (m) => recorded.logs.push(`error: ${m}`),
    },
    loadRoasterSnapshot: async (id) => snapshots.get(id) ?? null,
    processMirrorLogo: async () => {},
    processExtractColor: async () => {},
    processAttachBeans: async () => {},
    processGenerateEmbedding: async () => {},
    finishJob: async () => {
      throw new Error("finish RPC down");
    },
  };
  const summary: RunSummary = await runBatch(deps, [makeJob()]);
  assertEquals(
    summary.succeeded,
    1,
    "job tallied as succeeded (work completed)",
  );
  assertEquals(
    recorded.logs.some((line) =>
      line.includes("failed to finish job — left for stale-job recovery")
    ),
    true,
    "finish failure logged; stale recovery owns the row",
  );
});

Deno.test("empty claim produces a zero summary", async () => {
  const { deps } = stubDeps(new Map());
  const summary = await runBatch(deps, []);
  assertEquals(
    summary,
    { claimed: 0, succeeded: 0, failed: 0, retried: 0, skipped: 0 },
    "zero summary",
  );
});
