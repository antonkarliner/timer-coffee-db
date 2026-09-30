// Only synthetic credentials are used. No request can reach a real project.
for (
  const [name, value] of Object.entries({
    SUPABASE_URL: "https://ratings-test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "eyJ" + "x".repeat(120),
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      type: "service_account",
      project_id: "test",
      private_key: "test",
      client_email: "test@example.com",
    }),
    CRON_JOB_SECRET: "synthetic-test-token-01234567890123456789",
    ALLOWED_ORIGINS: "https://www.timer.coffee,https://timer.coffee",
  })
) Deno.env.set(name, value);
const { handler } = await import("../../get-app-store-ratings/index.ts");
const { collectorGate } = await import("./http.ts");

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
const request = (method: string, headers: Record<string, string> = {}) =>
  new Request(
    "https://ratings-test.supabase.co/functions/v1/get-app-store-ratings",
    { method, headers },
  );
const snapshots = [{
  store: "app_store",
  app_id: "6449322787",
  average_rating: 4.8,
  rating_count: 100,
  source_date: "2026-09-30",
  fetched_at: "2026-09-30T04:00:00Z",
  methodology: "weighted_storefront_averages",
  is_approximate: true,
  coverage: {},
}];

Deno.test("HTTP collector gate accepts only existing privileged credentials and supports preflight", () => {
  equal(collectorGate(request("POST"))?.status, 401);
  equal(
    collectorGate(request("POST", { Authorization: "Bearer user-jwt" }))
      ?.status,
    401,
  );
  equal(
    collectorGate(
      request("POST", { "X-System-Token": Deno.env.get("CRON_JOB_SECRET")! }),
    ),
    null,
  );
  equal(
    collectorGate(
      request("POST", {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      }),
    ),
    null,
  );
  const preflight = collectorGate(request("OPTIONS"))!;
  equal(preflight.status, 200);
  equal(preflight.headers.get("X-Content-Type-Options"), "nosniff");
  equal(collectorGate(request("GET"))?.status, 405);
});
Deno.test("public ratings response preserves caching over shared no-store headers and supports ETag and HEAD", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (
      !String(url).startsWith(
        "https://ratings-test.supabase.co/rest/v1/app_store_ratings?",
      )
    ) throw new Error("Unexpected test network request");
    return Promise.resolve(
      new Response(JSON.stringify(snapshots), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  try {
    const response = await handler(
      request("GET", { Origin: "https://www.timer.coffee" }),
    );
    equal(response.status, 200);
    equal(
      response.headers.get("Cache-Control")?.includes("s-maxage=3600"),
      true,
    );
    equal(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://www.timer.coffee",
    );
    equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    equal((await response.json()).missingStores, ["google_play"]);
    const cached = await handler(
      request("GET", { "If-None-Match": response.headers.get("ETag")! }),
    );
    equal(cached.status, 304);
    equal(await cached.text(), "");
    const head = await handler(request("HEAD"));
    equal(head.status, 200);
    equal(await head.text(), "");
  } finally {
    globalThis.fetch = previous;
  }
});
Deno.test("empty and failed snapshots are not cached and endpoint denies writes", async () => {
  const previous = globalThis.fetch;
  let failed = false;
  globalThis.fetch = () =>
    Promise.resolve(
      failed
        ? new Response(JSON.stringify({ message: "synthetic failure" }), {
          status: 503,
        })
        : new Response("[]", {
          headers: { "Content-Type": "application/json" },
        }),
    );
  try {
    const empty = await handler(request("GET"));
    equal(empty.headers.get("Cache-Control"), "no-store");
    equal((await empty.json()).missingStores, ["app_store", "google_play"]);
    failed = true;
    const response = await handler(request("GET"));
    equal(response.status, 503);
    equal(response.headers.get("Cache-Control")?.includes("no-store"), true);
    equal(await response.json(), { error: "ratings_unavailable" });
    equal((await handler(request("POST"))).status, 405);
  } finally {
    globalThis.fetch = previous;
  }
});
