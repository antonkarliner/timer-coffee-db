import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  buildSearchQueries,
  discoverCandidateSources,
  normalizeDiscoveryUrl,
} from "./search-discovery.ts";

Deno.test("builds one official and at most three distinct bean queries", () => {
  const queries = buildSearchQueries("Loom", [
    { coffee_bean_name: "Halo", source_record: { origin: "Ethiopia" } },
    { coffee_bean_name: "Halo", source_record: { origin: "Ethiopia" } },
    { coffee_bean_name: "Finca", source_record: { origin: "Colombia" } },
    { coffee_bean_name: "Gesha", source_record: { origin: "Panama" } },
    { coffee_bean_name: "Fourth", source_record: { origin: "Kenya" } },
  ]);
  assertEquals(queries.length, 4);
  assertEquals(queries.map((query) => query.kind), [
    "roaster_official",
    "roaster_bean",
    "roaster_bean",
    "roaster_bean",
  ]);
});

Deno.test("normalizes HTTP URLs and rejects invalid or binary URLs", () => {
  assertEquals(normalizeDiscoveryUrl("mailto:test@example.com"), null);
  assertEquals(normalizeDiscoveryUrl("not a URL"), null);
  assertEquals(normalizeDiscoveryUrl("https://example.com/menu.pdf"), null);
  assertEquals(
    normalizeDiscoveryUrl("https://example.com/?utm_source=x#top"),
    "https://example.com/",
  );
});

Deno.test("ranks contributed and bean-specific leads while filtering duplicates and aggregators", async () => {
  const result = await discoverCandidateSources({
    clusterName: "Loom",
    candidates: [{
      coffee_bean_name: "Halo",
      source_record: { origin: "Ethiopia" },
    }],
    contributedWebsite: "https://loom.coffee/about",
    search: (query) =>
      Promise.resolve(
        query.kind === "roaster_official"
          ? [
            { link: "https://instagram.com/loom", title: "Instagram" },
            { link: "https://generic.example/loom", title: "Generic" },
          ]
          : [
            { link: "https://bean.example/loom-halo", title: "Halo" },
            {
              link: "https://bean.example/loom-halo#duplicate",
              title: "Duplicate",
            },
            { link: "https://files.example/catalog.pdf", title: "PDF" },
          ],
      ),
  });
  assertEquals(result.candidate_urls[0], "https://loom.coffee/about");
  assertEquals(result.candidate_urls[1], "https://bean.example/loom-halo");
  assertEquals(result.search_evidence.results[0].query_kind, "roaster_bean");
  assertEquals(result.search_evidence.results.length, 2);
  assertEquals(result.provider_failure_count, 0);
});

Deno.test("provider failure returns safe empty discovery", async () => {
  const result = await discoverCandidateSources({
    clusterName: "Loom",
    candidates: [],
    search: () => Promise.reject(new Error("provider unavailable")),
  });
  assertEquals(result, {
    search_evidence: { source: "worker_cluster_search_v2", results: [] },
    candidate_urls: [],
    provider_failure_count: 1,
  });
});
