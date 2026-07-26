import { authorizeServiceRole } from "./service-role-auth.ts";

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
