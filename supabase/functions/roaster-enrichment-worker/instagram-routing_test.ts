import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  applyInstagramRouting,
  mergeInstagramRoutingRecords,
} from "./instagram-routing.ts";

Deno.test("keeps an Instagram-only proposed record (no website evidence)", () => {
  const outcome = applyInstagramRouting({
    roaster_name: "Loom",
    aliases: [],
    roaster_website_url: null,
    instagram_url: "https://instagram.com/loom_coffee?igsh=x",
    country: "France",
  });
  assertEquals(outcome.routed, false);
  assertEquals(outcome.conflict, null);
  assertEquals(outcome.notes, []);
  assertEquals(outcome.proposed.roaster_website_url, null);
  assertEquals(
    outcome.proposed.instagram_url,
    "https://www.instagram.com/loom_coffee/",
  );
  assertEquals(outcome.proposed.country, "France");
});

Deno.test("keeps a real website and an Instagram account side by side", () => {
  const outcome = applyInstagramRouting({
    roaster_name: "Loom",
    roaster_website_url: "https://loom.coffee/",
    instagram_url: "https://www.instagram.com/loom_coffee/",
  });
  assertEquals(outcome.routed, false);
  assertEquals(outcome.conflict, null);
  assertEquals(outcome.proposed.roaster_website_url, "https://loom.coffee/");
  assertEquals(
    outcome.proposed.instagram_url,
    "https://www.instagram.com/loom_coffee/",
  );
});

Deno.test("auto-routes an Instagram account mislabeled as the website", () => {
  const outcome = applyInstagramRouting({
    roaster_name: "Loom",
    roaster_website_url: "instagram.com/loom_coffee",
    instagram_url: null,
  });
  assertEquals(outcome.routed, true);
  assertEquals(outcome.conflict, null);
  assertEquals(outcome.proposed.roaster_website_url, null);
  assertEquals(
    outcome.proposed.instagram_url,
    "https://www.instagram.com/loom_coffee/",
  );
});

Deno.test("deduplicates the same account across fields despite casing and tracking params", () => {
  const outcome = applyInstagramRouting({
    roaster_name: "Loom",
    roaster_website_url: "https://instagram.com/Loom_Coffee?igsh=tracked",
    instagram_url: "@loom_coffee",
  });
  assertEquals(outcome.routed, true);
  assertEquals(outcome.conflict, null);
  assertEquals(outcome.proposed.roaster_website_url, null);
  assertEquals(
    outcome.proposed.instagram_url,
    "https://www.instagram.com/loom_coffee/",
  );
  assertEquals(outcome.notes.length, 1);
});

Deno.test("reports a conflict for two different accounts without picking one", () => {
  const outcome = applyInstagramRouting({
    roaster_name: "Loom",
    roaster_website_url: "https://www.instagram.com/loom_coffee/",
    instagram_url: "https://www.instagram.com/loom_official/",
  });
  assertEquals(outcome.routed, false);
  assertEquals(outcome.conflict, "instagram_account_conflict");
  assertEquals(outcome.proposed.roaster_website_url, null);
  assertEquals(outcome.proposed.instagram_url, null);
});

Deno.test("flags an Instagram post URL submitted as the website", () => {
  const withHandle = applyInstagramRouting({
    roaster_name: "Loom",
    roaster_website_url: "https://www.instagram.com/p/Cxyz123/",
    instagram_url: "@loom_coffee",
  });
  assertEquals(withHandle.routed, false);
  assertEquals(withHandle.conflict, "website_is_instagram_post");
  assertEquals(withHandle.proposed.roaster_website_url, null);
  assertEquals(
    withHandle.proposed.instagram_url,
    "https://www.instagram.com/loom_coffee/",
  );

  const withoutHandle = applyInstagramRouting({
    roaster_name: "Loom",
    roaster_website_url: "https://www.instagram.com/reel/Cxyz123/",
    instagram_url: null,
  });
  assertEquals(withoutHandle.conflict, "website_is_instagram_post");
  assertEquals(withoutHandle.proposed.instagram_url, null);
});

Deno.test("leaves a non-Instagram social URL alone in the website field", () => {
  const outcome = applyInstagramRouting({
    roaster_name: "Loom",
    roaster_website_url: "https://m.facebook.com/loomcoffee",
    instagram_url: null,
  });
  assertEquals(outcome.routed, false);
  assertEquals(outcome.conflict, null);
  assertEquals(
    outcome.proposed.roaster_website_url,
    "https://m.facebook.com/loomcoffee",
  );
  assertEquals(outcome.proposed.instagram_url, null);
});

Deno.test("survives null, undefined, and empty proposed records", () => {
  for (const input of [null, undefined, {}]) {
    const outcome = applyInstagramRouting(input);
    assertEquals(outcome.routed, false);
    assertEquals(outcome.conflict, null);
    assertEquals(outcome.notes, []);
    assertEquals(outcome.proposed.roaster_website_url, null);
    assertEquals(outcome.proposed.instagram_url, null);
  }
});

Deno.test("preserves unrelated keys and never mutates the input", () => {
  const input = {
    roaster_name: "Loom",
    aliases: ["Loom Coffee"],
    roaster_website_url: "instagram.com/loom_coffee",
    instagram_url: null,
    city: "Paris",
    is_roaster: true,
    nested: { keep: true },
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const outcome = applyInstagramRouting(input);
  assertEquals(input, snapshot); // input untouched
  assertEquals(outcome.proposed.aliases, ["Loom Coffee"]);
  assertEquals(outcome.proposed.city, "Paris");
  assertEquals(outcome.proposed.is_roaster, true);
  assertEquals(outcome.proposed.nested, { keep: true });
  assertEquals(outcome.proposed.roaster_website_url, null);
  assertEquals(
    outcome.proposed.instagram_url,
    "https://www.instagram.com/loom_coffee/",
  );
});

Deno.test("merge keeps any routed flag, the first conflict, and unioned notes", () => {
  assertEquals(mergeInstagramRoutingRecords([]), {
    routed: false,
    conflict: null,
    notes: [],
  });
  assertEquals(
    mergeInstagramRoutingRecords([
      null,
      { routed: true, conflict: null, notes: ["moved @a"] },
      undefined,
      {
        routed: false,
        conflict: "instagram_account_conflict",
        notes: ["moved @a", "two accounts"],
      },
    ]),
    {
      routed: true,
      conflict: "instagram_account_conflict",
      notes: ["moved @a", "two accounts"],
    },
  );
});
