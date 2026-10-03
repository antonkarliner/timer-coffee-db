import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import type { BroadcastDeps } from "./broadcast-notification.ts";
import { sendBroadcast } from "./broadcast-notification.ts";
import {
  bucketAction,
  completionStatus,
  type DeliveryState,
  type LocalTimeJob,
  processLocalTimeJob,
} from "./local-time-broadcast.ts";
import {
  defaultLocalScheduleAt,
  localScheduleError,
} from "./local-time-schedule.ts";

const base: LocalTimeJob = {
  id: "job",
  title: "Coffee",
  body: "Time",
  data: {},
  priority: "normal",
  platform: "ios",
  locale: "en",
  translate: true,
  target_user_ids: ["operator"],
  translated_payloads: null,
};
const complete: DeliveryState = {
  window_closed: true,
  fallback_done: true,
  unclaimed: 0,
  active_sends: 0,
  partial_failures: 0,
  counts: { sent: 1, failed: 1 },
};
Deno.test("completion waits for all zones, fallback, unclaimed and active buckets", () => {
  assertEquals(completionStatus(complete), "sent");
  assertEquals(completionStatus({ ...complete, window_closed: false }), null);
  assertEquals(completionStatus({ ...complete, fallback_done: false }), null);
  assertEquals(completionStatus({ ...complete, unclaimed: 1 }), null);
  assertEquals(completionStatus({ ...complete, active_sends: 1 }), null);
  assertEquals(
    completionStatus({
      ...complete,
      counts: { failed: 1, skipped: 1, sending: 1 },
    }),
    "failed",
  );
  assertEquals(completionStatus({ ...complete, counts: {} }), "failed");
});
Deno.test("lateness skips only buckets strictly past the SQL window", () => {
  assertEquals(bucketAction(false), "sending");
  assertEquals(bucketAction(true), "skipped");
});
Deno.test("local schedule requires a real date, valid time, broadcast and no recurrence", () => {
  const good = {
    deliver_local_date: "2026-12-01",
    deliver_local_time: "09:00",
    audience: "broadcast",
    recurrence: "none",
  };
  assertEquals(localScheduleError(good), null);
  assertEquals(
    defaultLocalScheduleAt(good.deliver_local_date, good.deliver_local_time)
      .toISOString(),
    "2026-12-01T09:00:00.000Z",
  );
  for (
    const change of [
      { deliver_local_date: "2026-02-30" },
      { deliver_local_time: "24:00" },
      { deliver_local_date: null },
      { audience: "user" },
      { recurrence: "daily" },
    ]
  ) {
    assertEquals(localScheduleError({ ...good, ...change }) !== null, true);
  }
  assertEquals(localScheduleError({}), null);
});
function fixture() {
  let translationOwned = false;
  let translations = 0;
  let clock = 0;
  let failSend = false;
  let finishError = false;
  let failTranslation = false;
  let state: DeliveryState = { ...complete, window_closed: false };
  let cache: LocalTimeJob["translated_payloads"] = null;
  const claims = new Map<string, Record<string, unknown>>();
  const sends: Record<string, unknown>[] = [];
  const events: string[] = [];
  const rpcArgs: Record<string, unknown>[] = [];
  const jobUpdates: Record<string, unknown>[] = [];
  let buckets = [{ bucket: "Europe/Paris", token_count: 1, too_late: false }, {
    bucket: "America/New_York",
    token_count: 1,
    too_late: false,
  }];
  const deps: BroadcastDeps = {
    supabase: {
      from: (table) => {
        let op = "";
        let value: Record<string, unknown> = {};
        const filters: Record<string, unknown> = {};
        const query = {
          update: (v: Record<string, unknown>) => {
            op = "update";
            value = v;
            return query;
          },
          upsert: (v: Record<string, unknown>, options: unknown) => {
            assertEquals(options, {
              onConflict: "job_id,bucket",
              ignoreDuplicates: true,
            });
            op = "insert";
            value = v;
            return query;
          },
          select: () => query,
          eq: (key: string, v: unknown) => {
            filters[key] = v;
            return query;
          },
          then: (resolve: (value: unknown) => unknown) => {
            let data: unknown = [];
            let error: { message: string } | null = null;
            if (table === "scheduled_notifications") {
              jobUpdates.push(value);
              if (value.translated_payloads) {
                cache = value
                  .translated_payloads as LocalTimeJob["translated_payloads"];
                events.push("cache");
              }
            } else if (op === "insert") {
              const bucket = String(value.bucket);
              if (!claims.has(bucket)) {
                claims.set(bucket, value);
                data = [{ bucket }];
                events.push(`claim:${bucket}`);
              }
            } else {
              if (finishError) error = { message: "write failed" };
              else Object.assign(claims.get(String(filters.bucket))!, value);
            }
            return Promise.resolve({ data, error }).then(resolve);
          },
        };
        return query;
      },
      rpc: (name, args) => {
        if (name === "due_local_time_bucket_actions") {
          return Promise.resolve({ data: buckets, error: null }); // deliberately stale for overlap tests
        }
        if (name === "claim_scheduled_translation") {
          const owned = !translationOwned;
          translationOwned = true;
          return Promise.resolve({ data: owned, error: null });
        }
        if (name === "local_time_delivery_locales") {
          return Promise.resolve({ data: ["fr", "de", "en"], error: null });
        }
        if (name === "local_time_delivery_state") {
          return Promise.resolve({ data: state, error: null });
        }
        assertEquals(name, "get_broadcast_tokens");
        rpcArgs.push(args);
        return Promise.resolve({
          data: [{
            id: "t",
            token: "token",
            device_type: "ios",
            locale: (args.p_timezones as string[] | undefined)?.[0] ===
                "America/New_York"
              ? "en"
              : "fr",
          }],
          error: null,
        });
      },
    },
    translateNotificationBatch: (locales, title, body, data) => {
      translations++;
      events.push("translate");
      if (failTranslation) {
        return Promise.reject(new Error("translation offline"));
      }
      assertEquals([...locales].sort(), ["de", "en", "fr"]);
      return Promise.resolve(
        new Map(
          locales.map((
            locale,
          ) => [locale, { title: `${title}-${locale}`, body, data }]),
        ),
      );
    },
    fetch: (_url, init) => {
      events.push("send");
      sends.push(JSON.parse(String((init as RequestInit)?.body)));
      clock += 10;
      if (failSend) return Promise.reject(new Error("offline"));
      return Promise.resolve(
        Response.json({ success: true, notificationId: "n" }),
      );
    },
    serviceRoleKey: "test",
    sendFunctionUrl: "https://example.test/send",
    captureLocaleErrors: true,
    respectDeliveryResults: true,
  };
  return {
    deps,
    claims,
    sends,
    events,
    rpcArgs,
    jobUpdates,
    now: () => clock,
    cache: () => cache,
    translations: () => translations,
    buckets: (v: typeof buckets) => {
      buckets = v;
    },
    state: (v: DeliveryState) => {
      state = v;
    },
    failSend: () => {
      failSend = true;
    },
    finishError: () => {
      finishError = true;
    },
    failTranslation: () => {
      failTranslation = true;
    },
  };
}
Deno.test("whole-job translation persists before first send and is reused across buckets and runs", async () => {
  const f = fixture();
  await processLocalTimeJob(base, "trace", f.deps, 5, f.now); // starts one bucket
  assertEquals(f.translations(), 1);
  assertEquals(f.sends.length, 1);
  assertEquals(f.events.slice(0, 4), [
    "translate",
    "cache",
    "claim:Europe/Paris",
    "send",
  ]);
  await processLocalTimeJob(
    { ...base, translated_payloads: f.cache() },
    "trace",
    f.deps,
    100,
    f.now,
  );
  assertEquals(f.translations(), 1);
  assertEquals(f.sends.length, 2);
  assertEquals(f.sends.map((s) => s.title), ["Coffee-fr", "Coffee-en"]);
  assertEquals(f.rpcArgs[1].p_timezones, ["Europe/Paris"]);
  assertEquals(f.rpcArgs[2].p_timezones, ["America/New_York"]);
});
Deno.test("overlapping invocations prepare once and claimed buckets never resend", async () => {
  const f = fixture();
  await Promise.all([
    processLocalTimeJob(base, "trace", f.deps, 100, f.now),
    processLocalTimeJob(base, "trace", f.deps, 100, f.now),
  ]);
  await processLocalTimeJob(
    { ...base, translated_payloads: f.cache() },
    "trace",
    f.deps,
    100,
    f.now,
  );
  assertEquals(f.translations(), 1);
  assertEquals(f.sends.length, 2);
  assertEquals(f.claims.size, 2);
});
Deno.test("late buckets skip without translation, and NULL fallback uses explicit restriction", async () => {
  const f = fixture();
  f.buckets([{ bucket: "Europe/Paris", token_count: 1, too_late: true }, {
    bucket: "__no_timezone__",
    token_count: 1,
    too_late: false,
  }]);
  await processLocalTimeJob(
    { ...base, translate: false },
    "trace",
    f.deps,
    100,
    f.now,
  );
  assertEquals(f.claims.get("Europe/Paris")?.status, "skipped");
  assertEquals(f.translations(), 0);
  assertEquals(f.sends.length, 1);
  assertEquals(f.rpcArgs[0].p_null_timezone_only, true);
});
Deno.test("failed bucket transport is recorded once without resending", async () => {
  const f = fixture();
  f.failSend();
  const job = { ...base, translate: false };
  await processLocalTimeJob(job, "trace", f.deps, 100, f.now);
  await processLocalTimeJob(job, "trace", f.deps, 100, f.now);
  assertEquals(f.sends.length, 2);
  assertEquals(f.claims.get("Europe/Paris")?.status, "failed");
});
Deno.test("crash after sending leaves durable sending claim and never retries", async () => {
  const f = fixture();
  f.finishError();
  const job = { ...base, translate: false };
  try {
    await processLocalTimeJob(job, "trace", f.deps, 100, f.now);
  } catch { /* simulated lost write */ }
  assertEquals(f.claims.get("Europe/Paris")?.status, "sending");
  try {
    await processLocalTimeJob(job, "trace", f.deps, 100, f.now);
  } catch { /* second bucket lost write */ }
  assertEquals(f.sends.length, 2);
});
Deno.test("exhausted wall budget starts no new buckets", async () => {
  const f = fixture();
  await processLocalTimeJob(base, "trace", f.deps, 0, f.now);
  assertEquals(f.translations(), 0);
  assertEquals(f.claims.size, 0);
});
Deno.test("preparation crash fails closed until buckets can be skipped", async () => {
  const f = fixture();
  await processLocalTimeJob(
    { ...base, translated_payloads: { preparing: true } },
    "trace",
    f.deps,
    100,
    f.now,
  );
  assertEquals(f.sends.length, 0);
  assertEquals(f.translations(), 0);
  f.buckets([{ bucket: "Europe/Paris", token_count: 1, too_late: true }]);
  await processLocalTimeJob(
    { ...base, translated_payloads: { preparing: true } },
    "trace",
    f.deps,
    100,
    f.now,
  );
  assertEquals(f.claims.get("Europe/Paris")?.status, "skipped");
});
Deno.test("translation failure stores terminal empty cache and later buckets do not retranslate", async () => {
  const f = fixture();
  f.failTranslation();
  try {
    await processLocalTimeJob(base, "trace", f.deps, 100, f.now);
  } catch { /* cache persisted in finally */ }
  await processLocalTimeJob(
    { ...base, translated_payloads: f.cache() },
    "trace",
    f.deps,
    100,
    f.now,
  );
  assertEquals(f.translations(), 1);
  assertEquals(f.sends.length, 0);
  assertEquals(f.claims.get("Europe/Paris")?.status, "failed");
});
Deno.test("completion preserves partial success and a short failure summary", async () => {
  const f = fixture();
  f.buckets([]);
  f.state(complete);
  await processLocalTimeJob(base, "trace", f.deps, 100, f.now);
  assertEquals(f.jobUpdates[0].status, "sent");
  assertEquals(
    String(f.jobUpdates[0].failure_reason).includes('"failed":1'),
    true,
  );
});
Deno.test("helper returns computed translations and accepts them without another translation call", async () => {
  const f = fixture();
  const prepared = await sendBroadcast(
    { ...base, prepareOnly: true, translationLocales: ["fr", "de", "en"] },
    "trace",
    f.deps,
  );
  assertEquals(f.sends.length, 0);
  await sendBroadcast(
    {
      ...base,
      timezones: ["Europe/Paris"],
      precomputedTranslations: prepared.translatedPayloads,
    },
    "trace",
    f.deps,
  );
  assertEquals(f.translations(), 1);
  assertEquals(f.sends[0].title, "Coffee-fr");
});

Deno.test("default translated helper output stays compatible; cache export is opt-in", async () => {
  const f = fixture();
  const result = await sendBroadcast(
    { ...base, audienceFilter: {}, translationLocales: ["fr", "de", "en"] },
    "trace",
    f.deps,
  );
  assertEquals("translatedPayloads" in result, false);
  const exported = await sendBroadcast(
    {
      ...base,
      audienceFilter: {},
      translationLocales: ["fr", "de", "en"],
      returnTranslations: true,
    },
    "trace",
    f.deps,
  );
  assertEquals(Object.keys(exported.translatedPayloads ?? {}).sort(), [
    "de",
    "en",
    "fr",
  ]);
});
