import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  buildPolicyV2Context,
  finalDisposition,
  shouldRestartForPolicyV2,
  validationReasons,
} from "./evidence-policy.ts";

Deno.test("sanitizes prompt context and retains only legacy counts", () => {
  const result = buildPolicyV2Context({
    candidates: [{
      id: 1,
      roaster: "Loom",
      coffee_bean_name: "Halo",
      notes: JSON.stringify({ source_record: { origin: "Ethiopia" } }),
      location: { address: "guessed" },
      similar_candidates: [{ roaster_name: "Bloom" }],
      google_search_results: [{ link: "https://legacy.example" }],
    }],
    userContribution: { website_url: "https://loom.coffee", city: "Paris" },
  });
  assertEquals(result.candidate_context, {
    candidates: [{
      id: 1,
      roaster: "Loom",
      coffee_bean_name: "Halo",
      source_record: { origin: "Ethiopia" },
    }],
    user_contribution: {
      website_url: "https://loom.coffee",
      instagram_url: null,
      city: "Paris",
      country: null,
    },
    search_evidence: { source: "worker_cluster_search_v2", results: [] },
  });
  assertEquals(result.legacy_upstream_telemetry, {
    candidate_count: 1,
    rows_with_location: 1,
    rows_with_stored_search_results: 1,
  });
});

Deno.test("validation policy enforces confidence, conflicts, location, and reenrichment", () => {
  assertEquals(
    validationReasons({
      extraction: {
        proposed: {
          roaster_name: "Loom",
          roaster_website_url: "https://loom.coffee",
          country: "France",
        },
        confidence: 0.79,
        conflicts: [],
      },
    }),
    ["low_confidence", "proposed_location"],
  );
  assertEquals(
    validationReasons({
      extraction: {
        proposed: {
          roaster_name: "Loom",
          roaster_website_url: "https://loom.coffee",
          country: null,
        },
        confidence: 0.9,
        conflicts: ["domain conflict"],
      },
      reenrichment: {},
    }),
    ["missing_required_fields", "conflicts", "reenrichment_context"],
  );
});

Deno.test("an Instagram-only or website-only identity both satisfy validation", () => {
  // Instagram-only: legitimate since plan 030, no missing_required_fields.
  assertEquals(
    validationReasons({
      extraction: {
        proposed: {
          roaster_name: "Loom",
          roaster_website_url: null,
          instagram_url: "https://www.instagram.com/loom_coffee/",
          country: "France",
        },
        confidence: 0.9,
        conflicts: [],
      },
    }),
    ["proposed_location"],
  );
  // Website-only: unchanged behaviour.
  assertEquals(
    validationReasons({
      extraction: {
        proposed: {
          roaster_name: "Loom",
          roaster_website_url: "https://loom.coffee",
          instagram_url: null,
          country: null,
        },
        confidence: 0.9,
        conflicts: [],
      },
    }),
    ["missing_required_fields"],
  );
  // Neither a website nor an Instagram URL: still missing required fields.
  assertEquals(
    validationReasons({
      extraction: {
        proposed: {
          roaster_name: "Loom",
          roaster_website_url: null,
          instagram_url: null,
          country: null,
        },
        confidence: 0.9,
        conflicts: [],
      },
    }),
    ["missing_required_fields"],
  );
});

Deno.test("final disposition requires clean high-confidence evidence", () => {
  assertEquals(finalDisposition({ confidence: 0.79 }), "needs_review");
  assertEquals(
    finalDisposition({ confidence: 0.9, validatorNeedsReview: true }),
    "needs_review",
  );
  assertEquals(
    finalDisposition({ confidence: 0.9, unresolvedConflicts: ["country"] }),
    "needs_review",
  );
  assertEquals(
    finalDisposition({ confidence: 0.9, unresolvedConflicts: [] }),
    "completed",
  );
});

Deno.test("old active stage data restarts at most once", () => {
  assertEquals(
    shouldRestartForPolicyV2({
      state: "queued",
      stage: "summary",
      stage_data: {},
    }),
    true,
  );
  assertEquals(
    shouldRestartForPolicyV2({
      state: "queued",
      stage: "summary",
      stage_data: { policy_v2_restart_applied: true },
    }),
    false,
  );
  assertEquals(
    shouldRestartForPolicyV2({ state: "done", stage: "done", stage_data: {} }),
    false,
  );
  assertEquals(
    shouldRestartForPolicyV2({
      state: "running",
      stage: "summary",
      stage_data: { evidence_policy_version: 2 },
    }),
    false,
  );
});
