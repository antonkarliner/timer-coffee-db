import { JEV_MODEL } from "./ai-models.ts";
import type {
  JevChoiceQuestion,
  JevNoulQuestion,
  JevQuestion,
  JevScoreQuestion,
} from "./jev-client.ts";

// monitoring.ts — pulled in by jev-client.ts for structured logging —
// evaluates ENVIRONMENT_CONFIG at module load, which requires the core
// Supabase/Firebase/CRON variables to be present even when they are never
// used. These are fabricated test values, not real secrets. They must be set
// BEFORE the dynamic import below: a static import would evaluate
// jev-client.ts (and therefore monitoring.ts) before this module body runs.
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
  DEFAULT_JEV_NONE_DESCRIPTION,
  JEV_ENDPOINT,
  JEV_NONE_OPTION_KEY,
  jevAsk,
  jevChoose,
  jevNoul,
  jevScore,
  prewarmJevConnection,
  withNoneOfTheAbove,
} = await import("./jev-client.ts");

const TEST_API_KEY = "test-api-key";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

function assertNotNull<T>(
  value: T | null,
  message: string,
): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

/**
 * monitoring.ts schedules a deferred log-flush timer on every logInfo /
 * logError call (and a module-level flush interval), so Deno's ops sanitizer
 * would fail every test that logs with a leaked-timer error. Disabling the
 * sanitizers here is deliberate and confined to this suite.
 */
function jevTest(name: string, fn: () => Promise<void> | void): void {
  Deno.test({
    name,
    fn,
    sanitizeOps: false,
    sanitizeResources: false,
  });
}

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: RecordedRequest[]; restore(): void } {
  const calls: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRequestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}"));
}

function captureConsole(): {
  infos: unknown[][];
  errors: unknown[][];
  restore(): void;
} {
  const infos: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args: unknown[]) => {
    infos.push(args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  return {
    infos,
    errors,
    restore() {
      console.info = originalInfo;
      console.error = originalError;
    },
  };
}

function logDetails(call: unknown[]): Record<string, unknown> {
  return (call[1] ?? {}) as Record<string, unknown>;
}

const DEPARTMENT_QUESTION: JevChoiceQuestion = {
  type: "choice",
  instructions: "Which team should handle this?",
  criteria: {
    billing: "Payments, invoicing, refunds",
    technical: "Bugs, outages, integrations",
    sales: "Pricing, upgrades, new accounts",
  },
};

jevTest(
  "jevAsk answers a single choice question over the wire contract",
  async () => {
    const consoleSpy = captureConsole();
    const fetchStub = stubFetch((_url, init) => {
      const body = parseRequestBody(init);
      assertEquals(
        body,
        {
          state: "Help! My payouts have been failing for 3 days.",
          model: JEV_MODEL,
          questions: { department: DEPARTMENT_QUESTION },
        },
        "The request body must carry the state, the ai-models.ts model id, and the caller's question untouched.",
      );
      return jsonResponse({
        model: JEV_MODEL,
        answers: {
          department: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
            confidence: 0.82,
          },
        },
        usage: { input_tokens: 312, output_tokens: 48 },
      });
    });
    try {
      const result = assertNotNull(
        await jevAsk(
          "Help! My payouts have been failing for 3 days.",
          { department: DEPARTMENT_QUESTION },
          { apiKey: TEST_API_KEY, correlationId: "cid-choice" },
        ),
        "A valid choice exchange must return a result.",
      );
      const answer = result.answers.department;
      assertEquals(
        answer,
        {
          type: "choice",
          choice: "technical",
          probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
          confidence: 0.82,
        },
        "The choice answer must come back keyed and typed.",
      );
      assertEquals(
        result.usage,
        { input_tokens: 312, output_tokens: 48 },
        "Usage must be carried through.",
      );
      assert(
        typeof result.latencyMs === "number" && result.latencyMs >= 0,
        "latencyMs must be a measured non-negative number.",
      );

      assertEquals(
        fetchStub.calls.length,
        1,
        "Exactly one request is expected.",
      );
      const request = fetchStub.calls[0];
      assertEquals(
        request.url,
        JEV_ENDPOINT,
        "The request must go to the exported endpoint constant.",
      );
      assertEquals(
        request.init?.method,
        "POST",
        "Jev is a POST endpoint.",
      );
      const headers = (request.init?.headers ?? {}) as Record<string, string>;
      assertEquals(
        headers["Authorization"],
        `Bearer ${TEST_API_KEY}`,
        "The API key must be sent as a bearer token.",
      );
      assertEquals(
        headers["Content-Type"],
        "application/json",
        "The request must be JSON.",
      );

      const successLogs = consoleSpy.infos.filter((call) =>
        call[0] === "jev_ask completed"
      );
      assertEquals(
        successLogs.length,
        1,
        "Exactly one success log is expected.",
      );
      const details = logDetails(successLogs[0]);
      assertEquals(details.n_questions, 1, "n_questions must be logged.");
      assertEquals(details.status, 200, "status must be logged.");
      assertEquals(
        details.input_tokens,
        312,
        "input_tokens must be logged.",
      );
      assert(
        typeof details.latency_ms === "number",
        "latency_ms must be logged.",
      );
    } finally {
      fetchStub.restore();
      consoleSpy.restore();
    }
  },
);

jevTest(
  "jevAsk answers a batch of three mixed questions under their own keys",
  async () => {
    const fetchStub = stubFetch(() =>
      jsonResponse({
        model: JEV_MODEL,
        answers: {
          department: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 },
            confidence: 0.77,
          },
          is_urgent: { type: "noul", noul: 0.92 },
          tone: {
            type: "score",
            score: 1.6,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
            probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
            confidence: 0.78,
          },
        },
        usage: { input_tokens: 400, output_tokens: 90 },
      })
    );
    try {
      const noulQuestion: JevNoulQuestion = {
        type: "noul",
        instructions: "Is the customer blocked right now?",
      };
      const scoreQuestion: JevScoreQuestion = {
        type: "score",
        instructions: "How angry does the customer sound?",
        criteria: ["Calm", "Frustrated", "Very angry"],
      };

      const result = assertNotNull(
        await jevAsk(
          "Help! My payouts have been failing for 3 days.",
          {
            department: DEPARTMENT_QUESTION,
            is_urgent: noulQuestion,
            tone: scoreQuestion,
          },
          { apiKey: TEST_API_KEY },
        ),
        "A valid batch exchange must return a result.",
      );
      assertEquals(fetchStub.calls.length, 1, "A batch must be ONE request.");
      const answers = result.answers;
      assertEquals(
        answers.department.type,
        "choice",
        "department must come back as a choice answer.",
      );
      assertEquals(
        answers.is_urgent,
        { type: "noul", noul: 0.92 },
        "is_urgent must come back as a noul answer.",
      );
      assertEquals(
        answers.tone,
        {
          type: "score",
          score: 1.6,
          legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
          probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
          confidence: 0.78,
        },
        "tone must come back as a score answer with its legend.",
      );
      const wireQuestions = parseRequestBody(fetchStub.calls[0].init)
        .questions as Record<string, { criteria?: unknown }>;
      assertEquals(
        wireQuestions.is_urgent.criteria,
        undefined,
        "A noul question without criteria must not invent one.",
      );
      assertEquals(
        wireQuestions.tone.criteria,
        ["Calm", "Frustrated", "Very angry"],
        "The score rubric must be sent as an ordered array.",
      );
    } finally {
      fetchStub.restore();
    }
  },
);

jevTest("a noul answer never gains a confidence field", async () => {
  const fetchStub = stubFetch(() =>
    jsonResponse({
      model: JEV_MODEL,
      answers: {
        is_urgent: { type: "noul", noul: 0.92, confidence: 0.5 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    })
  );
  try {
    const result = await jevAsk(
      "state",
      { is_urgent: { type: "noul", instructions: "Urgent?" } },
      { apiKey: TEST_API_KEY },
    );

    const answer = assertNotNull(
      result,
      "A valid noul answer must return a result.",
    ).answers.is_urgent;
    assertEquals(
      Object.keys(answer).sort(),
      ["noul", "type"],
      "A noul answer has no confidence field on the wire; the client must neither keep nor invent one.",
    );
    assertEquals(
      (answer as { noul?: number }).noul,
      0.92,
      "The noul probability must survive normalization.",
    );
  } finally {
    fetchStub.restore();
  }
});

jevTest("a score answer carries its legend", async () => {
  const fetchStub = stubFetch(() =>
    jsonResponse({
      model: JEV_MODEL,
      answers: {
        q: {
          type: "score",
          score: 1.6,
          legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
          probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
          confidence: 0.78,
        },
      },
      usage: { input_tokens: 20, output_tokens: 10 },
    })
  );
  try {
    const answer = await jevScore(
      "You promised next-day delivery, three weeks ago.",
      {
        type: "score",
        instructions: "How angry does the customer sound?",
        criteria: ["Calm", "Frustrated", "Very angry"],
      },
      { apiKey: TEST_API_KEY },
    );

    const score = assertNotNull(answer, "A valid score must not be null.");
    assertEquals(
      score.legend,
      { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "The legend must echo the rubric descriptions.",
    );
    assertEquals(score.type, "score", "The answer must be typed as score.");
  } finally {
    fetchStub.restore();
  }
});

jevTest("a timed-out request returns null", async () => {
  const fetchStub = stubFetch((_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () =>
        reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
      }
    })
  );
  try {
    const result = await jevAsk(
      "state",
      { department: DEPARTMENT_QUESTION },
      { apiKey: TEST_API_KEY, timeoutMs: 30 },
    );

    assertEquals(result, null, "A timeout must degrade to null.");
    assertEquals(
      fetchStub.calls.length,
      1,
      "A timeout must not be retried.",
    );
  } finally {
    fetchStub.restore();
  }
});

for (const status of [401, 422, 429, 529]) {
  jevTest(`HTTP ${status} returns null`, async () => {
    const fetchStub = stubFetch(() => jsonResponse({ error: "no" }, status));
    try {
      const result = await jevAsk(
        "state",
        { department: DEPARTMENT_QUESTION },
        { apiKey: TEST_API_KEY },
      );

      assertEquals(result, null, `HTTP ${status} must degrade to null.`);
      assertEquals(
        fetchStub.calls.length,
        1,
        "There must be no internal retry by default, including on 429/529.",
      );
    } finally {
      fetchStub.restore();
    }
  });
}

jevTest("a 200 with a non-JSON body returns null", async () => {
  const fetchStub = stubFetch(() =>
    new Response("<html>gateway oops</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  );
  try {
    const result = await jevAsk(
      "state",
      { department: DEPARTMENT_QUESTION },
      { apiKey: TEST_API_KEY },
    );

    assertEquals(result, null, "An unparseable body must degrade to null.");
  } finally {
    fetchStub.restore();
  }
});

jevTest("a 200 whose answers violate the contract returns null", async () => {
  const bodies: unknown[] = [
    // choice answer missing probabilities
    {
      model: JEV_MODEL,
      answers: { department: { type: "choice", choice: "billing" } },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    // requested key missing from answers entirely
    {
      model: JEV_MODEL,
      answers: { other: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    // usage missing
    {
      model: JEV_MODEL,
      answers: {
        department: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 1 },
          confidence: 0.9,
        },
      },
    },
  ];

  for (const body of bodies) {
    const fetchStub = stubFetch(() => jsonResponse(body));
    try {
      const result = await jevAsk(
        "state",
        { department: DEPARTMENT_QUESTION },
        { apiKey: TEST_API_KEY },
      );
      assertEquals(
        result,
        null,
        `A contract-violating body must degrade to null: ${
          JSON.stringify(body)
        }`,
      );
    } finally {
      fetchStub.restore();
    }
  }
});

jevTest("missing TYPESAFE_API_KEY returns null without any fetch", async () => {
  const previous = Deno.env.get("TYPESAFE_API_KEY");
  Deno.env.delete("TYPESAFE_API_KEY");
  const consoleSpy = captureConsole();
  const fetchStub = stubFetch(() => {
    throw new Error("jevAsk must not touch the network without an API key");
  });
  try {
    const result = await jevAsk(
      "state",
      { department: DEPARTMENT_QUESTION },
      { correlationId: "cid-no-key" },
    );

    assertEquals(result, null, "A missing key must degrade to null.");
    assertEquals(
      fetchStub.calls.length,
      0,
      "No network call may be attempted when the key is absent.",
    );
    const skipLogs = consoleSpy.infos.filter((call) =>
      String(call[0]).includes("jev_fallback")
    );
    assertEquals(
      skipLogs.length,
      1,
      "Absence of the key is a supported state and must be logged once at info level.",
    );
    assertEquals(
      logDetails(skipLogs[0]).reason,
      "missing_api_key",
      "The skip log must carry the missing_api_key reason.",
    );
  } finally {
    fetchStub.restore();
    consoleSpy.restore();
    if (previous === undefined) {
      Deno.env.delete("TYPESAFE_API_KEY");
    } else {
      Deno.env.set("TYPESAFE_API_KEY", previous);
    }
  }
});

jevTest(
  "withNoneOfTheAbove appends __none__ and the opt-out suppresses it",
  async () => {
    const question: JevChoiceQuestion = {
      type: "choice",
      instructions: "Which roast level is this bag?",
      criteria: { light: "Cinnamon to blonde", dark: "Oil on the bean" },
    };

    const withNone = withNoneOfTheAbove(question);
    const appended = withNone.criteria[JEV_NONE_OPTION_KEY];
    assert(
      typeof appended === "string" && appended.length > 0,
      "__none__ must be appended with a real descriptive sentence, not null.",
    );
    assertEquals(
      appended,
      DEFAULT_JEV_NONE_DESCRIPTION,
      "The default description must be used when none is given.",
    );
    assertEquals(
      question.criteria[JEV_NONE_OPTION_KEY],
      undefined,
      "The helper must not mutate the caller's question.",
    );
    assertEquals(
      withNoneOfTheAbove(withNone).criteria[JEV_NONE_OPTION_KEY],
      appended,
      "Appending must be idempotent.",
    );
    assertEquals(
      withNoneOfTheAbove(question, { includeNone: false }).criteria,
      question.criteria,
      "The opt-out must suppress the option.",
    );
    assertEquals(
      withNoneOfTheAbove(question, { noneDescription: "Not a roast bag" })
        .criteria[JEV_NONE_OPTION_KEY],
      "Not a roast bag",
      "A custom description must be honored.",
    );

    const fetchStub = stubFetch((_url, init) => {
      const body = parseRequestBody(init);
      const questions = body.questions as Record<
        string,
        { criteria: Record<string, unknown> }
      >;
      assertEquals(
        Object.keys(questions),
        ["q"],
        "jevChoose delegates with the single wrapper key.",
      );
      assertEquals(
        questions.q.criteria[JEV_NONE_OPTION_KEY],
        DEFAULT_JEV_NONE_DESCRIPTION,
        "The appended option must reach the wire.",
      );
      return jsonResponse({
        model: JEV_MODEL,
        answers: {
          q: {
            type: "choice",
            choice: JEV_NONE_OPTION_KEY,
            probabilities: {
              light: 0.1,
              dark: 0.1,
              [JEV_NONE_OPTION_KEY]: 0.8,
            },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 5, output_tokens: 5 },
      });
    });
    try {
      const answer = assertNotNull(
        await jevChoose("A mystery bag", withNone, {
          apiKey: TEST_API_KEY,
        }),
        "jevChoose must return the __none__ choice like any other option.",
      );
      assertEquals(
        answer.choice,
        JEV_NONE_OPTION_KEY,
        "Thresholding on __none__ starts with receiving it as the choice.",
      );
    } finally {
      fetchStub.restore();
    }
  },
);

jevTest(
  "the correlationId reaches the logger on success and failure",
  async () => {
    const consoleSpy = captureConsole();
    const fetchStub = stubFetch((_url, init) => {
      const body = parseRequestBody(init);
      if ((body.state as string).includes("fail")) {
        return jsonResponse({ error: "nope" }, 500);
      }
      return jsonResponse({
        model: JEV_MODEL,
        answers: { department: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    });
    try {
      await jevAsk(
        "state",
        { department: { type: "noul", instructions: "OK?" } },
        { apiKey: TEST_API_KEY, correlationId: "cid-trace-me" },
      );
      const successDetails = consoleSpy.infos
        .filter((call) => call[0] === "jev_ask completed")
        .map(logDetails);
      assertEquals(
        successDetails.length,
        1,
        "Exactly one success log is expected.",
      );
      assertEquals(
        successDetails[0].correlation_id,
        "cid-trace-me",
        "The correlationId must reach the success log.",
      );

      await jevAsk(
        "please fail",
        { department: { type: "noul", instructions: "OK?" } },
        { apiKey: TEST_API_KEY, correlationId: "cid-trace-me" },
      );
      const failureDetails = consoleSpy.errors
        .filter((call) => String(call[0]).includes("jev_fallback"))
        .map(logDetails);
      assertEquals(
        failureDetails.length,
        1,
        "Exactly one failure log with the marker is expected.",
      );
      assertEquals(
        failureDetails[0].correlation_id,
        "cid-trace-me",
        "The correlationId must reach the failure log.",
      );
      assertEquals(
        failureDetails[0].marker,
        "jev_fallback",
        "Failure logs must carry the stable jev_fallback marker.",
      );
    } finally {
      fetchStub.restore();
      consoleSpy.restore();
    }
  },
);

jevTest(
  "opt-in retries cover 429/529 only and are off by default",
  async () => {
    let attempt = 0;
    const retryStub = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ error: "slow down" }, 429)
        : jsonResponse({
          model: JEV_MODEL,
          answers: { department: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 3, output_tokens: 1 },
        });
    });
    try {
      const retried = await jevAsk(
        "state",
        { department: { type: "noul", instructions: "OK?" } },
        { apiKey: TEST_API_KEY, maxRetries: 1, retryDelayMs: 1 },
      );
      assertNotNull(
        retried,
        "An opted-in caller must survive one 429 with a success on the retry.",
      );
      assertEquals(
        retryStub.calls.length,
        2,
        "maxRetries: 1 means at most two attempts.",
      );
    } finally {
      retryStub.restore();
    }

    const fatalStub = stubFetch(() => jsonResponse({ error: "boom" }, 500));
    try {
      const notRetried = await jevAsk(
        "state",
        { department: { type: "noul", instructions: "OK?" } },
        { apiKey: TEST_API_KEY, maxRetries: 2, retryDelayMs: 1 },
      );
      assertEquals(
        notRetried,
        null,
        "A 500 is not retryable and must degrade to null.",
      );
      assertEquals(
        fatalStub.calls.length,
        1,
        "Retries must apply to 429/529 only.",
      );
    } finally {
      fatalStub.restore();
    }
  },
);

jevTest(
  "single-question wrappers delegate to jevAsk and type-filter",
  async () => {
    const fetchStub = stubFetch((_url, init) => {
      const body = parseRequestBody(init);
      const questions = Object.keys(
        body.questions as Record<string, unknown>,
      );
      assertEquals(
        questions,
        ["q"],
        "Wrappers must send exactly one question through jevAsk.",
      );
      const choiceAnswers = {
        model: JEV_MODEL,
        answers: {
          q: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.2, technical: 0.8 },
            confidence: 0.8,
          },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      };
      return jsonResponse(choiceAnswers);
    });
    try {
      const mismatch = await jevNoul("state", {
        type: "noul",
        instructions: "Is this urgent?",
      }, { apiKey: TEST_API_KEY });
      assertEquals(
        mismatch,
        null,
        "jevNoul must return null when the answer is not a noul answer.",
      );

      const matched = await jevChoose("state", DEPARTMENT_QUESTION, {
        apiKey: TEST_API_KEY,
      });
      assertEquals(
        matched?.choice,
        "technical",
        "jevChoose must return the typed choice answer.",
      );

      const scoreMismatch = await jevScore("state", {
        type: "score",
        instructions: "Tone?",
        criteria: ["Calm", "Angry"],
      }, { apiKey: TEST_API_KEY });
      assertEquals(
        scoreMismatch,
        null,
        "jevScore must return null when the answer is not a score answer.",
      );

      assertEquals(
        fetchStub.calls.length,
        3,
        "Each wrapper call must be exactly one delegated request; wrappers never fetch on their own path.",
      );
    } finally {
      fetchStub.restore();
    }
  },
);

jevTest("invalid question sets fail client-side without a fetch", async () => {
  const fetchStub = stubFetch(() => {
    throw new Error("invalid question sets must not reach the network");
  });
  try {
    const empty = await jevAsk("state", {}, { apiKey: TEST_API_KEY });
    assertEquals(empty, null, "An empty question set cannot be sent.");

    const noCriteria = await jevAsk("state", {
      bad: { type: "choice", instructions: "?" } as JevChoiceQuestion,
    }, { apiKey: TEST_API_KEY });
    assertEquals(
      noCriteria,
      null,
      "A choice question without criteria must be rejected client-side.",
    );

    const tooManyOptions: Record<string, string | null> = {};
    for (let i = 0; i < 256; i++) {
      tooManyOptions[`opt_${i}`] = null;
    }
    const overflow = await jevAsk("state", {
      bad: { type: "choice", instructions: "?", criteria: tooManyOptions },
    }, { apiKey: TEST_API_KEY });
    assertEquals(
      overflow,
      null,
      "A choice question above 255 options must be rejected client-side.",
    );

    const oneLevel = await jevAsk("state", {
      bad: { type: "score", instructions: "?", criteria: ["Only one"] },
    }, { apiKey: TEST_API_KEY });
    assertEquals(
      oneLevel,
      null,
      "A score rubric needs at least two levels.",
    );

    const noInstructions = await jevAsk("state", {
      bad: { type: "noul" } as unknown as JevQuestion,
    }, { apiKey: TEST_API_KEY });
    assertEquals(
      noInstructions,
      null,
      "A question without instructions must be rejected client-side.",
    );

    assertEquals(
      fetchStub.calls.length,
      0,
      "None of the invalid sets may produce a request.",
    );
  } finally {
    fetchStub.restore();
  }
});

// ---------------------------------------------------------------------------
// prewarmJevConnection
// ---------------------------------------------------------------------------

jevTest(
  "prewarmJevConnection GETs the origin and returns ms on any HTTP status",
  async () => {
    const fetchStub = stubFetch(() =>
      new Response("not found", { status: 404 })
    );
    try {
      const elapsed = await prewarmJevConnection();
      const ms = assertNotNull(
        elapsed,
        "a 404 still proves the handshake happened; any status counts",
      );
      assert(ms >= 0, "elapsed must be a non-negative number of ms");
      assertEquals(fetchStub.calls.length, 1, "exactly one request");
      assertEquals(
        fetchStub.calls[0].url,
        new URL(JEV_ENDPOINT).origin,
        "the pre-warm must hit the origin derived from JEV_ENDPOINT",
      );
      assertEquals(
        fetchStub.calls[0].init?.method,
        "GET",
        "a cheap GET, not the billable POST /v1/systemone",
      );
    } finally {
      fetchStub.restore();
    }
  },
);

jevTest(
  "prewarmJevConnection returns null on a network error and never throws",
  async () => {
    const fetchStub = stubFetch(() => {
      throw new Error("connection refused");
    });
    const console_ = captureConsole();
    try {
      const result = await prewarmJevConnection();
      assertEquals(result, null, "a network failure must resolve to null");
      assert(
        console_.infos.some((call) =>
          String(call[0]).includes("jev_prewarm") &&
          String(call[0]).includes("failed")
        ),
        "the failure must be logged at a low level with the jev_prewarm marker",
      );
    } finally {
      fetchStub.restore();
      console_.restore();
    }
  },
);

jevTest(
  "prewarmJevConnection never sends an Authorization header or a question body",
  async () => {
    // The key exists here, so the absence of the header is a real property of
    // the request, not of the environment.
    Deno.env.set("TYPESAFE_API_KEY", "secret-key-that-must-not-leak");
    const fetchStub = stubFetch(() => new Response(null, { status: 405 }));
    try {
      const result = await prewarmJevConnection();
      assertNotNull(result, "a 405 is still a successful handshake");
      const headers = new Headers(
        fetchStub.calls[0].init?.headers ?? undefined,
      );
      assertEquals(
        headers.has("Authorization"),
        false,
        "a pre-warm must never carry the API key",
      );
      assertEquals(
        fetchStub.calls[0].init?.body ?? null,
        null,
        "a pre-warm must never carry a body (a question would be billable)",
      );
    } finally {
      fetchStub.restore();
    }
  },
);

jevTest(
  "prewarmJevConnection reads the response body to the end so the socket returns to the keep-alive pool",
  async () => {
    let bodyReadToEnd = false;
    let bodyCancelled = false;
    const fetchStub = stubFetch(() => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              new TextEncoder().encode("404 page not found\n"),
            );
            return;
          }
          bodyReadToEnd = true;
          controller.close();
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      return new Response(body, { status: 404 });
    });
    try {
      const result = await prewarmJevConnection();
      assertNotNull(result, "a 404 with a stream body is a completed request");
      assert(
        bodyReadToEnd,
        "an unconsumed body would keep the socket out of the keep-alive pool and silently defeat the experiment",
      );
      assert(
        !bodyCancelled,
        "cancelling can close an HTTP/1.1 connection; the body must be drained instead",
      );
    } finally {
      fetchStub.restore();
    }
  },
);
