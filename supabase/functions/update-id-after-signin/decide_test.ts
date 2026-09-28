import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  decideAfterOldUserLookup,
  decideBeforeOldUserLookup,
} from "./decide.ts";

const signedInCaller = { id: "new-user", isAnonymous: false };

Deno.test("rejects an anonymous caller", () => {
  assertEquals(
    decideBeforeOldUserLookup(
      { id: "anonymous-user", isAnonymous: true },
      "old-user",
      "anonymous-user",
    ),
    {
      kind: "reject",
      status: 403,
      error: "Anonymous callers cannot migrate user data",
    },
  );
});

Deno.test("rejects a newUserId that differs from the caller", () => {
  assertEquals(
    decideBeforeOldUserLookup(signedInCaller, "old-user", "other-user"),
    {
      kind: "reject",
      status: 403,
      error: "newUserId must match the authenticated user",
    },
  );
});

Deno.test("skips when oldUserId is the caller", () => {
  assertEquals(
    decideBeforeOldUserLookup(signedInCaller, "new-user", "new-user"),
    { kind: "skip", reason: "same_user" },
  );
});

Deno.test("requests an old-user lookup after cheap checks pass", () => {
  assertEquals(
    decideBeforeOldUserLookup(signedInCaller, "old-user", "new-user"),
    { kind: "lookup_old_user" },
  );
});

Deno.test("skips when the old user is missing", () => {
  assertEquals(
    decideAfterOldUserLookup(signedInCaller, "old-user", { found: false }),
    { kind: "skip", reason: "old_user_missing" },
  );
});

Deno.test("skips when the old user is not anonymous", () => {
  assertEquals(
    decideAfterOldUserLookup(signedInCaller, "old-user", {
      found: true,
      isAnonymous: false,
    }),
    { kind: "skip", reason: "old_user_not_anonymous" },
  );
});

Deno.test("migrates an anonymous old user into the caller", () => {
  assertEquals(
    decideAfterOldUserLookup(signedInCaller, "old-user", {
      found: true,
      isAnonymous: true,
    }),
    { kind: "migrate", oldUserId: "old-user", newUserId: "new-user" },
  );
});
