import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  buildSearchQueries,
  discoverCandidateSources,
  normalizeDiscoveryUrl,
} from "./search-discovery.ts";

Deno.test("builds one official and at most two distinct bean queries", () => {
  const queries = buildSearchQueries("Loom", [
    { coffee_bean_name: "Halo", source_record: { origin: "Ethiopia" } },
    { coffee_bean_name: "Halo", source_record: { origin: "Ethiopia" } },
    { coffee_bean_name: "Finca", source_record: { origin: "Colombia" } },
    { coffee_bean_name: "Gesha", source_record: { origin: "Panama" } },
    { coffee_bean_name: "Fourth", source_record: { origin: "Kenya" } },
  ]);
  assertEquals(queries.length, 3);
  assertEquals(queries.map((query) => query.kind), [
    "roaster_official",
    "roaster_bean",
    "roaster_bean",
  ]);
});

Deno.test("official query anchors plural 'coffee roasters' and drops 'official'", () => {
  const [official] = buildSearchQueries("Arzuri", []);
  assertEquals(official.query, '"Arzuri" coffee roasters');
  // "coffee roaster" singular names the machine and pulled in equipment
  // vendors; "official" matched their boilerplate.
  assertEquals(official.query.includes("coffee roaster "), false);
  assertEquals(official.query.includes("official"), false);
});

Deno.test("official query omits the anchor when the name already says coffee", () => {
  for (
    const name of [
      "POGO Coffee Roasters",
      "Palarnia Blend",
      "Sat Coffee Tostador de Café",
      "倩如咖啡",
    ]
  ) {
    assertEquals(buildSearchQueries(name, [])[0].query, `"${name}"`);
  }
});

Deno.test("bean context is unquoted so non-English bean names stay searchable", () => {
  const [, bean] = buildSearchQueries("River Roasters", [{
    coffee_bean_name: "Фильтр Эфиопия Ненсебо",
    source_record: {},
  }]);
  assertEquals(bean.query, '"River Roasters" Фильтр Эфиопия Ненсебо');
  assertEquals(bean.bean_context, "Фильтр Эфиопия Ненсебо");
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
  assertEquals(result.provider_failure_count, 0);

  // The Instagram lead is kept as evidence but never fetched, and it ranks
  // below both fetchable results.
  const urls = result.search_evidence.results.map((entry) => entry.url);
  assertEquals(urls.includes("https://instagram.com/loom"), true);
  assertEquals(
    result.candidate_urls.includes("https://instagram.com/loom"),
    false,
  );
  const instagram = result.search_evidence.results.find((entry) =>
    entry.url === "https://instagram.com/loom"
  );
  assertEquals(instagram?.lead_only, true);
  assertEquals(instagram?.title, "Instagram");
  assertEquals(
    result.search_evidence.results[result.search_evidence.results.length - 1]
      .url,
    "https://instagram.com/loom",
  );
});

Deno.test("reddit and directory leads inform evidence without spending a fetch", async () => {
  const leads = [
    "https://www.reddit.com/r/Adelaide/comments/1knvuwd/good_coffee_roasters/",
    "https://rocketreach.co/pogo-coffee-profile",
    "https://www.mapquest.com/au/pogo-coffee-775349938",
  ];
  const result = await discoverCandidateSources({
    clusterName: "Pogo Coffee Roasters",
    candidates: [],
    search: () =>
      Promise.resolve([
        ...leads.map((link) => ({ link, title: "Lead" })),
        { link: "https://pogocoffee.com.au/pages/about-us", title: "About" },
      ]),
  });
  // Every lead survives as evidence...
  for (const lead of leads) {
    assertEquals(
      result.search_evidence.results.some((e) => e.url === lead),
      true,
    );
  }
  // ...and the only thing we spend a fetch on is the roaster's own site.
  assertEquals(result.candidate_urls, [
    "https://pogocoffee.com.au/pages/about-us",
  ]);
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
