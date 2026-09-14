import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import { parseContributionInput } from "./contribution-input.ts";

function ok(body: Record<string, unknown>) {
  const result = parseContributionInput(body);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

function rejected(body: Record<string, unknown>) {
  const result = parseContributionInput(body);
  if (result.ok) throw new Error("expected rejection");
  return result;
}

Deno.test("accepts a plain website contribution", () => {
  const value = ok({
    roaster: " Loom ",
    website_url: "https://loom.coffee/shop?utm_source=x#top",
  });
  assertEquals(value.roaster, "Loom");
  assertEquals(value.website_url, "https://loom.coffee/shop?utm_source=x");
  assertEquals(value.website_domain, "loom.coffee");
  assertEquals(value.instagram_url, null);
  assertEquals(value.city, null);
  assertEquals(value.country, null);
  assertEquals(value.routing.routed, false);
  assertEquals(value.routing.conflict, null);
});

Deno.test("accepts an Instagram-only contribution with a full profile URL", () => {
  const value = ok({
    roaster: "Loom",
    instagram_url: "https://instagram.com/loom.coffee?igsh=abc#m",
  });
  assertEquals(value.website_url, null);
  assertEquals(value.website_domain, null);
  assertEquals(value.instagram_url, "https://www.instagram.com/loom.coffee/");
  assertEquals(value.routing.routed, false);
  assertEquals(value.routing.conflict, null);
});

Deno.test("accepts an Instagram-only contribution with a bare handle", () => {
  const value = ok({ roaster: "Loom", instagram_url: "@loom_coffee" });
  assertEquals(value.website_url, null);
  assertEquals(value.website_domain, null);
  assertEquals(value.instagram_url, "https://www.instagram.com/loom_coffee/");
});

Deno.test("auto-routes an Instagram account submitted as the website", () => {
  const value = ok({
    roaster: "Loom",
    website_url: "https://www.instagram.com/loom_coffee/",
  });
  assertEquals(value.website_url, null);
  assertEquals(value.website_domain, null);
  assertEquals(value.instagram_url, "https://www.instagram.com/loom_coffee/");
  assertEquals(value.routing.routed, true);
  assertEquals(value.routing.conflict, null);
  assertEquals(value.routing.notes.length, 1);
});

Deno.test("deduplicates the same account submitted in both fields", () => {
  const value = ok({
    roaster: "Loom",
    website_url: "https://instagram.com/Loom_Coffee?igsh=tracked",
    instagram_url: "@loom_coffee",
  });
  assertEquals(value.website_url, null);
  assertEquals(value.website_domain, null);
  assertEquals(value.instagram_url, "https://www.instagram.com/loom_coffee/");
  assertEquals(value.routing.routed, true);
  assertEquals(value.routing.conflict, null);
});

Deno.test("rejects two different Instagram accounts without writing", () => {
  const result = rejected({
    roaster: "Loom",
    website_url: "https://www.instagram.com/loom_coffee/",
    instagram_url: "https://www.instagram.com/loom_official/",
  });
  assertEquals(result.status, 400);
  assertEquals(
    result.error,
    "website_url and instagram_url name two different Instagram accounts; submit only one so the official account is not guessed.",
  );
});

Deno.test("rejects an Instagram post URL submitted as the website", () => {
  const result = rejected({
    roaster: "Loom",
    website_url: "https://www.instagram.com/p/Cxyz123/",
  });
  assertEquals(result.status, 400);
  assertEquals(
    result.error,
    "website_url is an Instagram post/reel/story URL, not an account profile; submit the roaster's website or its Instagram profile instead.",
  );
});

Deno.test("rejects a contribution with no usable identity URL", () => {
  for (
    const body of [
      { roaster: "Loom" },
      { roaster: "Loom", website_url: "not a url", instagram_url: 42 },
      { roaster: "Loom", website_url: "", instagram_url: "" },
    ]
  ) {
    const result = rejected(body);
    assertEquals(result.status, 400);
    assertEquals(
      result.error,
      "A website or an Instagram profile is required: provide at least one usable identity URL.",
    );
  }
});

Deno.test("rejects a missing or blank roaster name", () => {
  for (
    const body of [
      {},
      { roaster: "   ", website_url: "https://loom.coffee" },
      { roaster: 7, website_url: "https://loom.coffee" },
    ]
  ) {
    const result = rejected(body);
    assertEquals(result.status, 400);
    assertEquals(result.error, "Missing or invalid roaster");
  }
});

Deno.test("still accepts a non-Instagram social URL as the website", () => {
  const value = ok({
    roaster: "Loom",
    website_url: "https://m.facebook.com/loomcoffee",
  });
  assertEquals(value.website_url, "https://m.facebook.com/loomcoffee");
  assertEquals(value.website_domain, "m.facebook.com");
  assertEquals(value.instagram_url, null);
  assertEquals(value.routing.conflict, null);
});

Deno.test("trims and truncates city and country", () => {
  const value = ok({
    roaster: "Loom",
    website_url: "https://loom.coffee",
    city: "  Paris  ",
    country: "F".repeat(200),
  });
  assertEquals(value.city, "Paris");
  assertEquals(value.country, "F".repeat(120));
});
