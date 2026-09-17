import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import { CandidateInsertPayload } from "./candidate-policy.ts";
import { handleCandidateWebhook } from "./handler.ts";

function request(record: Record<string, unknown>): Request {
  return new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({ type: "INSERT", record }),
  });
}

Deno.test("linked input performs no insert", async () => {
  let inserts = 0;
  const response = await handleCandidateWebhook(
    request({ roaster: "Aldi", coffee_roaster_id: 9 }),
    {
      insertCandidate: () => {
        inserts++;
        return Promise.resolve();
      },
    },
  );
  assertEquals(response.status, 200);
  assertEquals(inserts, 0);
  assertEquals((await response.json()).captured, false);
});

Deno.test("unlinked collisions insert payloads without guesses", async () => {
  const inserted: CandidateInsertPayload[] = [];
  for (const roaster of ["Aldi", "Loom", "1", "Tim Wendelboe"]) {
    await handleCandidateWebhook(
      request({ roaster, name: "Bean", coffee_roaster_id: null }),
      {
        insertCandidate: (payload) => {
          inserted.push(payload);
          return Promise.resolve();
        },
      },
    );
  }
  assertEquals(inserted.length, 4);
  for (const payload of inserted) {
    assertEquals(payload.location, null);
    assertEquals(payload.similar_candidates, []);
    assertEquals(payload.google_search_results, []);
    assertEquals(payload.bean_search_results, []);
  }
});

Deno.test("insert errors fail visibly", async () => {
  await assertRejects(
    () =>
      handleCandidateWebhook(request({ roaster: "Aldi" }), {
        insertCandidate: () => Promise.reject(new Error("insert failed")),
      }),
    Error,
    "insert failed",
  );
});

Deno.test("optional notification failures do not block capture", async () => {
  const response = await handleCandidateWebhook(request({ roaster: "Aldi" }), {
    insertCandidate: () => Promise.resolve(),
    notifyCandidate: () => Promise.reject(new Error("disabled")),
  });
  assertEquals((await response.json()).captured, true);
});
