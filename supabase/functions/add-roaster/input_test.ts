import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import { parseAddRoasterInput } from "./input.ts";

Deno.test("rejects a missing or blank roaster_name", () => {
  for (const body of [{}, { roaster_name: "   " }]) {
    assertEquals(parseAddRoasterInput(body), {
      ok: false,
      status: 400,
      error: "Missing or invalid roaster_name",
    });
  }
});

Deno.test("rejects every non-string optional field with the existing message", () => {
  const fields = [
    "roaster_logo_url",
    "roaster_website_url",
    "instagram_url",
    "aliases",
    "city",
    "state",
    "country",
  ];
  for (const field of fields) {
    assertEquals(parseAddRoasterInput({ roaster_name: "Test", [field]: 1 }), {
      ok: false,
      status: 400,
      error: `${field} must be a string or null`,
    });
  }
  for (const field of ["address_text", "address"]) {
    assertEquals(parseAddRoasterInput({ roaster_name: "Test", [field]: 1 }), {
      ok: false,
      status: 400,
      error: "address_text must be a string or null",
    });
  }
});

Deno.test("accepts address as an alias for address_text", () => {
  const result = parseAddRoasterInput({
    roaster_name: " Test ",
    address: " 1 Coffee Way ",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.value.p_roaster_name, "Test");
  assertEquals(result.value.p_address_text, "1 Coffee Way");
});

Deno.test("normalizes an absent, null, or empty cluster_id to null", () => {
  for (
    const body of [
      { roaster_name: "Test" },
      { roaster_name: "Test", cluster_id: null },
      { roaster_name: "Test", cluster_id: "" },
    ]
  ) {
    const result = parseAddRoasterInput(body);
    if (!result.ok) throw new Error(result.error);
    assertEquals(result.clusterId, null);
  }
});

Deno.test("accepts a valid cluster_id separately from RPC arguments", () => {
  const clusterId = "123e4567-e89b-12d3-a456-426614174000";
  const result = parseAddRoasterInput({
    roaster_name: "Test",
    cluster_id: clusterId,
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.clusterId, clusterId);
  assertEquals("p_cluster_id" in result.value, false);
});

Deno.test("rejects a malformed cluster_id", () => {
  assertEquals(
    parseAddRoasterInput({ roaster_name: "Test", cluster_id: "not-a-uuid" }),
    {
      ok: false,
      status: 400,
      error: "cluster_id must be a valid UUID",
    },
  );
});

Deno.test("rejects a non-string cluster_id", () => {
  assertEquals(parseAddRoasterInput({ roaster_name: "Test", cluster_id: 42 }), {
    ok: false,
    status: 400,
    error: "cluster_id must be a string or null",
  });
});

Deno.test("normalizes aliases from JSON arrays and comma strings", () => {
  for (
    const [aliases, expected] of [
      ['[" Alpha ", "Beta", ""]', "Alpha,Beta"],
      [" Alpha, Beta, ", "Alpha,Beta"],
    ]
  ) {
    const result = parseAddRoasterInput({ roaster_name: "Test", aliases });
    if (!result.ok) throw new Error(result.error);
    assertEquals(result.value.p_aliases, expected);
  }
});

Deno.test("accepts a plain website with no Instagram", () => {
  const result = parseAddRoasterInput({
    roaster_name: "Test",
    roaster_website_url: "example.com",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.value.p_roaster_website_url, "https://example.com/");
  assertEquals(result.value.p_instagram_url, null);
  assertEquals(result.routing.routed, false);
});

Deno.test("accepts an Instagram-only create", () => {
  const result = parseAddRoasterInput({
    roaster_name: "Test",
    instagram_url: "https://instagram.com/Test.Roaster/?igsh=abc",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.value.p_roaster_website_url, null);
  assertEquals(
    result.value.p_instagram_url,
    "https://www.instagram.com/Test.Roaster/",
  );
});

Deno.test("routes a website-field Instagram account", () => {
  const result = parseAddRoasterInput({
    roaster_name: "Test",
    roaster_website_url: "https://instagram.com/test_roaster/",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.value.p_roaster_website_url, null);
  assertEquals(
    result.value.p_instagram_url,
    "https://www.instagram.com/test_roaster/",
  );
  assertEquals(result.routing.routed, true);
});

Deno.test("deduplicates the same Instagram account case-insensitively", () => {
  const result = parseAddRoasterInput({
    roaster_name: "Test",
    roaster_website_url: "https://instagram.com/TEST_roaster/?igsh=abc",
    instagram_url: "https://www.instagram.com/test_ROASTER/",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.value.p_roaster_website_url, null);
  assertEquals(
    result.value.p_instagram_url,
    "https://www.instagram.com/test_ROASTER/",
  );
  assertEquals(result.routing.routed, true);
});

Deno.test("rejects two different Instagram accounts", () => {
  assertEquals(
    parseAddRoasterInput({
      roaster_name: "Test",
      roaster_website_url: "https://instagram.com/account_one/",
      instagram_url: "https://instagram.com/account_two/",
    }),
    {
      ok: false,
      status: 400,
      error:
        "roaster_website_url and instagram_url reference different Instagram accounts",
    },
  );
});

Deno.test("rejects an Instagram post URL as the website", () => {
  assertEquals(
    parseAddRoasterInput({
      roaster_name: "Test",
      roaster_website_url: "https://instagram.com/p/abc123/",
    }),
    {
      ok: false,
      status: 400,
      error:
        "roaster_website_url must not be an Instagram post, reel, story, or other non-profile URL",
    },
  );
});

Deno.test("accepts a non-Instagram social URL as a website", () => {
  const result = parseAddRoasterInput({
    roaster_name: "Test",
    roaster_website_url: "https://facebook.com/test-roaster#about",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(
    result.value.p_roaster_website_url,
    "https://facebook.com/test-roaster",
  );
  assertEquals(result.value.p_instagram_url, null);
});
