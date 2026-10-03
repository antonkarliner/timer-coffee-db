import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import { sendFCMMulticast, type ServiceAccount } from "./fcm-http-client.ts";
const account = {} as ServiceAccount; // Injected sender never authenticates.
Deno.test("1600 tokens run concurrently with stable response positions", async () => {
  const tokens = Array.from({ length: 1600 }, (_, i) => String(i));
  let inFlight = 0;
  let maxInFlight = 0;
  const start = performance.now();
  const result = await sendFCMMulticast(
    account,
    tokens,
    { title: "Test", body: "Test" },
    25,
    async (_account, message) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const index = Number(message.token);
      await new Promise((resolve) => setTimeout(resolve, 20 + index % 3));
      inFlight--;
      return index % 4 === 0
        ? { success: false, error: String(index) }
        : { success: true, messageId: String(index) };
    },
  );
  const elapsed = performance.now() - start;
  assert(maxInFlight <= 25);
  assert(maxInFlight > 1);
  assertEquals(result.successCount, 1200);
  assertEquals(result.failureCount, 400);
  for (let i = 0; i < tokens.length; i++) {
    assertEquals(
      result.responses[i].messageId ?? result.responses[i].error,
      String(i),
    );
  }
  assert(
    elapsed < 8000,
    `Expected far below 32s sequential time, got ${elapsed}ms`,
  );
  console.log(
    `1600 tokens: ${Math.round(elapsed)}ms; max in-flight: ${maxInFlight}`,
  );
});
Deno.test("default concurrency is 25 and per-token transport failures remain aligned", async () => {
  let active = 0;
  let max = 0;
  const result = await sendFCMMulticast(
    account,
    Array.from({ length: 60 }, (_, i) => String(i)),
    { title: "Test", body: "Test" },
    undefined,
    async (_account, message) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (message.token === "3") throw new Error("offline");
      return { success: true, messageId: message.token };
    },
  );
  assertEquals(max, 25);
  assertEquals(result.failureCount, 1);
  assertEquals(result.responses[3].errorCode, "transport_error");
  assertEquals(result.responses[4].messageId, "4");
});
Deno.test("empty multicast and invalid concurrency", async () => {
  assertEquals(await sendFCMMulticast(account, [], { title: "T", body: "B" }), {
    responses: [],
    successCount: 0,
    failureCount: 0,
  });
  await assertRejects(
    () => sendFCMMulticast(account, ["a"], { title: "T", body: "B" }, 0),
    RangeError,
  );
});
Deno.test("concurrency override and high priority payload", async () => {
  let active = 0;
  let max = 0;
  await sendFCMMulticast(
    account,
    Array.from({ length: 20 }, (_, i) => String(i)),
    { title: "T", body: "B", priority: "high", data: { key: "value" } },
    7,
    async (_account, message) => {
      active++;
      max = Math.max(max, active);
      assertEquals(message.android?.priority, "high");
      assertEquals(message.apns?.headers?.["apns-priority"], "10");
      assertEquals(message.data, { key: "value" });
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { success: true };
    },
  );
  assertEquals(max, 7);
});
