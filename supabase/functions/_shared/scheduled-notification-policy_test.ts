import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  canManageScheduledRecipient,
  partitionScheduledJobs,
} from "./scheduled-notification-policy.ts";
Deno.test("non-admin schedule writes stay on their own user", () => {
  assertEquals(canManageScheduledRecipient(false, "self", {}), true);
  assertEquals(
    canManageScheduledRecipient(false, "self", {
      user_id: "self",
      audience: "user",
    }),
    true,
  );
  for (
    const fields of [
      { audience: "broadcast" as const },
      { user_id: "other" },
      { user_id: null },
      { target_user_ids: [] },
      { target_user_ids: null },
    ]
  ) assertEquals(canManageScheduledRecipient(false, "self", fields), false);
});
Deno.test("admins can address broadcasts and other users", () => {
  assertEquals(
    canManageScheduledRecipient(true, "self", {
      audience: "broadcast",
      target_user_ids: ["other"],
    }),
    true,
  );
  assertEquals(
    canManageScheduledRecipient(true, "self", { user_id: "other" }),
    true,
  );
});
Deno.test("only one broadcast is dispatched; user jobs stay unchanged", () => {
  const jobs = [
    { id: "u1", audience: "user" },
    { id: "b1", audience: "broadcast" },
    { id: "b2", audience: "broadcast" },
    { id: "u2" },
    { id: "b3", audience: "broadcast" },
  ];
  assertEquals(partitionScheduledJobs(jobs), {
    processJobs: [jobs[0], jobs[1], jobs[3]],
    deferredIds: ["b2", "b3"],
  });
  assertEquals(partitionScheduledJobs([]), {
    processJobs: [],
    deferredIds: [],
  });
});
