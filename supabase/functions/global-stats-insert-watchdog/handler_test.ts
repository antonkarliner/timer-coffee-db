import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  ALERT_EMAIL_FROM,
  authorizeSchedulerRequest,
  buildSilenceAlertEmail,
  createGlobalStatsInsertWatchdogHandler,
  type EmailMessage,
  escapeHtml,
  type GlobalStatsWatchdogDeps,
  REALERT_EVERY_MINUTES,
  RUN_INTERVAL_MINUTES,
  shouldAlert,
  SILENCE_THRESHOLD_MINUTES,
} from "./handler.ts";

const SERVICE_KEY = "service-role-secret";
const EDGE_API_KEY = "sb_secret_edge-functions-key";
const NOW = new Date("2026-11-09T12:00:00.000Z");

type LogLine = { level: string; message: string; details?: unknown };

interface Harness {
  deps: GlobalStatsWatchdogDeps;
  emails: EmailMessage[];
  latestQueries: string[];
  logs: LogLine[];
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function harness(
  options: {
    latestInsertAt?: string | null;
    queryError?: Error;
    overrides?: Partial<GlobalStatsWatchdogDeps>;
  } = {},
): Harness {
  const h: Omit<Harness, "deps"> = {
    emails: [],
    latestQueries: [],
    logs: [],
  };
  const deps: GlobalStatsWatchdogDeps = {
    authorize: (req) =>
      authorizeSchedulerRequest(req, SERVICE_KEY, EDGE_API_KEY),
    getLatestInsertAt: (nowIso) => {
      h.latestQueries.push(nowIso);
      if (options.queryError) return Promise.reject(options.queryError);
      return Promise.resolve(
        options.latestInsertAt === undefined
          ? minutesAgo(5)
          : options.latestInsertAt,
      );
    },
    sendEmail: (message) => {
      h.emails.push(message);
      return Promise.resolve();
    },
    adminEmail: "admin@timer.coffee",
    getCorsHeaders: () => ({ "Access-Control-Allow-Origin": "*" }),
    createResponse: (body, init) => new Response(body, init),
    logger: {
      info: (message, details) =>
        h.logs.push({ level: "info", message, details }),
      warn: (message, details) =>
        h.logs.push({ level: "warn", message, details }),
      error: (message, details) =>
        h.logs.push({ level: "error", message, details }),
    },
    now: () => NOW,
    ...options.overrides,
  };
  return { ...h, deps };
}

function post(headers: Record<string, string> = {}): Request {
  return new Request(
    "http://localhost/functions/v1/global-stats-insert-watchdog",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: "{}",
    },
  );
}

async function run(h: Harness, req: Request = post()) {
  const response = await createGlobalStatsInsertWatchdogHandler(h.deps)(req);
  return { status: response.status, body: await response.json() };
}

// ── Alert gate ──────────────────────────────────────────────────────────

Deno.test("the exported cadence constants match the cron schedule", () => {
  assertEquals(SILENCE_THRESHOLD_MINUTES, 120);
  assertEquals(RUN_INTERVAL_MINUTES, 30);
  assertEquals(REALERT_EVERY_MINUTES, 360);
});

Deno.test("shouldAlert fires at the threshold and once per reminder interval", () => {
  assertEquals(shouldAlert(119), false);
  assertEquals(shouldAlert(120), true);
  assertEquals(shouldAlert(149), true);
  assertEquals(shouldAlert(150), false);
  assertEquals(shouldAlert(479), false);
  assertEquals(shouldAlert(480), true);
  assertEquals(shouldAlert(509), true);
  assertEquals(shouldAlert(510), false);
});

Deno.test("the alert email escapes its interpolated values", () => {
  const email = buildSilenceAlertEmail(
    "admin@timer.coffee",
    "2026-11-09T09:31:00.000Z",
    149,
  );
  assertEquals(email.from, ALERT_EMAIL_FROM);
  assertEquals(email.subject, "Timer.Coffee: no brews recorded for 2h");
  assert(email.text.includes("2026-11-09T09:31:00.000Z"));
  assert(
    email.html.includes("2026-11-09T09:31:00.000Z UTC"),
    "html carries the UTC timestamp",
  );
  assertEquals(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});

// ── Auth and method ─────────────────────────────────────────────────────

Deno.test("refuses callers without the scheduler's service credential", async () => {
  const h = harness();
  const handler = createGlobalStatsInsertWatchdogHandler(h.deps);

  const missing = await handler(
    new Request("http://localhost", { method: "POST", body: "{}" }),
  );
  assertEquals(missing.status, 401);

  const userJwt = await handler(
    post({ Authorization: "Bearer some-user-jwt" }),
  );
  assertEquals(userJwt.status, 403);

  const wrongApiKey = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: { apikey: "anon-key" },
      body: "{}",
    }),
  );
  assertEquals(wrongApiKey.status, 401);

  assertEquals(h.latestQueries, [], "nothing queries for refused callers");
  assertEquals(h.emails, []);
});

Deno.test("accepts the service key or the edge_functions_api_key in the apikey header", async () => {
  const h = harness();
  const handler = createGlobalStatsInsertWatchdogHandler(h.deps);

  const serviceKey = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: { apikey: SERVICE_KEY },
      body: "{}",
    }),
  );
  assertEquals(serviceKey.status, 200);
  await serviceKey.body?.cancel();

  const edgeKey = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: { apikey: EDGE_API_KEY },
      body: "{}",
    }),
  );
  assertEquals(edgeKey.status, 200);
  await edgeKey.body?.cancel();

  assertEquals(h.latestQueries.length, 2);
});

Deno.test("GET is refused with 405; a CORS preflight does no work", async () => {
  const h = harness();
  const handler = createGlobalStatsInsertWatchdogHandler(h.deps);

  const getRequest = await handler(
    new Request("http://localhost", {
      method: "GET",
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    }),
  );
  assertEquals(getRequest.status, 405);

  const preflight = await handler(
    new Request("http://localhost", { method: "OPTIONS" }),
  );
  assertEquals(preflight.status, 200);
  await preflight.body?.cancel();

  assertEquals(h.latestQueries, []);
});

// ── Healthy path ────────────────────────────────────────────────────────

Deno.test("fresh inserts answer 200 ok with the silence in whole minutes", async () => {
  const h = harness({ latestInsertAt: minutesAgo(5) });
  const { status, body } = await run(h);
  assertEquals(status, 200);
  assertEquals(body, {
    status: "ok",
    latest_insert_at: minutesAgo(5),
    silence_minutes: 5,
  });
  assertEquals(h.emails, []);
});

Deno.test("silence minutes are floored, not rounded", async () => {
  const h = harness({ latestInsertAt: minutesAgo(5 + 59 / 60) });
  const { status, body } = await run(h);
  assertEquals(status, 200);
  assertEquals(body.silence_minutes, 5);
});

Deno.test("getLatestInsertAt receives the injected now as ISO", async () => {
  const h = harness();
  await run(h);
  assertEquals(h.latestQueries, [NOW.toISOString()]);
});

// ── Alert path ──────────────────────────────────────────────────────────

Deno.test("past the threshold: exactly one email with the right recipient and subject", async () => {
  const h = harness({ latestInsertAt: minutesAgo(149) });
  const { status, body } = await run(h);
  assertEquals(status, 200);
  assertEquals(body.status, "alerted");
  assertEquals(body.latest_insert_at, minutesAgo(149));
  assertEquals(body.silence_minutes, 149);

  assertEquals(h.emails.length, 1);
  const email = h.emails[0];
  assertEquals(email.from, ALERT_EMAIL_FROM);
  assertEquals(email.to, "admin@timer.coffee");
  assertEquals(email.subject, "Timer.Coffee: no brews recorded for 2h");
  assert(email.text.includes("public.global_stats"));
  assert(email.text.includes("2026-11-09T09:31:00.000Z"));
  assert(email.text.includes("RLS INSERT policy"));
  assert(
    email.text.includes("tests/security/f19_global_stats_client_access.sql"),
  );
  assert(email.text.includes(".select()"));
  assert(email.html.includes("public.global_stats"));
  assertEquals(h.latestQueries, [NOW.toISOString()]);
});

Deno.test("a reminder alert reports the continued silence", async () => {
  const h = harness({ latestInsertAt: minutesAgo(480) });
  const { body } = await run(h);
  assertEquals(body.status, "alerted");
  assertEquals(body.silence_minutes, 480);
  assertEquals(h.emails.length, 1);
  assertEquals(h.emails[0].subject, "Timer.Coffee: no brews recorded for 8h");
});

// ── Failure policy ──────────────────────────────────────────────────────

Deno.test("no rows at or before now -> 500 and no email (never healthy)", async () => {
  const h = harness({ latestInsertAt: null });
  const { status, body } = await run(h);
  assertEquals(status, 500);
  assert(String(body.error).includes("No global_stats row"));
  assertEquals(h.emails, []);
  assert(h.logs.some((line) => line.level === "error"));
});

Deno.test("a query error -> 500 and no email", async () => {
  const h = harness({ queryError: new Error("relation does not exist") });
  const { status } = await run(h);
  assertEquals(status, 500);
  assertEquals(h.emails, []);
  const errors = h.logs.filter((line) => line.level === "error");
  assert(errors.some((line) => line.message.includes("latest-insert query")));
});

Deno.test("missing ADMIN_EMAIL when an alert is due -> 500 and no email", async () => {
  const h = harness({
    latestInsertAt: minutesAgo(120),
    overrides: { adminEmail: undefined },
  });
  const { status, body } = await run(h);
  assertEquals(status, 500);
  assert(String(body.error).includes("ADMIN_EMAIL"));
  assertEquals(h.emails, []);
});

Deno.test("a Resend failure -> 502", async () => {
  const h = harness({
    latestInsertAt: minutesAgo(120),
    overrides: {
      sendEmail: () =>
        Promise.reject(new Error("Resend responded with HTTP 500")),
    },
  });
  const { status } = await run(h);
  assertEquals(status, 502);
  const errors = h.logs.filter((line) => line.level === "error");
  assert(errors.some((line) => line.message.includes("alert email failed")));
});
