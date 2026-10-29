import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  collectPageLinks,
  extractDescriptionUrls,
  MAX_URLS_PER_PAGE,
  websiteHref,
} from "./links.ts";

// The first three cases are the website's own tests for
// extractDescriptionUrls (timer-coffee-landing-2 tests/unit/linkSafety.test.ts).
Deno.test("extractDescriptionUrls finds http(s) and bare www. links, trimming trailing punctuation", () => {
  assertEquals(
    extractDescriptionUrls(
      "Shop at https://kawa.example/shop. Or www.kawa.example, (see http://old.kawa.example/a?b=1) and HTTPS://LOUD.example!",
    ),
    [
      "https://kawa.example/shop",
      "www.kawa.example",
      "http://old.kawa.example/a?b=1",
      "HTTPS://LOUD.example",
    ],
  );
});

Deno.test("extractDescriptionUrls catches a link glued to a word but not www. inside an email or another link", () => {
  assertEquals(extractDescriptionUrls("visithttps://evil.example now"), [
    "https://evil.example",
  ]);
  assertEquals(extractDescriptionUrls("mail hello@www.kawa.example"), []);
  assertEquals(extractDescriptionUrls("https://www.kawa.example/x"), [
    "https://www.kawa.example/x",
  ]);
  assertEquals(
    extractDescriptionUrls("go to kawa.example/www.evil.example"),
    [],
  );
  assertEquals(extractDescriptionUrls("foo.www.evil.example"), []);
  assertEquals(extractDescriptionUrls("(www.kawa.example)"), [
    "www.kawa.example",
  ]);
});

Deno.test("extractDescriptionUrls stops at CJK punctuation and ignores text without links", () => {
  assertEquals(
    extractDescriptionUrls("请访问https://kawa.example/店，谢谢。"),
    [
      "https://kawa.example/店",
    ],
  );
  assertEquals(extractDescriptionUrls("見てwww.kawa.example。ありがとう"), [
    "www.kawa.example",
  ]);
  assertEquals(extractDescriptionUrls("「https://kawa.example/a」"), [
    "https://kawa.example/a",
  ]);
  assertEquals(
    extractDescriptionUrls("Just coffee, no links. e.g. kawa.example"),
    [],
  );
  assertEquals(extractDescriptionUrls(null), []);
  assertEquals(extractDescriptionUrls(""), []);
  assertEquals(extractDescriptionUrls("bare https:// and www."), []);
});

Deno.test("extractDescriptionUrls trims trailing punctuation runs and ellipses", () => {
  assertEquals(
    extractDescriptionUrls(
      "Try https://kawa.example/beans?!… or **www.kawa.example**",
    ),
    ["https://kawa.example/beans", "www.kawa.example"],
  );
  assertEquals(extractDescriptionUrls('<a href="https://kawa.example">x</a>'), [
    "https://kawa.example",
  ]);
});

Deno.test("websiteHref looks up scheme-less websites as https and refuses other schemes", () => {
  assertEquals(
    websiteHref("https://kawa.example")?.href,
    "https://kawa.example/",
  );
  assertEquals(
    websiteHref("kawa.example/shop")?.href,
    "https://kawa.example/shop",
  );
  assertEquals(
    websiteHref("www.kawa.example")?.href,
    "https://www.kawa.example/",
  );
  assertEquals(websiteHref("javascript:alert(1)"), null);
  assertEquals(websiteHref("mailto:hi@kawa.example"), null);
  assertEquals(websiteHref("   "), null);
});

Deno.test("collectPageLinks: website first, bare www. looked up as https, raw values kept for quarantine", () => {
  const links = collectPageLinks({
    website_url: "https://kawa.example",
    description: "See www.kawa.example and https://blog.kawa.example.",
  });
  assertEquals(
    links.map((link) => [link.href, link.host, link.occurrences]),
    [
      ["https://kawa.example/", "kawa.example", [{
        field: "website_url",
        value: "https://kawa.example",
      }]],
      ["https://www.kawa.example/", "www.kawa.example", [{
        field: "description",
        value: "www.kawa.example",
      }]],
      ["https://blog.kawa.example/", "blog.kawa.example", [{
        field: "description",
        value: "https://blog.kawa.example",
      }]],
    ],
  );
});

Deno.test("collectPageLinks merges duplicates but keeps each field's occurrence", () => {
  const links = collectPageLinks({
    website_url: "https://kawa.example/",
    description:
      "https://kawa.example/ and again https://kawa.example/ and HTTPS://KAWA.example/",
  });
  assertEquals(links.length, 1);
  assertEquals(links[0].occurrences, [
    { field: "website_url", value: "https://kawa.example/" },
    { field: "description", value: "https://kawa.example/" },
    { field: "description", value: "HTTPS://KAWA.example/" },
  ]);
});

Deno.test("collectPageLinks skips social platform links entirely", () => {
  const links = collectPageLinks({
    website_url: "https://www.instagram.com/kawa/",
    description:
      "Follow https://facebook.com/kawa, https://x.com/kawa, www.tiktok.com/@kawa, https://youtu.be/abc and https://t.me/kawa. Shop: https://kawa.example/shop",
  });
  assertEquals(links.map((link) => link.href), ["https://kawa.example/shop"]);
});

Deno.test("collectPageLinks caps a page at MAX_URLS_PER_PAGE distinct URLs", () => {
  const description = Array.from(
    { length: 15 },
    (_, i) => `https://site${i}.example/`,
  ).join(" ");
  const links = collectPageLinks({
    website_url: "https://kawa.example",
    description,
  });
  assertEquals(MAX_URLS_PER_PAGE, 10);
  assertEquals(links.length, 10);
  assertEquals(links[0].href, "https://kawa.example/");
  assertEquals(links[9].href, "https://site8.example/");
});

Deno.test("collectPageLinks returns nothing for empty pages and unparseable links", () => {
  assertEquals(collectPageLinks({ website_url: null, description: null }), []);
  assertEquals(
    collectPageLinks({ website_url: "", description: "http://[bad" }),
    [],
  );
});
