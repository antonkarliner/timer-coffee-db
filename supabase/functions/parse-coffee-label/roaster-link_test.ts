import type {
  JevAskOptions,
  JevChoiceAnswer,
  JevChoiceQuestion,
} from "../_shared/jev-client.ts";
import type { Json } from "../_shared/types.ts";
// Type-only import: erased at compile time, so it does NOT evaluate
// roaster-link.ts before the env vars below are set.
import type {
  CandidateRow,
  RoasterLinkDb,
  RoasterLinkDeps,
  RoasterMeta,
} from "./roaster-link.ts";

// monitoring.ts — pulled in by roaster-link.ts for structured logging —
// evaluates ENVIRONMENT_CONFIG at module load, which requires the core
// Supabase/Firebase/CRON variables to be present even when they are never
// used. These are fabricated test values, not real secrets. They must be set
// BEFORE the dynamic import below: a static import would evaluate
// roaster-link.ts (and therefore monitoring.ts) before this module body runs.
Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", `eyJ${"t".repeat(120)}`);
Deno.env.set(
  "FIREBASE_SERVICE_ACCOUNT",
  JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key: "test-private-key",
    client_email: "test@test.iam.gserviceaccount.com",
  }),
);
Deno.env.set("CRON_JOB_SECRET", "s".repeat(40));
Deno.env.set("ALLOWED_ORIGINS", "https://a.test,https://b.test");

const {
  buildCriteria,
  buildJevState,
  DEFAULT_LINK_THRESHOLD,
  decideLink,
  MAX_CANDIDATES,
  mergeCandidates,
  normalizeForSearch,
  readRoasterLinkMode,
  resolveMode,
  ROASTER_LINK_FLAG_ENFORCE,
  ROASTER_LINK_FLAG_SHADOW,
  ROASTER_LINK_JEV_INSTRUCTIONS,
  ROASTER_LINK_NONE_DESCRIPTION,
  runRoasterLink,
} = await import("./roaster-link.ts");

// Types come from the erased import above; values come from the dynamic
// import below so monitoring.ts only evaluates after the env is set.

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(
  actual: T,
  expected: T,
  message = "values must be equal",
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LABEL_RESULT = {
  roaster: "Phoenix Coffee Roasters",
  roasterBrandName: "Phoenix",
  name: "Ethiopia Yirgacheffe",
  origin: "Ethiopia",
  region: "Yirgacheffe",
  variety: "Heirloom",
  tastingNotes: "Floral, Lemon",
  roastDate: "2026-06-01",
  // Fields that must NEVER reach the Jev state:
  userId: "user-123",
  locale: "de-DE",
  ocrText: "PHOENIX COFFEE ROASTERS GMBH",
  imagesBase64: ["aGVsbG8="],
};

/** Raw rows exactly as public.find_potential_roaster_matches returns them. */
const PHOENIX_RPC_ROWS: Array<Record<string, unknown>> = [
  {
    roaster_id: 42,
    roaster_name: "Phoenix Coffee Roasters",
    confidence: 0.9,
    match_method: "normalized_name",
  },
  {
    roaster_id: 7,
    roaster_name: "Acme Coffee",
    confidence: 0.2,
    match_method: "trigram",
  },
];

const PHOENIX_META: Array<Record<string, unknown>> = [
  {
    id: 42,
    roaster_name: "Phoenix Coffee Roasters",
    city: "Portland",
    country: "United States",
    aliases: "Phx Roastery",
  },
  {
    id: 7,
    roaster_name: "Acme Coffee",
    city: null,
    country: null,
    aliases: null,
  },
];

const CONFIDENT_ANSWER: JevChoiceAnswer = {
  type: "choice",
  choice: "42",
  probabilities: { "42": 0.95, "7": 0.01, "__none__": 0.04 },
  confidence: 0.87,
};

function choiceAnswer(
  choice: string,
  p: number,
): JevChoiceAnswer {
  return {
    type: "choice",
    choice,
    probabilities: { [choice]: p, "__none__": 1 - p },
    confidence: 0.5,
  };
}

// ---------------------------------------------------------------------------
// Stubs (no network anywhere: db and jevChoose are injected)
// ---------------------------------------------------------------------------

interface DbStubConfig {
  /** Raw RPC rows per call, in order; missing entries -> null (empty). */
  rpcResults?: Array<Array<Record<string, unknown>> | null>;
  rpcThrows?: Error;
  /** Scalar resolve_coffee_roaster_id result; undefined -> null (no match). */
  resolverResult?: unknown;
  resolverError?: { message: string } | null;
  resolverThrows?: Error;
  metaRows?: Array<Record<string, unknown>>;
  insertError?: { message: string } | null;
  insertRejects?: Error;
  flagRows?: Array<Record<string, unknown>>;
  flagError?: { message: string } | null;
}

function makeDbStub(config: DbStubConfig = {}) {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const resolverCalls: Array<Record<string, unknown>> = [];
  const insertedRows: Array<Record<string, unknown>> = [];
  const metaQueries: Array<(string | number)[]> = [];
  const flagQueries: string[][] = [];
  let rpcIndex = 0;

  const insertHandler = (row: Record<string, unknown>) => {
    insertedRows.push(row);
    if (config.insertRejects) return Promise.reject(config.insertRejects);
    return Promise.resolve({ data: null, error: config.insertError ?? null });
  };

  const db: RoasterLinkDb = {
    schema(schema: string) {
      return {
        from(table: string) {
          void schema;
          if (table === "feature_flags") {
            return {
              insert: insertHandler,
              select(_columns: string) {
                return {
                  in(_column: string, values: (string | number)[]) {
                    flagQueries.push(values.map(String));
                    return Promise.resolve({
                      data: config.flagError ? null : config.flagRows ?? [],
                      error: config.flagError ?? null,
                    });
                  },
                };
              },
            };
          }
          return {
            insert: insertHandler,
            select(_columns: string) {
              return {
                in(_column: string, _values: (string | number)[]) {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
      };
    },
    from(_table: string) {
      return {
        select(_columns: string) {
          return {
            in(_column: string, values: (string | number)[]) {
              metaQueries.push([...values]);
              return Promise.resolve({
                data: config.metaRows ?? [],
                error: null,
              });
            },
          };
        },
        insert: insertHandler,
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      // The resolver runs concurrently with retrieval, so RPCs must dispatch
      // on function name, not call order.
      if (fn === "resolve_coffee_roaster_id") {
        resolverCalls.push(args);
        if (config.resolverThrows) return Promise.reject(config.resolverThrows);
        if (config.resolverError) {
          return Promise.resolve({ data: null, error: config.resolverError });
        }
        return Promise.resolve({
          data: config.resolverResult === undefined
            ? null
            : config.resolverResult,
          error: null,
        });
      }
      if (config.rpcThrows) return Promise.reject(config.rpcThrows);
      rpcCalls.push(args);
      const result = config.rpcResults
        ? config.rpcResults[rpcIndex] ?? null
        : [];
      rpcIndex++;
      return Promise.resolve({ data: result, error: null });
    },
  };
  return {
    db,
    rpcCalls,
    resolverCalls,
    insertedRows,
    metaQueries,
    flagQueries,
  };
}

interface JevStub {
  calls: Array<{
    state: Record<string, string>;
    question: JevChoiceQuestion;
    opts?: JevAskOptions;
  }>;
  jevChoose: (
    state: Json,
    question: JevChoiceQuestion,
    opts?: JevAskOptions,
  ) => Promise<JevChoiceAnswer | null>;
}

function makeJevStub(answer: JevChoiceAnswer | null): JevStub {
  const calls: JevStub["calls"] = [];
  return {
    calls,
    jevChoose: (state, question, opts) => {
      calls.push({ state: state as Record<string, string>, question, opts });
      return Promise.resolve(answer);
    },
  };
}

function makeDeps(db: RoasterLinkDb, jev: JevStub): RoasterLinkDeps {
  return { db, jevChoose: jev.jevChoose };
}

/**
 * Capture console.info while fn() runs (monitoring.logInfo writes there),
 * restoring it even when fn() rejects.
 */
async function captureConsoleInfo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: Array<{ message: string; details: unknown }> }> {
  const logs: Array<{ message: string; details: unknown }> = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    logs.push({ message: String(args[0]), details: args[1] });
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.info = original;
  }
}

/**
 * monitoring.ts schedules a deferred log-flush timer on every logInfo /
 * logError call (and a module-level flush interval), so Deno's ops sanitizer
 * would fail every test that logs with a leaked-timer error. Disabling the
 * sanitizers here is deliberate and confined to this suite (same approach as
 * _shared/jev-client_test.ts).
 */
function rlTest(name: string, fn: () => Promise<void> | void): void {
  Deno.test({
    name,
    fn,
    sanitizeOps: false,
    sanitizeResources: false,
  });
}

// ---------------------------------------------------------------------------
// normalizeForSearch
// ---------------------------------------------------------------------------

rlTest(
  "normalizeForSearch mirrors lower(unaccent()) for accented Latin",
  () => {
    assertEquals(
      normalizeForSearch("Café Rösterei"),
      "cafe rosterei",
      "accents must decompose and strip before lowercasing",
    );
  },
);

rlTest("normalizeForSearch lowercases non-Latin scripts", () => {
  assertEquals(
    normalizeForSearch("КИЕВ Киев"),
    "киев киев",
    "Cyrillic must lowercase; there are no combining marks to strip",
  );
});

rlTest("normalizeForSearch trims surrounding whitespace", () => {
  assertEquals(
    normalizeForSearch("  Phoenix  "),
    "phoenix",
    "trim keeps whitespace variance out of equality comparisons",
  );
});

// ---------------------------------------------------------------------------
// mergeCandidates
// ---------------------------------------------------------------------------

rlTest(
  "mergeCandidates dedupes by roaster_id keeping the highest confidence",
  () => {
    const merged = mergeCandidates([
      [
        { roasterId: 1, roasterName: "A", confidence: 0.5 },
        { roasterId: 2, roasterName: "B", confidence: 0.3 },
      ],
      [
        { roasterId: 1, roasterName: "A", confidence: 0.8 },
        { roasterId: 3, roasterName: "C", confidence: 0.1 },
      ],
    ]);
    assertEquals(
      merged,
      [
        { roasterId: 1, roasterName: "A", confidence: 0.8 },
        { roasterId: 2, roasterName: "B", confidence: 0.3 },
        { roasterId: 3, roasterName: "C", confidence: 0.1 },
      ],
      "union by id, max confidence, sorted descending",
    );
  },
);

rlTest("mergeCandidates caps at 40 by default and sorts descending", () => {
  const big: CandidateRow[] = Array.from({ length: 45 }, (_, i) => ({
    roasterId: i + 1,
    roasterName: `R${i + 1}`,
    confidence: i / 100,
  }));
  const merged = mergeCandidates([big]);
  assertEquals(merged.length, MAX_CANDIDATES, "default cap is 40");
  assertEquals(
    merged[0].confidence,
    0.44,
    "highest confidence survives the cap",
  );
  for (let i = 1; i < merged.length; i++) {
    assert(
      merged[i - 1].confidence >= merged[i].confidence,
      "merged list must be sorted descending by confidence",
    );
  }
});

rlTest(
  "mergeCandidates tolerates null/undefined lists and malformed rows",
  () => {
    const merged = mergeCandidates([
      null,
      undefined,
      [
        // deno-lint-ignore no-explicit-any
        { roasterId: "junk", confidence: 1 } as any,
        { roasterId: 5, roasterName: "Ok", confidence: 0.4 },
      ],
    ]);
    assertEquals(
      merged,
      [{ roasterId: 5, roasterName: "Ok", confidence: 0.4 }],
      "malformed rows are dropped, empty lists are skipped",
    );
  },
);

// ---------------------------------------------------------------------------
// buildCriteria
// ---------------------------------------------------------------------------

rlTest("buildCriteria formats full descriptions and appends __none__", () => {
  const metaById = new Map<number, RoasterMeta>([
    [42, {
      roasterName: "Phoenix Coffee Roasters",
      city: "Portland",
      country: "United States",
      aliases: "Phx Roastery",
    }],
  ]);
  const question = buildCriteria(
    [{
      roasterId: 42,
      roasterName: "Phoenix Coffee Roasters",
      confidence: 0.9,
    }],
    metaById,
  );
  assertEquals(
    question.instructions,
    ROASTER_LINK_JEV_INSTRUCTIONS,
    "instructions must be the module's fixed string",
  );
  assertEquals(
    question.criteria["42"],
    "Phoenix Coffee Roasters — Portland, United States. Also known as: Phx Roastery.",
    "full description format",
  );
  assertEquals(
    question.criteria["__none__"],
    ROASTER_LINK_NONE_DESCRIPTION,
    "__none__ must be appended with the exact reserved description",
  );
  assertEquals(
    Object.keys(question.criteria).sort(),
    ["42", "__none__"],
    "option keys are String(roaster_id) plus __none__",
  );
});

rlTest("buildCriteria omits absent city/country/aliases cleanly", () => {
  const question = buildCriteria(
    [
      { roasterId: 7, roasterName: "Acme Coffee", confidence: 0.2 },
      { roasterId: 8, roasterName: "City Only", confidence: 0.1 },
    ],
    new Map([
      [7, {
        roasterName: "Acme Coffee",
        city: null,
        country: null,
        aliases: null,
      }],
      [8, {
        roasterName: "City Only",
        city: "Ljubljana",
        country: null,
        aliases: null,
      }],
    ]),
  );
  assertEquals(
    question.criteria["7"],
    "Acme Coffee.",
    "no location and no aliases: bare name plus period",
  );
  assertEquals(
    question.criteria["8"],
    "City Only — Ljubljana.",
    "city without country: only the city is listed",
  );
  assertEquals(
    question.criteria["__none__"],
    ROASTER_LINK_NONE_DESCRIPTION,
    "__none__ is still appended",
  );
});

rlTest(
  "buildCriteria falls back to the candidate name when metadata is missing",
  () => {
    const question = buildCriteria(
      [{ roasterId: 99, roasterName: "Only From RPC", confidence: 0.5 }],
      new Map(),
    );
    assertEquals(
      question.criteria["99"],
      "Only From RPC.",
      "metadata is an enrichment, not a requirement",
    );
  },
);

// ---------------------------------------------------------------------------
// buildJevState
// ---------------------------------------------------------------------------

rlTest("buildJevState carries the parsed bag fields into the state", () => {
  const state = buildJevState(LABEL_RESULT);
  assertEquals(
    state,
    {
      roaster: "Phoenix Coffee Roasters",
      roasterBrandName: "Phoenix",
      name: "Ethiopia Yirgacheffe",
      origin: "Ethiopia",
      region: "Yirgacheffe",
      variety: "Heirloom",
      tastingNotes: "Floral, Lemon",
    },
    "the seven measured-disambiguation fields, and only those",
  );
});

rlTest("buildJevState omits null and empty values", () => {
  const state = buildJevState({
    roaster: "Acme",
    name: null,
    origin: "",
    region: "   ",
    variety: undefined,
  });
  assertEquals(
    state,
    { roaster: "Acme" },
    "null/empty/whitespace fields must be omitted, not sent",
  );
});

rlTest(
  "buildJevState never includes userId, locale, images or OCR text",
  () => {
    const state = buildJevState(LABEL_RESULT);
    for (
      const forbidden of [
        "userId",
        "locale",
        "ocrText",
        "imagesBase64",
        "roastDate",
      ]
    ) {
      assert(
        !(forbidden in state),
        `${forbidden} must never be sent to the third-party Jev API`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// decideLink
// ---------------------------------------------------------------------------

rlTest("decideLink links at p >= 0.9 only", () => {
  assertEquals(
    decideLink(choiceAnswer("42", 0.89)),
    null,
    "p = 0.89 is below the auto-link threshold",
  );
  assertEquals(
    decideLink(choiceAnswer("42", 0.9)),
    { roasterId: 42, p: 0.9 },
    "p = 0.9 is exactly at the threshold and links",
  );
  assertEquals(
    decideLink(choiceAnswer("42", 0.95)),
    { roasterId: 42, p: 0.95 },
    "p = 0.95 links",
  );
});

rlTest("decideLink never links __none__, whatever its probability", () => {
  assertEquals(
    decideLink(choiceAnswer("__none__", 0.99)),
    null,
    "__none__ at p = 0.99 is an abstention, not a link",
  );
});

rlTest(
  "decideLink rejects non-numeric choices and honours a custom threshold",
  () => {
    assertEquals(
      decideLink(choiceAnswer("junk", 0.99)),
      null,
      "a non-roaster-id choice cannot become a link",
    );
    assertEquals(
      decideLink(choiceAnswer("42", 0.75), 0.7),
      { roasterId: 42, p: 0.75 },
      "an explicit lower threshold links at 0.75",
    );
    assertEquals(
      DEFAULT_LINK_THRESHOLD,
      0.9,
      "the default threshold is the measured 0.9",
    );
  },
);

// ---------------------------------------------------------------------------
// resolveMode / readRoasterLinkMode
// ---------------------------------------------------------------------------

rlTest("resolveMode maps the four flag combinations", () => {
  const off = { key: ROASTER_LINK_FLAG_SHADOW, enabled: false };
  const shadowOn = { key: ROASTER_LINK_FLAG_SHADOW, enabled: true };
  const linkOff = { key: ROASTER_LINK_FLAG_ENFORCE, enabled: false };
  const linkOn = { key: ROASTER_LINK_FLAG_ENFORCE, enabled: true };
  assertEquals(resolveMode([off, linkOff]), "off", "both off -> off");
  assertEquals(
    resolveMode([shadowOn, linkOff]),
    "shadow",
    "shadow only -> shadow",
  );
  assertEquals(
    resolveMode([off, linkOn]),
    "enforce",
    "enforce only -> enforce",
  );
  assertEquals(
    resolveMode([shadowOn, linkOn]),
    "enforce",
    "enforce wins when both are on (it also logs)",
  );
  assertEquals(resolveMode([]), "off", "no rows -> off");
  assertEquals(resolveMode([null]), "off", "malformed rows -> off");
});

rlTest(
  "readRoasterLinkMode resolves from the service.feature_flags table",
  async () => {
    const shadowStub = makeDbStub({
      flagRows: [
        { key: ROASTER_LINK_FLAG_SHADOW, enabled: true },
        { key: ROASTER_LINK_FLAG_ENFORCE, enabled: false },
      ],
    });
    assertEquals(
      await readRoasterLinkMode(shadowStub.db),
      "shadow",
      "shadow flag on, enforce off -> shadow",
    );
    assertEquals(
      shadowStub.flagQueries,
      [[ROASTER_LINK_FLAG_SHADOW, ROASTER_LINK_FLAG_ENFORCE]],
      "exactly the two flag keys are queried",
    );

    const enforceStub = makeDbStub({
      flagRows: [
        { key: ROASTER_LINK_FLAG_SHADOW, enabled: true },
        { key: ROASTER_LINK_FLAG_ENFORCE, enabled: true },
      ],
    });
    assertEquals(
      await readRoasterLinkMode(enforceStub.db),
      "enforce",
      "enforce flag wins when both are on",
    );

    const bothOffStub = makeDbStub({
      flagRows: [
        { key: ROASTER_LINK_FLAG_SHADOW, enabled: false },
        { key: ROASTER_LINK_FLAG_ENFORCE, enabled: false },
      ],
    });
    assertEquals(
      await readRoasterLinkMode(bothOffStub.db),
      "off",
      "both flags off -> off",
    );

    const errorStub = makeDbStub({ flagError: { message: "boom" } });
    assertEquals(
      await readRoasterLinkMode(errorStub.db),
      "off",
      "a failed flag read fails closed to off",
    );
  },
);

// ---------------------------------------------------------------------------
// runRoasterLink — skips
// ---------------------------------------------------------------------------

rlTest(
  "runRoasterLink skips silently when the roaster is empty or the result is an error envelope",
  async () => {
    const db = makeDbStub();
    const jev = makeJevStub(CONFIDENT_ANSWER);
    for (
      const result of [
        { error: "No coffee labels detected" },
        { roaster: null },
        { roaster: "   " },
        {},
        null,
      ]
    ) {
      const link = await runRoasterLink(makeDeps(db.db, jev), result, {
        mode: "shadow",
        correlationId: "req-1",
      });
      assertEquals(link, null, `no link for ${JSON.stringify(result)}`);
    }
    assertEquals(
      db.rpcCalls.length,
      0,
      "the skip path must not touch the database",
    );
    assertEquals(
      db.resolverCalls.length,
      0,
      "the skip path must not call the deterministic resolver",
    );
    assertEquals(jev.calls.length, 0, "the skip path must not call Jev");
    assertEquals(
      db.insertedRows.length,
      0,
      "the skip path writes no eval row (no DB at all)",
    );
  },
);

rlTest("runRoasterLink mode off does nothing at all", async () => {
  const db = makeDbStub();
  const jev = makeJevStub(CONFIDENT_ANSWER);
  assertEquals(
    await runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "off" }),
    null,
  );
  assertEquals(db.rpcCalls.length, 0, "off mode must not call the RPC");
  assertEquals(
    db.resolverCalls.length,
    0,
    "off mode must not call the deterministic resolver",
  );
  assertEquals(jev.calls.length, 0, "off mode must not call Jev");
  assertEquals(db.insertedRows.length, 0, "off mode must not write eval rows");
});

// ---------------------------------------------------------------------------
// runRoasterLink — retrieval
// ---------------------------------------------------------------------------

rlTest(
  "runRoasterLink issues a second RPC call for a different brand name",
  async () => {
    const db = makeDbStub({ rpcResults: [PHOENIX_RPC_ROWS, []] });
    const jev = makeJevStub(null);
    await runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
      mode: "shadow",
      correlationId: "req-2",
    });
    assertEquals(db.rpcCalls.length, 2, "raw roaster + distinct brand name");
    assertEquals(
      db.rpcCalls[0],
      {
        search_normalized_name: "phoenix coffee roasters",
        search_display_name: "Phoenix Coffee Roasters",
        max_results: 40,
        min_confidence: 0.05,
        search_website_url: null,
      },
      "first call searches the raw roaster",
    );
    assertEquals(
      db.rpcCalls[1],
      {
        search_normalized_name: "phoenix",
        search_display_name: "Phoenix",
        max_results: 40,
        min_confidence: 0.05,
        search_website_url: null,
      },
      "second call searches the brand name",
    );
  },
);

rlTest(
  "runRoasterLink does not issue a second RPC call for an equal brand name",
  async () => {
    const db = makeDbStub({ rpcResults: [PHOENIX_RPC_ROWS] });
    const jev = makeJevStub(null);
    await runRoasterLink(makeDeps(db.db, jev), {
      ...LABEL_RESULT,
      roaster: "Phoenix",
      roasterBrandName: "Phoenix",
    }, { mode: "shadow" });
    assertEquals(
      db.rpcCalls.length,
      1,
      "equal brand name adds nothing to search",
    );
  },
);

rlTest(
  "runRoasterLink treats an accent-only brand difference as equal",
  async () => {
    const db = makeDbStub({ rpcResults: [PHOENIX_RPC_ROWS] });
    const jev = makeJevStub(null);
    await runRoasterLink(makeDeps(db.db, jev), {
      ...LABEL_RESULT,
      roaster: "Rösterei Phoenix",
      roasterBrandName: "Rosterei Phoenix",
    }, { mode: "shadow" });
    assertEquals(
      db.rpcCalls.length,
      1,
      "normalizeForSearch equality decides, not string equality",
    );
  },
);

rlTest(
  "runRoasterLink records no_candidates and skips Jev when retrieval is empty",
  async () => {
    const db = makeDbStub({ rpcResults: [[], []] });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    const { result, logs } = await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "shadow",
        correlationId: "req-3",
      })
    );
    assertEquals(result, null, "no candidates -> no link");
    assertEquals(
      jev.calls.length,
      0,
      "Jev must not be called with zero options",
    );
    assertEquals(db.insertedRows.length, 1, "one eval row");
    assertEquals(
      db.insertedRows[0].outcome,
      "no_candidates",
      "the empty retrieval is measurable",
    );
    assertEquals(db.insertedRows[0].mode, "shadow");
    assert(
      logs.some((l) => l.message.includes("no_candidates")),
      "no_candidates must be logged",
    );
  },
);

// ---------------------------------------------------------------------------
// runRoasterLink — Jev outcomes
// ---------------------------------------------------------------------------

rlTest(
  "runRoasterLink records jev_failed and returns null when Jev fails",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(null);
    const { result } = await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "shadow" })
    );
    assertEquals(result, null, "Jev null is never a link");
    assertEquals(db.insertedRows.length, 1, "one eval row");
    const row = db.insertedRows[0];
    assertEquals(row.outcome, "jev_failed");
    assertEquals(row.jev_choice, null);
    assertEquals(row.linked_roaster_id, null);
    assertEquals(
      row.candidate_ids,
      [42, 7],
      "candidates are recorded even when Jev failed",
    );
  },
);

rlTest(
  "runRoasterLink shadow mode logs a confident link but returns null",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    const { result, logs } = await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "shadow",
        correlationId: "req-4",
      })
    );
    assertEquals(
      result,
      null,
      "shadow mode never changes the outcome of the request",
    );
    assert(
      logs.some((l) => l.message.includes("linked")),
      "the link decision must still be logged in shadow mode",
    );
    assertEquals(db.insertedRows.length, 1, "one eval row");
    const row = db.insertedRows[0];
    assertEquals(row.mode, "shadow");
    assertEquals(row.outcome, "linked");
    assertEquals(row.linked_roaster_id, 42);
    assertEquals(row.jev_choice, "42");
    assertEquals(row.jev_p, 0.95);
    assertEquals(row.trigram_top_id, 42);
    assertEquals(row.candidate_ids, [42, 7]);
    assertEquals(row.true_roaster_id, null, "filled later by a human labeller");
    assertEquals(row.labelled_at, null);
    assertEquals(typeof row.latency_ms, "number");
  },
);

rlTest("runRoasterLink records abstained when Jev picks __none__", async () => {
  const db = makeDbStub({
    rpcResults: [PHOENIX_RPC_ROWS],
    metaRows: PHOENIX_META,
  });
  const jev = makeJevStub(choiceAnswer("__none__", 0.99));
  await captureConsoleInfo(() =>
    runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "shadow" })
  );
  assertEquals(db.insertedRows.length, 1);
  const row = db.insertedRows[0];
  assertEquals(row.outcome, "abstained");
  assertEquals(row.linked_roaster_id, null, "__none__ at p = 0.99 is no link");
  assertEquals(row.jev_choice, "__none__");
});

rlTest(
  "runRoasterLink records below_threshold inside the 0.7-0.9 band",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(choiceAnswer("42", 0.75));
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "shadow" })
    );
    assertEquals(db.insertedRows.length, 1);
    const row = db.insertedRows[0];
    assertEquals(row.outcome, "below_threshold");
    assertEquals(row.linked_roaster_id, null);
    assertEquals(row.jev_p, 0.75);
  },
);

rlTest("runRoasterLink enforce mode returns the link object", async () => {
  const db = makeDbStub({
    rpcResults: [PHOENIX_RPC_ROWS],
    metaRows: PHOENIX_META,
  });
  const jev = makeJevStub(CONFIDENT_ANSWER);
  const { result } = await captureConsoleInfo(() =>
    runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
      mode: "enforce",
      correlationId: "req-5",
    })
  );
  assertEquals(
    result,
    {
      roasterId: 42,
      canonicalName: "Phoenix Coffee Roasters",
      p: 0.95,
      raw: "Phoenix Coffee Roasters",
    },
    "enforce returns the decided link",
  );
  assertEquals(db.insertedRows.length, 1, "enforce also logs one eval row");
  assertEquals(db.insertedRows[0].mode, "enforce");
  assertEquals(db.insertedRows[0].outcome, "linked");
});

rlTest(
  "runRoasterLink enforce mode returns null below the threshold",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(choiceAnswer("42", 0.75));
    const { result } = await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "enforce" })
    );
    assertEquals(result, null, "0.75 < 0.9: no link even in enforce");
    assertEquals(db.insertedRows[0].outcome, "below_threshold");
  },
);

rlTest(
  "runRoasterLink passes the parsed bag state to Jev and a shadow timeout of 3000ms",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "shadow" })
    );
    assertEquals(jev.calls.length, 1);
    const call = jev.calls[0];
    assertEquals(
      call.state,
      {
        roaster: "Phoenix Coffee Roasters",
        roasterBrandName: "Phoenix",
        name: "Ethiopia Yirgacheffe",
        origin: "Ethiopia",
        region: "Yirgacheffe",
        variety: "Heirloom",
        tastingNotes: "Floral, Lemon",
      },
      "the state is exactly the parsed bag fields",
    );
    assertEquals(
      Object.keys(call.question.criteria).length,
      3,
      "two candidates plus __none__",
    );
    assertEquals(
      call.opts?.timeoutMs,
      3000,
      "shadow mode may use the generous Jev timeout",
    );
  },
);

// ---------------------------------------------------------------------------
// runRoasterLink — deterministic resolver (eval-row telemetry only)
// ---------------------------------------------------------------------------

rlTest(
  "runRoasterLink records the deterministic resolver's id in the eval row",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
      resolverResult: 42,
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "shadow" })
    );
    assertEquals(
      db.resolverCalls,
      [{ p_roaster_name: "Phoenix Coffee Roasters" }],
      "the raw roaster string goes to resolve_coffee_roaster_id",
    );
    assertEquals(db.insertedRows.length, 1, "one eval row");
    assertEquals(
      db.insertedRows[0].deterministic_roaster_id,
      42,
      "the resolver's answer is recorded alongside the Jev decision",
    );
    assertEquals(db.insertedRows[0].outcome, "linked");
    assertEquals(db.insertedRows[0].linked_roaster_id, 42);
  },
);

rlTest(
  "runRoasterLink still writes the same eval row when the resolver fails",
  async () => {
    const failures: DbStubConfig[] = [
      { resolverError: { message: "resolver boom" } },
      { resolverThrows: new Error("resolver exploded") },
    ];
    for (const failure of failures) {
      const db = makeDbStub({
        rpcResults: [PHOENIX_RPC_ROWS],
        metaRows: PHOENIX_META,
        ...failure,
      });
      const jev = makeJevStub(CONFIDENT_ANSWER);
      const { result } = await captureConsoleInfo(() =>
        runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "shadow" })
      );
      assertEquals(result, null, "a resolver failure must not throw");
      assertEquals(db.insertedRows.length, 1, "the row is still written");
      assertEquals(
        db.insertedRows[0].outcome,
        "linked",
        "the outcome is unchanged",
      );
      assertEquals(
        db.insertedRows[0].deterministic_roaster_id,
        null,
        "a resolver failure is recorded as null",
      );
      assertEquals(
        db.insertedRows[0].linked_roaster_id,
        42,
        "the Jev decision is unaffected",
      );
    }
  },
);

rlTest(
  "runRoasterLink does not call the resolver when the run is skipped",
  async () => {
    const db = makeDbStub({ resolverResult: 42 });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    for (
      const result of [
        { roaster: "   " },
        {},
        { error: "No coffee labels detected" },
      ]
    ) {
      await runRoasterLink(makeDeps(db.db, jev), result, {
        mode: "shadow",
        correlationId: "req-8",
      });
    }
    assertEquals(
      db.resolverCalls.length,
      0,
      "the resolver must not run for a skipped run",
    );
    assertEquals(db.insertedRows.length, 0, "no eval rows either");
  },
);

rlTest(
  "runRoasterLink coerces a numeric-string resolver result and nulls junk",
  async () => {
    const jev = makeJevStub(CONFIDENT_ANSWER);
    const stringDb = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
      resolverResult: "42",
    });
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(stringDb.db, jev), LABEL_RESULT, {
        mode: "shadow",
      })
    );
    assertEquals(
      stringDb.insertedRows[0].deterministic_roaster_id,
      42,
      "a bigint arriving as a numeric string is stored as a number",
    );

    const junkDb = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
      resolverResult: "not-a-number",
    });
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(junkDb.db, jev), LABEL_RESULT, { mode: "shadow" })
    );
    assertEquals(
      junkDb.insertedRows[0].deterministic_roaster_id,
      null,
      "a non-numeric resolver result is recorded as null",
    );
  },
);

// ---------------------------------------------------------------------------
// runRoasterLink — failures
// ---------------------------------------------------------------------------

rlTest(
  "runRoasterLink returns null (not a throw) when the retrieval RPC throws",
  async () => {
    const db = makeDbStub({ rpcThrows: new Error("rpc exploded") });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    const { result } = await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "shadow",
        correlationId: "req-6",
      })
    );
    assertEquals(result, null, "a throwing Supabase stub must not throw");
    assertEquals(
      jev.calls.length,
      0,
      "no candidates retrieved, so no Jev call",
    );
    assertEquals(db.insertedRows.length, 1, "the failure is still measurable");
    assertEquals(db.insertedRows[0].outcome, "error");
    assertEquals(db.insertedRows[0].raw_roaster, "Phoenix Coffee Roasters");
  },
);

rlTest("runRoasterLink does not throw when the eval insert fails", async () => {
  const db = makeDbStub({
    rpcResults: [PHOENIX_RPC_ROWS],
    metaRows: PHOENIX_META,
    insertRejects: new Error("insert exploded"),
  });
  const jev = makeJevStub(CONFIDENT_ANSWER);
  const { result } = await captureConsoleInfo(() =>
    runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "shadow" })
  );
  assertEquals(result, null, "a failed eval insert must not throw");
  assertEquals(jev.calls.length, 1, "the pipeline still ran to completion");
});

rlTest(
  "runRoasterLink does not throw when the eval insert reports an error",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
      insertError: { message: "rls violation" },
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    const { result } = await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, { mode: "enforce" })
    );
    assertEquals(
      result,
      {
        roasterId: 42,
        canonicalName: "Phoenix Coffee Roasters",
        p: 0.95,
        raw: "Phoenix Coffee Roasters",
      },
      "eval telemetry is best-effort; the enforce decision is unaffected",
    );
  },
);

rlTest(
  "runRoasterLink enforce deadline exceeded returns null without calling Jev",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    const { result } = await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "enforce",
        correlationId: "req-7",
        deadlineMs: 0,
      })
    );
    assertEquals(result, null, "an exhausted deadline returns null");
    assertEquals(
      jev.calls.length,
      0,
      "no Jev call may start past the deadline",
    );
    assertEquals(db.insertedRows.length, 1, "the abandonment is measurable");
    assertEquals(db.insertedRows[0].outcome, "jev_failed");
  },
);

// ---------------------------------------------------------------------------
// runRoasterLink — prewarm experiment (plan 034)
// ---------------------------------------------------------------------------

rlTest(
  "runRoasterLink records the prewarm arm and prewarm_ms without changing the decision",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "shadow",
        correlationId: "req-prewarm-1",
        prewarm: { arm: "warm", prewarmMs: Promise.resolve(42) },
      })
    );
    assertEquals(db.insertedRows.length, 1, "one eval row");
    const row = db.insertedRows[0];
    assertEquals(row.prewarm_arm, "warm", "the drawn arm lands in the row");
    assertEquals(
      row.prewarm_ms,
      42,
      "the settled pre-warm latency lands in the row",
    );
    assertEquals(
      typeof row.jev_call_ms,
      "number",
      "the Jev call itself is timed",
    );
    // Telemetry only: the decision must be untouched by the experiment.
    assertEquals(row.outcome, "linked");
    assertEquals(row.linked_roaster_id, 42);
    assertEquals(row.jev_choice, "42");
    assertEquals(row.jev_p, 0.95);
  },
);

rlTest(
  "runRoasterLink records jev_call_ms null when Jev never ran (no_candidates)",
  async () => {
    const db = makeDbStub(); // no rpcResults -> zero candidates
    const jev = makeJevStub(CONFIDENT_ANSWER);
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "shadow",
        prewarm: { arm: "cold", prewarmMs: null },
      })
    );
    assertEquals(db.insertedRows.length, 1, "one eval row");
    const row = db.insertedRows[0];
    assertEquals(row.outcome, "no_candidates");
    assertEquals(
      row.jev_call_ms,
      null,
      "Jev never ran, so there is no call to time",
    );
    assertEquals(jev.calls.length, 0);
    assertEquals(row.prewarm_arm, "cold");
    assertEquals(
      row.prewarm_ms,
      null,
      "the cold arm has no pre-warm promise to await",
    );
  },
);

rlTest(
  "a never-resolving prewarm promise cannot delay the eval row beyond the settle budget",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    const startedAt = Date.now();
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "shadow",
        prewarm: { arm: "warm", prewarmMs: new Promise<never>(() => {}) },
      })
    );
    const waitedMs = Date.now() - startedAt;
    assert(
      waitedMs >= 90,
      `the row must actually wait the settle budget (waited ${waitedMs}ms)`,
    );
    assert(
      waitedMs < 500,
      `the insert must not wait meaningfully past the 100ms settle budget (waited ${waitedMs}ms)`,
    );
    const row = db.insertedRows[0];
    assertEquals(
      row.prewarm_ms,
      null,
      "an unresolved pre-warm records null, not a made-up number",
    );
    assertEquals(
      typeof row.jev_call_ms,
      "number",
      "Jev still ran and was timed",
    );
  },
);

rlTest(
  "runRoasterLink writes null prewarm columns when no prewarm info is passed",
  async () => {
    const db = makeDbStub({
      rpcResults: [PHOENIX_RPC_ROWS],
      metaRows: PHOENIX_META,
    });
    const jev = makeJevStub(CONFIDENT_ANSWER);
    await captureConsoleInfo(() =>
      runRoasterLink(makeDeps(db.db, jev), LABEL_RESULT, {
        mode: "shadow",
        correlationId: "req-prewarm-4",
      })
    );
    assertEquals(db.insertedRows.length, 1, "one eval row");
    const row = db.insertedRows[0];
    assertEquals(
      row.prewarm_arm,
      null,
      "no prewarm option -> null arm (backwards compatible)",
    );
    assertEquals(row.prewarm_ms, null);
    assertEquals(
      typeof row.jev_call_ms,
      "number",
      "jev_call_ms is recorded regardless of the experiment",
    );
  },
);
