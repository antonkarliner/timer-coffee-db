import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import { resolveVerifiedUser, type TokenVerifier } from "./auth.ts";

function verifierFor(
  result: Awaited<ReturnType<TokenVerifier["getUser"]>>,
): TokenVerifier {
  return {
    getUser: () => Promise.resolve(result),
  };
}

Deno.test("rejects a missing authorization header without verifying", async () => {
  let called = false;
  const result = await resolveVerifiedUser(null, {
    getUser() {
      called = true;
      return Promise.resolve({ data: { user: null }, error: null });
    },
  });

  assertEquals(result, {
    ok: false,
    reason: "missing_or_invalid_header",
  });
  assertFalse(called);
});

Deno.test("rejects malformed bearer headers without verifying", async () => {
  const verifier = verifierFor({ data: { user: null }, error: null });

  assertEquals(await resolveVerifiedUser("Basic credentials", verifier), {
    ok: false,
    reason: "missing_or_invalid_header",
  });
  assertEquals(await resolveVerifiedUser("Bearer ", verifier), {
    ok: false,
    reason: "missing_or_invalid_header",
  });
  assertEquals(
    await resolveVerifiedUser("Bearer token with spaces", verifier),
    {
      ok: false,
      reason: "missing_or_invalid_header",
    },
  );
});

Deno.test("rejects a forged token when Supabase Auth cannot verify it", async () => {
  const result = await resolveVerifiedUser(
    "Bearer forged.jwt.value",
    verifierFor({
      data: { user: null },
      error: new Error("invalid JWT"),
    }),
  );

  assertEquals(result, { ok: false, reason: "verification_failed" });
});

Deno.test("fails closed when Supabase Auth throws", async () => {
  const result = await resolveVerifiedUser("Bearer token", {
    getUser() {
      return Promise.reject(new Error("Auth unavailable"));
    },
  });

  assertEquals(result, { ok: false, reason: "verification_failed" });
});

Deno.test("returns only the verified Supabase user id", async () => {
  const result = await resolveVerifiedUser(
    "Bearer verified.jwt.value",
    verifierFor({
      data: { user: { id: "verified-user-id" } },
      error: null,
    }),
  );

  assertEquals(result, { ok: true, userId: "verified-user-id" });
});

Deno.test("refuses a verified connected-app token", async () => {
  // Payload: {"sub":"user-id","client_id":"oauth-client"}
  const result = await resolveVerifiedUser(
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWlkIiwiY2xpZW50X2lkIjoib2F1dGgtY2xpZW50In0.signature",
    verifierFor({
      data: { user: { id: "user-id" } },
      error: null,
    }),
  );

  assertEquals(result, { ok: false, reason: "connected_app" });
});
