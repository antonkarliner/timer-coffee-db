// Synthetic configuration only; all database effects use the injected client.
Deno.env.set("SUPABASE_URL", "https://offline.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", `eyJ${"x".repeat(110)}`);
Deno.env.set(
  "FIREBASE_SERVICE_ACCOUNT",
  JSON.stringify({
    type: "service_account",
    project_id: "offline",
    private_key: "offline",
    client_email: "offline@example.invalid",
  }),
);
Deno.env.set("CRON_JOB_SECRET", "x".repeat(32));
Deno.env.set(
  "ALLOWED_ORIGINS",
  "https://offline.invalid,https://other.invalid",
);

const { checkIpRateLimit } = await import("./rate-limiter.ts");
type Client = NonNullable<Parameters<typeof checkIpRateLimit>[3]>;

function assert(ok: unknown): asserts ok {
  if (!ok) throw new Error("Assertion failed");
}

function fakeClient(failure?: string, count = 0) {
  const calls: string[] = [];
  const result = (operation: string) => {
    calls.push(operation);
    if (failure === "throw") throw new Error("Sensitive backend detail");
    return Promise.resolve({
      error: failure === operation
        ? { message: "Sensitive backend detail" }
        : null,
      data: operation === "count"
        ? Array.from(
          { length: count },
          () => ({ timestamp: new Date().toISOString() }),
        )
        : null,
    });
  };
  const client = {
    from(table: string) {
      assert(table === "rate_limits");
      return {
        delete: () => ({ lt: () => result("cleanup") }),
        select: () => ({
          eq: (_column: string, ip: string) => {
            assert(ip === "192.0.2.1");
            return { is: () => ({ gte: () => result("count") }) };
          },
        }),
        insert: (row: { user_id: null; ip_address: string }) => {
          assert(row.user_id === null && row.ip_address === "192.0.2.1");
          return result("insert");
        },
      };
    },
  } as unknown as Client;
  return { client, calls };
}

Deno.test("strict IP limiting fails closed for cleanup, count, insert and thrown errors", async () => {
  for (const failure of ["cleanup", "count", "insert", "throw"]) {
    const f = fakeClient(failure);
    let rejected = false;
    try {
      await checkIpRateLimit("192.0.2.1", 5, true, f.client);
    } catch (error) {
      rejected = true;
      assert(
        error instanceof Error &&
          error.message === "IP rate limit check failed",
      );
    }
    assert(rejected);
    assert(
      f.calls.join(",") ===
        (failure === "insert"
          ? "cleanup,count,insert"
          : failure === "count"
          ? "cleanup,count"
          : "cleanup"),
    );
  }
});

Deno.test("strict IP limiting allows four prior requests and denies five", async () => {
  for (const count of [4, 5]) {
    const f = fakeClient(undefined, count);
    const result = await checkIpRateLimit("192.0.2.1", 5, true, f.client);
    assert(result.allowed === (count < 5));
    assert(
      f.calls.join(",") ===
        (count < 5 ? "cleanup,count,insert" : "cleanup,count"),
    );
  }
});
