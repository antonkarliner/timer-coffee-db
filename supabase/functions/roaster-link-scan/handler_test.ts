import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  createWebRiskClient,
  type WebRiskLookupResult,
} from "../_shared/web-risk.ts";
import type { EmailMessage } from "./emails.ts";
import {
  authorizeSchedulerRequest,
  createRoasterLinkScanHandler,
  type QuarantineArgs,
  type RoasterLinkScanDeps,
  type ScanPage,
} from "./handler.ts";

const SERVICE_KEY = "service-role-secret";
const EDGE_API_KEY = "sb_secret_edge-functions-key";
const WEB_RISK_KEY = "web-risk-secret-key";

type LogLine = { level: string; message: string; details?: unknown };

interface Harness {
  deps: RoasterLinkScanDeps;
  lookups: string[];
  quarantines: QuarantineArgs[];
  marked: string[][];
  batchLimits: number[];
  emails: EmailMessage[];
  userLookups: string[];
  logs: LogLine[];
}

function page(
  id: string,
  website: string | null,
  description: string | null = null,
  adminUserId: string | null = null,
): ScanPage {
  return {
    roaster_profile_id: id,
    website_url: website,
    description,
    admin_user_id: adminUserId,
  };
}

function harness(options: {
  batch?: ScanPage[];
  results?: Record<string, WebRiskLookupResult>;
  quarantineResult?: (args: QuarantineArgs) => string | null;
  overrides?: Partial<RoasterLinkScanDeps>;
} = {}): Harness {
  const h: Omit<Harness, "deps"> = {
    lookups: [],
    quarantines: [],
    marked: [],
    batchLimits: [],
    emails: [],
    userLookups: [],
    logs: [],
  };
  let flagCounter = 0;
  const deps: RoasterLinkScanDeps = {
    authorize: (req) =>
      authorizeSchedulerRequest(req, SERVICE_KEY, EDGE_API_KEY),
    getWebRiskApiKey: () => WEB_RISK_KEY,
    createLookUp: () => (uri) => {
      h.lookups.push(uri);
      return Promise.resolve(options.results?.[uri] ?? { status: "clean" });
    },
    fetchBatch: (limit) => {
      h.batchLimits.push(limit);
      return Promise.resolve(options.batch ?? []);
    },
    quarantineLink: (args) => {
      h.quarantines.push(args);
      return Promise.resolve(
        options.quarantineResult
          ? options.quarantineResult(args)
          : `flag-${++flagCounter}`,
      );
    },
    markChecked: (ids) => {
      h.marked.push([...ids].sort());
      return Promise.resolve();
    },
    getRoasterPages: (ids) =>
      Promise.resolve(ids.map((id) => ({
        id,
        slug: `${id}-slug`,
        roaster_name: `Roaster ${id}`,
      }))),
    getUserEmail: (userId) => {
      h.userLookups.push(userId);
      return Promise.resolve(`${userId}@roaster.example`);
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
    ...options.overrides,
  };
  return { ...h, deps };
}

function post(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/functions/v1/roaster-link-scan", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function run(h: Harness, req: Request = post({ limit: 300 })) {
  const response = await createRoasterLinkScanHandler(h.deps)(req);
  return { status: response.status, body: await response.json() };
}

const FLAG_MALWARE: WebRiskLookupResult = {
  status: "flagged",
  threatTypes: ["MALWARE"],
};

// ── Auth ────────────────────────────────────────────────────────────────

Deno.test("refuses callers without the scheduler's service credential", async () => {
  const h = harness({ batch: [page("p1", "https://kawa.example")] });
  const handler = createRoasterLinkScanHandler(h.deps);

  const missing = await handler(
    new Request("http://localhost", { method: "POST", body: "{}" }),
  );
  assertEquals(missing.status, 401);

  const userJwt = await handler(
    post({}, { Authorization: "Bearer some-user-jwt" }),
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

  const getRequest = await handler(
    new Request("http://localhost", {
      method: "GET",
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    }),
  );
  assertEquals(getRequest.status, 405);

  assertEquals(h.batchLimits, [], "nothing runs for refused callers");
  assertEquals(h.lookups, []);
  assertEquals(h.marked, []);
});

Deno.test("accepts the service key in the apikey header (pg_net apikey path)", async () => {
  const h = harness();
  const response = await createRoasterLinkScanHandler(h.deps)(
    new Request("http://localhost", {
      method: "POST",
      headers: { apikey: SERVICE_KEY },
      body: "{}",
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(h.batchLimits, [300]);
});

Deno.test("accepts the edge_functions_api_key in the apikey header (cron's preferred path)", async () => {
  const h = harness();
  const response = await createRoasterLinkScanHandler(h.deps)(
    new Request("http://localhost", {
      method: "POST",
      headers: { apikey: EDGE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 300 }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(h.batchLimits, [300]);
});

Deno.test("authorizeSchedulerRequest: only the service key or the configured edge key", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://localhost", { method: "POST", headers });

  assert(
    authorizeSchedulerRequest(
      req({ Authorization: `Bearer ${SERVICE_KEY}` }),
      SERVICE_KEY,
    ).authorized,
  );
  assert(
    authorizeSchedulerRequest(req({ apikey: SERVICE_KEY }), SERVICE_KEY)
      .authorized,
  );
  assert(
    authorizeSchedulerRequest(
      req({ apikey: EDGE_API_KEY }),
      SERVICE_KEY,
      EDGE_API_KEY,
    ).authorized,
  );
  // Without EDGE_FUNCTIONS_API_KEY configured, the edge key is just a string.
  const unconfigured = authorizeSchedulerRequest(
    req({ apikey: EDGE_API_KEY }),
    SERVICE_KEY,
  );
  assertEquals(unconfigured.authorized, false);
  // An empty configured edge key never matches an empty header.
  assertEquals(
    authorizeSchedulerRequest(req({ apikey: "" }), SERVICE_KEY, "").authorized,
    false,
  );
  const userJwt = authorizeSchedulerRequest(
    req({ Authorization: "Bearer user.jwt.token", apikey: "anon-key" }),
    SERVICE_KEY,
    EDGE_API_KEY,
  );
  assertEquals(userJwt.authorized, false);
  if (!userJwt.authorized) assertEquals(userJwt.status, 403);
  // No service key in the environment: refuse with 500, never open.
  const noKey = authorizeSchedulerRequest(
    req({ Authorization: "Bearer " }),
    "",
    "",
  );
  assertEquals(noKey.authorized, false);
  if (!noKey.authorized) assertEquals(noKey.status, 500);
});

Deno.test("a CORS preflight is answered without doing any work", async () => {
  const h = harness({ batch: [page("p1", "https://kawa.example")] });
  const response = await createRoasterLinkScanHandler(h.deps)(
    new Request("http://localhost", { method: "OPTIONS" }),
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(h.batchLimits, []);
  assertEquals(h.lookups, []);
  assertEquals(h.marked, []);
});

// ── Limit ───────────────────────────────────────────────────────────────

Deno.test("limit defaults to 300, is capped at 1000 and must be a positive integer", async () => {
  const h = harness();
  const handler = createRoasterLinkScanHandler(h.deps);
  assertEquals((await handler(post())).status, 200);
  assertEquals((await handler(post({}))).status, 200);
  assertEquals((await handler(post({ limit: 5000 }))).status, 200);
  assertEquals((await handler(post({ limit: 25 }))).status, 200);
  assertEquals(h.batchLimits, [300, 300, 1000, 25]);

  assertEquals((await handler(post({ limit: 0 }))).status, 400);
  assertEquals((await handler(post({ limit: "10" }))).status, 400);
  assertEquals((await handler(post({ limit: 2.5 }))).status, 400);
  const notJson = await handler(
    new Request("http://localhost", {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      body: "not json",
    }),
  );
  assertEquals(notJson.status, 400);
  assertEquals(h.batchLimits.length, 4);
});

// ── Main flow ───────────────────────────────────────────────────────────

Deno.test("batch -> lookups -> quarantine for flagged links -> one mark call", async () => {
  const h = harness({
    batch: [
      page("clean", "https://kawa.example", "Shop at www.kawa.example/shop."),
      page("bad-site", "https://evil.example/landing?ref=1", null, "owner-1"),
      page(
        "bad-desc",
        null,
        "Order via www.phish.example/pay, or https://fine.example",
      ),
    ],
    results: {
      "https://evil.example/landing?ref=1": FLAG_MALWARE,
      "https://www.phish.example/pay": {
        status: "flagged",
        threatTypes: ["SOCIAL_ENGINEERING"],
      },
    },
  });

  const { status, body } = await run(h);

  assertEquals(status, 200);
  assertEquals(body, {
    checked: 3,
    flagged: 2,
    quarantined: 2,
    skipped_errors: 0,
    stopped_early: false,
  });
  assertEquals(h.lookups.sort(), [
    "https://evil.example/landing?ref=1",
    "https://fine.example/",
    "https://kawa.example/",
    "https://www.kawa.example/shop",
    "https://www.phish.example/pay",
  ]);
  // The quarantine gets the value as stored / as written, so the database
  // can match it against the column.
  assertEquals(
    h.quarantines.sort((a, b) =>
      a.roasterProfileId.localeCompare(b.roasterProfileId)
    ),
    [
      {
        roasterProfileId: "bad-desc",
        field: "description",
        url: "www.phish.example/pay",
        threatTypes: ["SOCIAL_ENGINEERING"],
      },
      {
        roasterProfileId: "bad-site",
        field: "website_url",
        url: "https://evil.example/landing?ref=1",
        threatTypes: ["MALWARE"],
      },
    ],
  );
  assertEquals(h.marked, [["bad-desc", "bad-site", "clean"]]);
});

Deno.test("a flagged URL in both website and description is quarantined in both fields", async () => {
  const h = harness({
    batch: [
      page("p1", "https://evil.example/", "Visit https://evil.example/ now"),
    ],
    results: { "https://evil.example/": FLAG_MALWARE },
  });
  const { body } = await run(h);
  assertEquals(h.lookups, ["https://evil.example/"]);
  assertEquals(h.quarantines.map((q) => [q.field, q.url]), [
    ["website_url", "https://evil.example/"],
    ["description", "https://evil.example/"],
  ]);
  assertEquals(body.flagged, 1);
  assertEquals(body.quarantined, 2);
});

Deno.test("social links are never looked up and the page is still marked", async () => {
  const h = harness({
    batch: [
      page(
        "social",
        "https://www.instagram.com/kawa/",
        "Follow https://facebook.com/kawa and www.tiktok.com/@kawa",
      ),
    ],
  });
  const { body } = await run(h);
  assertEquals(h.lookups, []);
  assertEquals(h.marked, [["social"]]);
  assertEquals(body.checked, 1);
});

Deno.test("at most 10 URLs are looked up per page", async () => {
  const description = Array.from(
    { length: 14 },
    (_, i) => `https://shop${i}.example/`,
  ).join(" ");
  const h = harness({
    batch: [page("many", "https://kawa.example", description)],
  });
  await run(h);
  assertEquals(h.lookups.length, 10);
  assertEquals(h.lookups[0], "https://kawa.example/");
});

// ── Failure policy ──────────────────────────────────────────────────────

Deno.test("a lookup error leaves only that page unchecked", async () => {
  const h = harness({
    batch: [
      page("ok-1", "https://a.example"),
      page("broken", "https://b.example", "and https://c.example/x?q=secret"),
      page("ok-2", "https://d.example"),
    ],
    results: {
      "https://b.example/": { status: "error", reason: "timeout" },
      "https://c.example/x?q=secret": FLAG_MALWARE,
    },
  });
  const { status, body } = await run(h);
  assertEquals(status, 200);
  assertEquals(body, {
    checked: 2,
    flagged: 1,
    quarantined: 1,
    skipped_errors: 1,
    stopped_early: false,
  });
  assertEquals(h.marked, [["ok-1", "ok-2"]]);
  // The flagged link on the broken page is still quarantined.
  assertEquals(h.quarantines.map((q) => q.roasterProfileId), ["broken"]);
});

Deno.test("a quarantine failure leaves the page unchecked", async () => {
  const h = harness({
    batch: [
      page("p1", "https://evil.example"),
      page("p2", "https://a.example"),
    ],
    results: { "https://evil.example/": FLAG_MALWARE },
    overrides: {
      quarantineLink: () => Promise.reject(new Error("db down")),
    },
  });
  const { body } = await run(h);
  assertEquals(body.skipped_errors, 1);
  assertEquals(body.quarantined, 0);
  assertEquals(h.marked, [["p2"]]);
  assertEquals(h.emails, []);
});

Deno.test("429 stops the run early and marks only the pages fully checked so far", async () => {
  const h = harness({
    batch: [
      page("first", "https://a.example"),
      page("limited", "https://b.example", "https://c.example"),
      page("never", "https://d.example"),
    ],
    results: { "https://b.example/": { status: "quota", httpStatus: 429 } },
    overrides: { concurrency: 1 },
  });
  const { status, body } = await run(h);
  assertEquals(status, 200);
  assertEquals(body, {
    checked: 1,
    flagged: 0,
    quarantined: 0,
    skipped_errors: 1,
    stopped_early: true,
  });
  assertEquals(h.lookups, ["https://a.example/", "https://b.example/"]);
  assertEquals(h.marked, [["first"]]);
});

Deno.test("a refused Web Risk key also stops the run", async () => {
  const h = harness({
    batch: [page("p1", "https://a.example"), page("p2", "https://b.example")],
    results: {
      "https://a.example/": { status: "auth_error", httpStatus: 403 },
    },
    overrides: { concurrency: 1 },
  });
  const { body } = await run(h);
  assertEquals(body.stopped_early, true);
  assertEquals(h.lookups, ["https://a.example/"]);
  assertEquals(h.marked, []);
});

Deno.test("the time budget stops taking new pages", async () => {
  let clock = 0;
  const h = harness({
    batch: [page("p1", "https://a.example"), page("p2", "https://b.example")],
    overrides: {
      concurrency: 1,
      timeBudgetMs: 1000,
      now: () => clock,
      createLookUp: () => () => {
        clock += 2000;
        return Promise.resolve({ status: "clean" });
      },
    },
  });
  const { body } = await run(h);
  assertEquals(body.checked, 1);
  assertEquals(body.stopped_early, true);
  assertEquals(h.marked, [["p1"]]);
});

Deno.test("the time budget also stops inside a page, leaving that page unchecked", async () => {
  let clock = 0;
  const h = harness({
    batch: [
      page("long", "https://a.example", "https://b.example https://c.example"),
    ],
    overrides: {
      concurrency: 1,
      timeBudgetMs: 1000,
      now: () => clock,
      createLookUp: () => (uri) => {
        h.lookups.push(uri);
        clock += 600;
        return Promise.resolve({ status: "clean" });
      },
    },
  });
  const { body } = await run(h);
  assertEquals(h.lookups, ["https://a.example/", "https://b.example/"]);
  assertEquals(body.stopped_early, true);
  assertEquals(body.checked, 0);
  assertEquals(body.skipped_errors, 1);
  assertEquals(h.marked, []);
});

Deno.test("missing Web Risk key -> 500 and nothing is fetched or marked", async () => {
  for (const key of [undefined, "", "   "]) {
    const h = harness({
      batch: [page("p1", "https://a.example")],
      overrides: { getWebRiskApiKey: () => key },
    });
    const { status, body } = await run(h);
    assertEquals(status, 500);
    assert(String(body.error).includes("GOOGLE_WEB_RISK_API_KEY"));
    assertEquals(h.batchLimits, []);
    assertEquals(h.lookups, []);
    assertEquals(h.marked, []);
  }
});

Deno.test("batch failure -> 500 without lookups", async () => {
  const h = harness({
    overrides: { fetchBatch: () => Promise.reject(new Error("rpc failed")) },
  });
  const { status } = await run(h);
  assertEquals(status, 500);
  assertEquals(h.lookups, []);
});

Deno.test("mark failure -> 500, but emails for new flags still go out", async () => {
  const h = harness({
    batch: [page("p1", "https://evil.example")],
    results: { "https://evil.example/": FLAG_MALWARE },
    overrides: { markChecked: () => Promise.reject(new Error("rpc failed")) },
  });
  const { status, body } = await run(h);
  assertEquals(status, 500);
  assertEquals(body.checked, 0);
  assertEquals(body.quarantined, 1);
  assertEquals(h.emails.length, 1);
});

// ── Email ───────────────────────────────────────────────────────────────

Deno.test("no email when nothing is flagged", async () => {
  const h = harness({
    batch: [page("p1", "https://a.example", null, "owner")],
  });
  await run(h);
  assertEquals(h.emails, []);
});

Deno.test("no email when a flagged value already changed (no new flag)", async () => {
  const h = harness({
    batch: [page("p1", "https://evil.example", null, "owner")],
    results: { "https://evil.example/": FLAG_MALWARE },
    quarantineResult: () => null,
  });
  const { body } = await run(h);
  assertEquals(body.flagged, 1);
  assertEquals(body.quarantined, 0);
  assertEquals(h.marked, [["p1"]]);
  assertEquals(h.emails, []);
});

Deno.test("one admin summary per run; roaster emails only for managed pages", async () => {
  const h = harness({
    batch: [
      page("managed", "https://evil.example/a?token=abc", null, "owner-1"),
      page("unmanaged", null, "see www.phish.example/login"),
    ],
    results: {
      "https://evil.example/a?token=abc": FLAG_MALWARE,
      "https://www.phish.example/login": {
        status: "flagged",
        threatTypes: ["SOCIAL_ENGINEERING"],
      },
    },
  });
  await run(h);

  const admin = h.emails.filter((email) => email.to === "admin@timer.coffee");
  const roaster = h.emails.filter((email) => email.to !== "admin@timer.coffee");
  assertEquals(admin.length, 1);
  assertEquals(roaster.length, 1);
  assertEquals(h.userLookups, ["owner-1"]);

  const summary = admin[0];
  for (
    const expected of [
      "Roaster managed (managed-slug)",
      "Roaster unmanaged (unmanaged-slug)",
      "evil.example",
      "www.phish.example",
      "MALWARE",
      "SOCIAL_ENGINEERING",
      "Website",
      "Description",
      "hidden",
    ]
  ) {
    assert(summary.text.includes(expected), `admin text has ${expected}`);
  }
  // Host only: never the path or query string.
  for (const email of h.emails) {
    for (const part of [email.text, email.html, email.subject]) {
      assert(!part.includes("token=abc"));
      assert(!part.includes("/login"));
      assert(!part.includes("https://evil.example"));
    }
  }

  const notice = roaster[0];
  assertEquals(notice.to, "owner-1@roaster.example");
  assertEquals(notice.reply_to, "support@timer.coffee");
  assert(notice.text.includes("evil.example"));
  assert(notice.text.includes("malware"));
  assert(notice.text.includes("https://www.timer.coffee/roaster-admin/"));
  assert(notice.text.includes("support@timer.coffee"));
  assert(
    notice.html.includes('href="https://www.timer.coffee/roaster-admin/"'),
  );
});

Deno.test("email failures are logged and never fail the run", async () => {
  const h = harness({
    batch: [page("p1", "https://evil.example", null, "owner-1")],
    results: { "https://evil.example/": FLAG_MALWARE },
    overrides: {
      sendEmail: () =>
        Promise.reject(new Error("Resend responded with HTTP 500")),
      getRoasterPages: () => Promise.reject(new Error("lookup failed")),
    },
  });
  const { status, body } = await run(h);
  assertEquals(status, 200);
  assertEquals(body.quarantined, 1);
  assertEquals(h.marked, [["p1"]]);
  const errors = h.logs.filter((line) => line.level === "error");
  assert(errors.some((line) => line.message.includes("Admin link scan email")));
  assert(
    errors.some((line) => line.message.includes("Roaster link scan email")),
  );
});

Deno.test("a missing admin address or roaster email skips just that email", async () => {
  const h = harness({
    batch: [page("p1", "https://evil.example", null, "owner-1")],
    results: { "https://evil.example/": FLAG_MALWARE },
    overrides: {
      adminEmail: undefined,
      getUserEmail: () => Promise.resolve(null),
    },
  });
  const { status } = await run(h);
  assertEquals(status, 200);
  assertEquals(h.emails, []);
});

// ── Secrets and URLs stay out of requests and logs ──────────────────────

Deno.test("the Web Risk key never appears in request URLs or logs; logs carry hosts only", async () => {
  const requestUrls: string[] = [];
  const h = harness({
    batch: [
      page("p1", "https://evil.example/a?session=s3cr3t", null, "owner-1"),
      page("p2", "https://slow.example/b?q=private"),
      page("p3", "https://ok.example/c?x=1"),
    ],
    overrides: {
      createLookUp: (apiKey) => {
        const client = createWebRiskClient({
          apiKey,
          fetch: (url, init) => {
            requestUrls.push(url);
            assertEquals(
              new Headers(init.headers).get("X-Goog-Api-Key"),
              WEB_RISK_KEY,
            );
            const uri = new URL(url).searchParams.get("uri") ?? "";
            if (uri.startsWith("https://evil.example")) {
              return Promise.resolve(
                Response.json({ threat: { threatTypes: ["MALWARE"] } }),
              );
            }
            if (uri.startsWith("https://slow.example")) {
              return Promise.reject(
                new Error(`Request timeout after 5000ms: ${url}`),
              );
            }
            return Promise.resolve(Response.json({}));
          },
        });
        return (uri) => client.lookUp(uri);
      },
    },
  });
  const { status, body } = await run(h);
  assertEquals(status, 200);
  assertEquals(body.flagged, 1);
  assertEquals(body.skipped_errors, 1);
  assertEquals(requestUrls.length, 3);
  for (const url of requestUrls) {
    assert(!url.includes(WEB_RISK_KEY), "key must not be in the request URL");
  }

  const logged = JSON.stringify(h.logs);
  assert(!logged.includes(WEB_RISK_KEY), "key must not be logged");
  assert(!logged.includes(SERVICE_KEY), "service key must not be logged");
  for (const secret of ["session=s3cr3t", "q=private", "x=1", "https://"]) {
    assert(!logged.includes(secret), `logs must not include ${secret}`);
  }
  assert(logged.includes("evil.example"));
  assert(logged.includes("slow.example"));
  assert(
    h.emails.every((email) => !JSON.stringify(email).includes(WEB_RISK_KEY)),
  );
});
