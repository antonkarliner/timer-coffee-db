import {
  authorizeServiceRequest,
  authorizeServiceRole,
} from "./service-role-auth.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("service-role authorization distinguishes missing, user, and service tokens", () => {
  assertEquals(
    authorizeServiceRole(null, "service-secret"),
    {
      authorized: false,
      status: 401,
      error: "Missing Authorization header.",
    },
    "Missing credentials should be unauthorized.",
  );
  assertEquals(
    authorizeServiceRole("Bearer ordinary-user-jwt", "service-secret"),
    {
      authorized: false,
      status: 403,
      error: "Service-role authorization is required.",
    },
    "An ordinary authenticated-user JWT must not authorize service writes.",
  );
  assertEquals(
    authorizeServiceRole("Bearer service-secret", "service-secret"),
    { authorized: true },
    "The configured service-role bearer token should authorize the request.",
  );
});

const serviceRequestCases: Array<
  [string, Record<string, string>, string, number]
> = [
  [
    "bearer match",
    { authorization: "Bearer service-secret" },
    "service-secret",
    200,
  ],
  ["apikey match", { apikey: "service-secret" }, "service-secret", 200],
  [
    "apikey fallback",
    { authorization: "Bearer wrong", apikey: "service-secret" },
    "service-secret",
    200,
  ],
  [
    "both wrong",
    { authorization: "Bearer wrong", apikey: "wrong" },
    "service-secret",
    403,
  ],
  ["apikey-only wrong", { apikey: "wrong" }, "service-secret", 401],
  ["missing both", {}, "service-secret", 401],
  ["empty configuration, absent headers", {}, "", 500],
  [
    "empty configuration, empty headers",
    { authorization: "", apikey: "" },
    "",
    500,
  ],
  ["bearer prefix", { authorization: "Bearer service" }, "service-secret", 403],
  ["apikey prefix", { apikey: "service" }, "service-secret", 401],
  [
    "lowercase bearer",
    { authorization: "bearer service-secret" },
    "service-secret",
    200,
  ],
];
for (const [name, headers, key, status] of serviceRequestCases) {
  Deno.test(`service request authorization: ${name}`, () => {
    const result = authorizeServiceRequest(
      new Request("https://example.com", { headers }),
      key,
    );
    assertEquals(result.authorized ? 200 : result.status, status, name);
    if (status === 500 && !result.authorized) {
      assertEquals(result.error, "Service credential is not configured.", name);
    }
  });
}
