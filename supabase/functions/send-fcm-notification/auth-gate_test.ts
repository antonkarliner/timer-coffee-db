import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import { gateSendFcmRequest } from "./auth-gate.ts";

for (const role of ["anon", "authenticated", "admin"]) {
  Deno.test(`FCM gate denies ${role} JWT bearer`, () => {
    const token = `eyJhbGciOiJIUzI1NiJ9.${
      btoa(JSON.stringify({ role }))
    }.signature`;
    const result = gateSendFcmRequest(
      new Request("https://example.com", {
        headers: { authorization: `Bearer ${token}` },
      }),
      "service-secret",
    );
    assertEquals(result, {
      authorized: false,
      status: 403,
      error: "Service-role authorization is required.",
    });
  });
}
Deno.test("FCM gate denies missing header", () => {
  assertEquals(
    gateSendFcmRequest(new Request("https://example.com"), "service-secret"),
    {
      authorized: false,
      status: 401,
      error: "Missing Authorization header.",
    },
  );
});
const serviceHeaders: Record<string, string>[] = [
  { authorization: "Bearer service-secret" },
  { apikey: "service-secret" },
];
for (const headers of serviceHeaders) {
  Deno.test(`FCM gate accepts service ${Object.keys(headers)[0]}`, () => {
    assertEquals(
      gateSendFcmRequest(
        new Request("https://example.com", { headers }),
        "service-secret",
      ),
      { authorized: true },
    );
  });
}
const indexUrl = new URL("./index.ts", import.meta.url);
Deno.test({
  name: "FCM gate precedes body parsing and token lookup",
  // Needs `--allow-read`; skipped (not failed) under a plain `deno test`.
  ignore: Deno.permissions.querySync({ name: "read", path: indexUrl })
    .state !== "granted",
  fn: async () => {
    const source = await Deno.readTextFile(indexUrl);
    const gate = source.indexOf("gateSendFcmRequest(req, serviceRoleKey)");
    assertEquals(gate >= 0, true);
    for (
      const operation of [
        "req.json()",
        "getActiveTokens(",
        'req.headers.get("content-length")',
      ]
    ) {
      assertEquals(source.indexOf(operation) > gate, true, operation);
    }
  },
});
