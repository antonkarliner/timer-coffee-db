import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import { type BroadcastDeps, sendBroadcast } from "./broadcast-notification.ts";

const params = {
  title: "Coffee",
  body: "Time",
  data: {},
  priority: "normal" as const,
  platform: "ios" as const,
  locale: "en",
  translate: true,
  target_user_ids: ["operator"],
  audienceFilter: { regions: ["EU"] },
};
function fixture(
  rows: {
    id: string;
    token: string;
    device_type: string;
    locale: string | null;
  }[],
  error: { message: string } | null = null,
) {
  const rpcCalls: unknown[] = [];
  const sends: Record<string, unknown>[] = [];
  const deps: BroadcastDeps = {
    supabase: {
      from: () => {
        throw new Error("Filtered sends must not use the old query");
      },
      rpc: (name, args) => {
        rpcCalls.push([name, args]);
        return Promise.resolve({ data: rows, error });
      },
    },
    fetch: (_url, init) => {
      sends.push(JSON.parse(String((init as RequestInit)?.body)));
      return Promise.resolve(Response.json({ notificationId: "n" }));
    },
    translateNotificationBatch: (locales, title, body, data) =>
      Promise.resolve(
        new Map(locales.map((locale) => [locale, { title, body, data }])),
      ),
    serviceRoleKey: "test",
    sendFunctionUrl: "https://example.test/send",
  };
  return { deps, rpcCalls, sends };
}
Deno.test("filtered broadcast selects via RPC and translates only returned locales", async () => {
  const f = fixture(
    ["de", "de", "pt"].map((locale, i) => ({
      id: String(i),
      token: String(i),
      device_type: "ios",
      locale,
    })),
  );
  const r = await sendBroadcast(params, "trace", f.deps);
  assertEquals(f.rpcCalls, [["get_broadcast_tokens", {
    p_target_device_types: ["ios"],
    p_target_user_ids: ["operator"],
    p_audience_filter: { regions: ["EU"] },
  }]]);
  assertEquals(r.targetLocales, ["en", "de", "pt"]);
  assertEquals(f.sends.map((s) => s.locale), ["de", "pt"]);
  assertEquals(r.totalTargeted, 3);
});
Deno.test("filtered no-token result skips translation and sends", async () => {
  const f = fixture([]);
  f.deps.translateNotificationBatch = () => {
    throw new Error("No translation expected");
  };
  const r = await sendBroadcast(params, "trace", f.deps);
  assertEquals(r.noTokens, true);
  assertEquals(r.totalTargeted, 0);
  assertEquals(f.sends, []);
});
Deno.test("filtered RPC failure propagates before any send", async () => {
  const f = fixture([], { message: "database unavailable" });
  await assertRejects(() => sendBroadcast(params, "trace", f.deps));
  assertEquals(f.sends, []);
});
Deno.test("filtered NULL locale retains English fallback with non-English source", async () => {
  const f = fixture([{
    id: "a",
    token: "t",
    device_type: "ios",
    locale: null,
  }]);
  const r = await sendBroadcast({ ...params, locale: "de" }, "trace", f.deps);
  assertEquals(r.totalTargeted, 1);
  assertEquals(f.sends[0].locale, "en");
});
Deno.test("filtered non-translated broadcast sends exactly returned tokens", async () => {
  const f = fixture([{
    id: "a",
    token: "t",
    device_type: "ios",
    locale: "de",
  }]);
  const r = await sendBroadcast(
    { ...params, translate: false },
    "trace",
    f.deps,
  );
  assertEquals(r.totalTargeted, 1);
  assertEquals(f.sends[0].tokens, [{
    id: "a",
    token: "t",
    device_type: "ios",
    locale: "de",
  }]);
});
