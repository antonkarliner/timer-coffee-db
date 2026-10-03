import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import { type BroadcastDeps, sendBroadcast } from "./broadcast-notification.ts";

const params = {
  title: "Coffee",
  body: "Time",
  data: { deep_link: "/brew" },
  priority: "normal" as const,
  platform: "ios" as const,
  locale: "en",
  translate: false,
  target_user_ids: ["user"],
};
function fixture(status = 200, empty = false) {
  const filters: unknown[] = [];
  const calls: Record<string, unknown>[] = [];
  const tokens = empty ? [] : [
    {
      id: "a",
      user_id: "user",
      token: "en-token",
      device_type: "ios",
      locale: "en",
    },
    {
      id: "b",
      user_id: "user",
      token: "fr-token",
      device_type: "ios",
      locale: "fr",
    },
  ];
  const query = {
    select: () => query,
    eq: () => query,
    in: (key: string, value: unknown) => {
      filters.push([key, value]);
      return query;
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: tokens, error: null }).then(resolve),
  };
  const deps: BroadcastDeps = {
    supabase: {
      from: () => query,
      rpc: () =>
        Promise.resolve({
          data: [{ locale: "en" }, { locale: "fr" }],
          error: null,
        }),
    },
    sendFunctionUrl: "https://example.test/send",
    serviceRoleKey: "test-key",
    fetch: (_url, init) => {
      const payload = JSON.parse(String((init as RequestInit)?.body));
      calls.push(payload);
      assertEquals(
        new Headers((init as RequestInit)?.headers).get("authorization"),
        "Bearer test-key",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify(
            status === 200
              ? {
                results: [{
                  locale: payload.locale,
                  notificationId: "notification",
                }],
              }
              : { error: "rejected" },
          ),
          { status },
        ),
      );
    },
    translateNotificationBatch: (locales, title, body, data) =>
      Promise.resolve(
        new Map(
          locales.map(
            (locale) => [locale, { title: `${title}-${locale}`, body, data }],
          ),
        ),
      ),
  };
  return { deps, calls, filters };
}
Deno.test("broadcast preserves non-translation payload, results and filters", async () => {
  const f = fixture();
  const result = await sendBroadcast(params, "trace", f.deps);
  assertEquals(result.results, [{
    notificationId: "notification",
    tokensTargeted: 2,
    success: true,
  }]);
  assertEquals(result.targetLocales, ["en", "fr"]);
  assertEquals(result.totalTargeted, 2);
  assertEquals(result.overallSuccess, true);
  assertEquals(f.filters, [["device_type", ["ios"]], ["user_id", ["user"]]]);
  assertEquals(f.calls[0], {
    userId: null,
    tokens: [{ token: "en-token", device_type: "ios", locale: "en", id: "a" }, {
      token: "fr-token",
      device_type: "ios",
      locale: "fr",
      id: "b",
    }],
    title: "Coffee",
    body: "Time",
    data: { deep_link: "/brew" },
    priority: "normal",
    platform: "ios",
    locale: "en",
  });
});
Deno.test("broadcast translates and sends each locale", async () => {
  const f = fixture();
  const r = await sendBroadcast(
    { ...params, translate: true },
    "trace",
    f.deps,
  );
  assertEquals(
    r.results,
    ["en", "fr"].map((locale) => ({
      notificationId: "notification",
      locale,
      tokensTargeted: 1,
      success: true,
    })),
  );
  assertEquals(f.calls.map((c) => c.title), ["Coffee-en", "Coffee-fr"]);
});
Deno.test("broadcast preserves no-tokens and non-translation error passthrough", async () => {
  const empty = fixture(200, true);
  assertEquals(
    (await sendBroadcast(params, "trace", empty.deps)).noTokens,
    true,
  );
  assertEquals(empty.calls.length, 0);
  const f = fixture(429);
  const r = await sendBroadcast(params, "trace", f.deps);
  assertEquals(r.httpError, { status: 429, error: "rejected" });
});
Deno.test("translated failures preserve results and missing translations skip delivery", async () => {
  const f = fixture(500);
  const r = await sendBroadcast(
    { ...params, translate: true },
    "trace",
    f.deps,
  );
  assertEquals(r.overallSuccess, false);
  assertEquals(r.results.length, 2);
  f.deps.translateNotificationBatch = () => Promise.resolve(new Map());
  const missing = await sendBroadcast(
    { ...params, translate: true },
    "trace",
    f.deps,
  );
  assertEquals(missing.results, []);
  assertEquals(missing.totalTargeted, 0);
});
Deno.test("token query errors propagate", async () => {
  const f = fixture();
  f.deps.supabase.from = () => {
    throw new Error("database unavailable");
  };
  await assertRejects(
    () => sendBroadcast(params, "trace", f.deps),
    Error,
    "database unavailable",
  );
});

Deno.test("scheduler retains successful locales when a later transport fails", async () => {
  const f = fixture();
  const original = f.deps.fetch;
  f.deps.captureLocaleErrors = true;
  f.deps.respectDeliveryResults = true;
  f.deps.fetch = (url, init) =>
    JSON.parse(String((init as RequestInit)?.body)).locale === "fr"
      ? Promise.reject(new Error("offline"))
      : original(url, init);
  const r = await sendBroadcast(
    { ...params, translate: true },
    "trace",
    f.deps,
  );
  assertEquals(r.overallSuccess, true);
  assertEquals(r.results.map((r) => r.success), [true, false]);
  assertEquals(r.failures, [{ locale: "fr", error: "offline" }]);
});
Deno.test("scheduler treats HTTP 207 with zero deliveries as failed; immediate API stays compatible", async () => {
  const f = fixture();
  f.deps.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          success: false,
          results: [{ notificationId: "n", tokensSuccessful: 0 }],
        }),
        { status: 207 },
      ),
    );
  assertEquals(
    (await sendBroadcast(params, "trace", f.deps)).overallSuccess,
    true,
  );
  f.deps.respectDeliveryResults = true;
  assertEquals(
    (await sendBroadcast(params, "trace", f.deps)).overallSuccess,
    false,
  );
  assertEquals(
    (await sendBroadcast({ ...params, translate: true }, "trace", f.deps))
      .overallSuccess,
    false,
  );
});
Deno.test("immediate translated broadcast preserves thrown transport failure", async () => {
  const f = fixture();
  f.deps.fetch = () => Promise.reject(new Error("offline"));
  await assertRejects(
    () => sendBroadcast({ ...params, translate: true }, "trace", f.deps),
    Error,
    "offline",
  );
});
Deno.test("scheduled category reaches the sender", async () => {
  const f = fixture();
  await sendBroadcast({ ...params, category: "campaign" }, "trace", f.deps);
  assertEquals(f.calls[0].category, "campaign");
});
Deno.test("scheduler records partial token failures without resending the successful locale", async () => {
  const f = fixture();
  f.deps.respectDeliveryResults = true;
  f.deps.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          success: true,
          results: [{ tokensSuccessful: 1, tokensFailed: 1 }],
        }),
      ),
    );
  const r = await sendBroadcast(params, "trace", f.deps);
  assertEquals(r.overallSuccess, true);
  assertEquals(r.failures, [{ locale: "en", error: "1 tokens failed" }]);
});
