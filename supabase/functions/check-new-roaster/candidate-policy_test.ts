import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  buildCandidateInsert,
  decideCandidateCapture,
} from "./candidate-policy.ts";

Deno.test("only a positive safe integer linked id skips capture", () => {
  assertEquals(decideCandidateCapture({ coffee_roaster_id: 42 }), {
    kind: "already_linked",
    coffee_roaster_id: 42,
  });
  for (
    const value of [
      null,
      undefined,
      0,
      -1,
      1.5,
      "42",
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    assertEquals(decideCandidateCapture({ coffee_roaster_id: value }), {
      kind: "capture_candidate",
    });
  }
});

Deno.test("unlinked name collisions remain capture candidates", () => {
  for (const roaster of ["Aldi", "Loom", "1", "Tim Wendelboe"]) {
    assertEquals(decideCandidateCapture({ roaster }), {
      kind: "capture_candidate",
    });
  }
});

Deno.test("candidate insert contains raw context and no guesses", () => {
  const payload = buildCandidateInsert({
    id: 7,
    roaster: " Aldi ",
    name: " Ethiopia ",
    origin: "Ethiopia",
    farm: "Halo Beriti",
  });
  assertEquals(payload.roaster, "Aldi");
  assertEquals(payload.coffee_bean_name, "Ethiopia");
  assertEquals(payload.similar_candidates, []);
  assertEquals(payload.google_search_results, []);
  assertEquals(payload.bean_search_results, []);
  assertEquals(payload.location, null);
  assertEquals(JSON.parse(payload.notes).source_record, {
    id: 7,
    origin: "Ethiopia",
    region: null,
    farm: "Halo Beriti",
    farmer: null,
    variety: null,
    processing_method: null,
    tasting_notes: null,
    cupping_score: null,
  });
});
