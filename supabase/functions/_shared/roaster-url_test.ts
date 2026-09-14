// Tests for the shared roaster URL classifier/normalizer (plan 030, step 1).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  classifyRoasterUrl,
  isInstagramHost,
  normalizeInstagramUrl,
  type RoasterUrlClassification,
  type RoasterUrlConflict,
  routeRoasterUrls,
} from "./roaster-url.ts";

const IG_TANDEM = "https://www.instagram.com/tandemcoffee/";
// 26 letters + 5 digits = 31 chars, one over the 30-char handle cap.
const HANDLE_31_CHARS = "abcdefghijklmnopqrstuvwxyz12345";

// ────────────────────────────────────────────────────────────────
// classifyRoasterUrl — table-driven
// ────────────────────────────────────────────────────────────────

interface ClassificationCase {
  input: unknown;
  expected: RoasterUrlClassification;
}

function website(normalized: string, host: string): RoasterUrlClassification {
  return { kind: "website", normalized, host, handle: null, reason: null };
}

function instagram(
  normalized: string,
  host: string,
  handle: string,
): RoasterUrlClassification {
  return { kind: "instagram", normalized, host, handle, reason: null };
}

function nonProfile(host: string, reason: string): RoasterUrlClassification {
  return {
    kind: "instagram_non_profile",
    normalized: null,
    host,
    handle: null,
    reason,
  };
}

function social(
  normalized: string,
  host: string,
  reason: string,
): RoasterUrlClassification {
  return { kind: "social", normalized, host, handle: null, reason };
}

function invalid(
  reason: string,
  host: string | null = null,
): RoasterUrlClassification {
  return { kind: "invalid", normalized: null, host, handle: null, reason };
}

const classificationTables: { label: string; cases: ClassificationCase[] }[] = [
  {
    label: "accepts http, https and scheme-less input; rejects other schemes",
    cases: [
      {
        input: "https://example.com/coffee",
        expected: website("https://example.com/coffee", "example.com"),
      },
      {
        input: "http://example.com/coffee",
        expected: website("http://example.com/coffee", "example.com"),
      },
      {
        input: "example.com/coffee",
        expected: website("https://example.com/coffee", "example.com"),
      },
      {
        input: "HTTP://EXAMPLE.COM/Shop",
        expected: website("http://example.com/Shop", "example.com"),
      },
      {
        input: "https://example.com",
        expected: website("https://example.com/", "example.com"),
      },
      { input: "javascript:alert(1)", expected: invalid("unsupported_scheme") },
      { input: "JAVASCRIPT:alert(1)", expected: invalid("unsupported_scheme") },
      {
        input: "ftp://files.example.com/beans.pdf",
        expected: invalid("unsupported_scheme"),
      },
      {
        input: "mailto:hi@example.com",
        expected: invalid("unsupported_scheme"),
      },
      {
        input: "data:text/html,hello",
        expected: invalid("unsupported_scheme"),
      },
      // host:port with a dot in the host still prefixes like the legacy code
      {
        input: "example.com:8080/menu",
        expected: website("https://example.com:8080/menu", "example.com"),
      },
    ],
  },
  {
    label: "classifies Instagram profile hosts and canonicalizes the URL",
    cases: [
      {
        input: "https://www.instagram.com/tandemcoffee/",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
      {
        input: "https://www.instagram.com/tandemcoffee",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
      {
        input: "https://instagram.com/tandemcoffee",
        expected: instagram(IG_TANDEM, "instagram.com", "tandemcoffee"),
      },
      {
        input: "https://m.instagram.com/tandemcoffee",
        expected: instagram(IG_TANDEM, "m.instagram.com", "tandemcoffee"),
      },
      {
        input: "https://l.instagram.com/tandemcoffee",
        expected: instagram(IG_TANDEM, "l.instagram.com", "tandemcoffee"),
      },
      {
        input: "https://instagr.am/tandemcoffee",
        expected: instagram(IG_TANDEM, "instagr.am", "tandemcoffee"),
      },
      {
        input: "https://help.instagr.am/tandemcoffee",
        expected: instagram(IG_TANDEM, "help.instagr.am", "tandemcoffee"),
      },
      {
        input: "INSTAGRAM.COM/tandemcoffee",
        expected: instagram(IG_TANDEM, "instagram.com", "tandemcoffee"),
      },
      {
        input: "instagram.com/tandemcoffee",
        expected: instagram(IG_TANDEM, "instagram.com", "tandemcoffee"),
      },
      // handle display casing preserved; canonical host is always www
      {
        input: "https://m.instagram.com/TandemCoffee",
        expected: instagram(
          "https://www.instagram.com/TandemCoffee/",
          "m.instagram.com",
          "TandemCoffee",
        ),
      },
    ],
  },
  {
    label: "does not match near-miss Instagram hosts",
    cases: [
      {
        input: "https://notinstagram.com/tandemcoffee",
        expected: website(
          "https://notinstagram.com/tandemcoffee",
          "notinstagram.com",
        ),
      },
      {
        input: "https://instagram.com.evil.example/tandemcoffee",
        expected: website(
          "https://instagram.com.evil.example/tandemcoffee",
          "instagram.com.evil.example",
        ),
      },
      {
        input: "https://myinstagram.com.br/tandemcoffee",
        expected: website(
          "https://myinstagram.com.br/tandemcoffee",
          "myinstagram.com.br",
        ),
      },
      {
        input: "https://instagram.community/tandemcoffee",
        expected: website(
          "https://instagram.community/tandemcoffee",
          "instagram.community",
        ),
      },
    ],
  },
  {
    label:
      "strips tracking parameters and fragments, normalizes trailing slashes",
    cases: [
      {
        input: "https://www.instagram.com/tandemcoffee/?igsh=abc123",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
      {
        input: "https://www.instagram.com/tandemcoffee?hl=en",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
      {
        input:
          "https://www.instagram.com/tandemcoffee?utm_source=x&utm_medium=y",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
      {
        input: "https://www.instagram.com/tandemcoffee/#foo",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
      {
        input: "https://www.instagram.com/tandemcoffee?igsh=x#reels",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
      // double trailing slash collapses to the canonical single slash
      {
        input: "https://www.instagram.com/tandemcoffee//",
        expected: instagram(IG_TANDEM, "www.instagram.com", "tandemcoffee"),
      },
    ],
  },
  {
    label: "routes reserved Instagram paths and the bare host to non-profile",
    cases: [
      {
        input: "https://www.instagram.com/p/Cx1AbCdEfGh/",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/reel/Cx1AbCdEfGh/",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/reels/Cx1AbCdEfGh/",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/stories/tandemcoffee/123456789/",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/explore/tags/coffee/",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/accounts/login/",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/share/AbCdEfGh",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/s/abc123",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/tv/AbCdEf/",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/direct/t/abc",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      {
        input: "https://www.instagram.com/",
        expected: nonProfile("www.instagram.com", "instagram_bare_host"),
      },
      {
        input: "https://www.instagram.com",
        expected: nonProfile("www.instagram.com", "instagram_bare_host"),
      },
      {
        input: "https://www.instagram.com//",
        expected: nonProfile("www.instagram.com", "instagram_bare_host"),
      },
      {
        input: "https://l.instagram.com/?u=https%3A%2F%2Fexample.com",
        expected: nonProfile("l.instagram.com", "instagram_bare_host"),
      },
      // reserved segments match case-insensitively
      {
        input: "https://www.instagram.com/ABOUT",
        expected: nonProfile("www.instagram.com", "instagram_reserved_path"),
      },
      // extra path segments are never an account
      {
        input: "https://www.instagram.com/tandemcoffee/tagged/",
        expected: nonProfile(
          "www.instagram.com",
          "instagram_multi_segment_path",
        ),
      },
      // the URL parser resolves /./ and /../ away before the handle is checked
      {
        input: "https://www.instagram.com/./",
        expected: nonProfile("www.instagram.com", "instagram_bare_host"),
      },
      {
        input: "https://www.instagram.com/../",
        expected: nonProfile("www.instagram.com", "instagram_bare_host"),
      },
    ],
  },
  {
    label: "rejects invalid Instagram handles",
    cases: [
      {
        input: "https://www.instagram.com/.name",
        expected: nonProfile("www.instagram.com", "instagram_invalid_handle"),
      },
      {
        input: "https://www.instagram.com/name.",
        expected: nonProfile("www.instagram.com", "instagram_invalid_handle"),
      },
      {
        input: `https://www.instagram.com/${HANDLE_31_CHARS}`,
        expected: nonProfile("www.instagram.com", "instagram_invalid_handle"),
      },
      {
        input: "https://www.instagram.com/na-me",
        expected: nonProfile("www.instagram.com", "instagram_invalid_handle"),
      },
      {
        input: "https://www.instagram.com/☕coffee",
        expected: nonProfile("www.instagram.com", "instagram_invalid_handle"),
      },
    ],
  },
  {
    label: "rejects malformed and unusable website inputs",
    cases: [
      { input: "", expected: invalid("empty") },
      { input: "   ", expected: invalid("empty") },
      { input: null, expected: invalid("not_a_string") },
      { input: 123, expected: invalid("not_a_string") },
      { input: undefined, expected: invalid("not_a_string") },
      { input: "http://", expected: invalid("unparseable") },
      { input: "https://", expected: invalid("unparseable") },
      { input: "https://localhost/roasters", expected: invalid("localhost") },
      { input: "https://roaster.local", expected: invalid("local_tld") },
      { input: "http://192.168.1.1/beans", expected: invalid("ipv4_literal") },
      { input: "https://192.168.1.1", expected: invalid("ipv4_literal") },
      // IPv6 literals get their own reason code (the legacy normalizer
      // rejected them via the colon check as well)
      { input: "https://[::1]/roaster", expected: invalid("ipv6_literal") },
      {
        input: "https://example.com/menu.pdf",
        expected: invalid("binary_path"),
      },
      {
        input: "https://example.com/beans.zip",
        expected: invalid("binary_path"),
      },
      {
        input: `https://example.com/${"a".repeat(3000)}`,
        expected: invalid("too_long"),
      },
    ],
  },
  {
    label: "classifies other social hosts with a network reason code",
    cases: [
      {
        input: "https://www.facebook.com/tandemroasters",
        expected: social(
          "https://www.facebook.com/tandemroasters",
          "www.facebook.com",
          "social_facebook",
        ),
      },
      {
        input: "https://fb.com/tandemroasters",
        expected: social(
          "https://fb.com/tandemroasters",
          "fb.com",
          "social_facebook",
        ),
      },
      {
        input: "https://m.me/tandemroasters",
        expected: social(
          "https://m.me/tandemroasters",
          "m.me",
          "social_messenger",
        ),
      },
      {
        input: "https://twitter.com/tandemroasters",
        expected: social(
          "https://twitter.com/tandemroasters",
          "twitter.com",
          "social_twitter",
        ),
      },
      {
        input: "x.com/tandemroasters",
        expected: social("https://x.com/tandemroasters", "x.com", "social_x"),
      },
      {
        input: "https://tiktok.com/@tandemroasters",
        expected: social(
          "https://tiktok.com/@tandemroasters",
          "tiktok.com",
          "social_tiktok",
        ),
      },
      {
        input: "https://linkedin.com/company/tandem-roasters",
        expected: social(
          "https://linkedin.com/company/tandem-roasters",
          "linkedin.com",
          "social_linkedin",
        ),
      },
      {
        input: "https://youtube.com/@tandemroasters",
        expected: social(
          "https://youtube.com/@tandemroasters",
          "youtube.com",
          "social_youtube",
        ),
      },
      {
        input: "https://youtu.be/abc123",
        expected: social(
          "https://youtu.be/abc123",
          "youtu.be",
          "social_youtube",
        ),
      },
      {
        input: "https://pinterest.com/tandemroasters",
        expected: social(
          "https://pinterest.com/tandemroasters",
          "pinterest.com",
          "social_pinterest",
        ),
      },
      {
        input: "https://threads.net/@tandemroasters",
        expected: social(
          "https://threads.net/@tandemroasters",
          "threads.net",
          "social_threads",
        ),
      },
      {
        input: "https://threads.com/@tandemroasters",
        expected: social(
          "https://threads.com/@tandemroasters",
          "threads.com",
          "social_threads",
        ),
      },
      {
        input: "https://vk.com/tandemroasters",
        expected: social(
          "https://vk.com/tandemroasters",
          "vk.com",
          "social_vk",
        ),
      },
      {
        input: "https://t.me/tandemroasters",
        expected: social(
          "https://t.me/tandemroasters",
          "t.me",
          "social_telegram",
        ),
      },
      {
        input: "https://wa.me/15551234567",
        expected: social(
          "https://wa.me/15551234567",
          "wa.me",
          "social_whatsapp",
        ),
      },
      {
        input: "https://chat.whatsapp.com/AbCdEf",
        expected: social(
          "https://chat.whatsapp.com/AbCdEf",
          "chat.whatsapp.com",
          "social_whatsapp",
        ),
      },
      {
        input: "https://snapchat.com/add/tandemroasters",
        expected: social(
          "https://snapchat.com/add/tandemroasters",
          "snapchat.com",
          "social_snapchat",
        ),
      },
      {
        input: "https://weibo.com/tandemroasters",
        expected: social(
          "https://weibo.com/tandemroasters",
          "weibo.com",
          "social_weibo",
        ),
      },
      {
        input: "https://xiaohongshu.com/user/profile/abc",
        expected: social(
          "https://xiaohongshu.com/user/profile/abc",
          "xiaohongshu.com",
          "social_xiaohongshu",
        ),
      },
      // near-miss social host is a plain website
      {
        input: "https://facebook.com.evil.example/tandemroasters",
        expected: website(
          "https://facebook.com.evil.example/tandemroasters",
          "facebook.com.evil.example",
        ),
      },
    ],
  },
  {
    label: "keeps the query string and strips only the fragment from websites",
    cases: [
      {
        input: "https://example.com/shop?bean=washed#top",
        expected: website(
          "https://example.com/shop?bean=washed",
          "example.com",
        ),
      },
      {
        input: "https://EXAMPLE.com/SHOP",
        expected: website("https://example.com/SHOP", "example.com"),
      },
      {
        input: "http://example.com:8080/menu",
        expected: website("http://example.com:8080/menu", "example.com"),
      },
      {
        input: "https://sub.shop.example.co.uk/beans?a=b",
        expected: website(
          "https://sub.shop.example.co.uk/beans?a=b",
          "sub.shop.example.co.uk",
        ),
      },
    ],
  },
];

for (const table of classificationTables) {
  Deno.test(`classifyRoasterUrl: ${table.label}`, () => {
    for (const { input, expected } of table.cases) {
      assertEquals(
        classifyRoasterUrl(input),
        expected,
        `input: ${JSON.stringify(input)}`,
      );
    }
  });
}

// ────────────────────────────────────────────────────────────────
// isInstagramHost — table-driven
// ────────────────────────────────────────────────────────────────

const instagramHostCases: [string, boolean][] = [
  ["instagram.com", true],
  ["WWW.INSTAGRAM.COM", true],
  ["www.instagram.com", true],
  ["m.instagram.com", true],
  ["l.instagram.com", true],
  ["instagr.am", true],
  ["help.instagr.am", true],
  ["instagram.com.", true], // FQDN trailing dot tolerated
  ["notinstagram.com", false],
  ["instagram.com.evil.example", false],
  ["myinstagram.com.br", false],
  ["instagram.community", false],
  ["instagr.am.evil.example", false],
  ["instagram", false],
  ["localhost", false],
  ["", false],
  ["x.com", false],
];

Deno.test("isInstagramHost matches instagram.com/instagr.am and subdomains exactly", () => {
  for (const [host, expected] of instagramHostCases) {
    assertEquals(
      isInstagramHost(host),
      expected,
      `host: ${JSON.stringify(host)}`,
    );
  }
});

// ────────────────────────────────────────────────────────────────
// normalizeInstagramUrl — table-driven
// ────────────────────────────────────────────────────────────────

const normalizeInstagramCases: { input: unknown; expected: string | null }[] = [
  { input: "https://www.instagram.com/tandemcoffee/", expected: IG_TANDEM },
  {
    input: "https://m.instagram.com/TandemCoffee?igsh=x",
    expected: "https://www.instagram.com/TandemCoffee/",
  },
  { input: "instagram.com/tandemcoffee", expected: IG_TANDEM },
  { input: "https://www.instagram.com/p/ABC123/", expected: null },
  { input: "https://www.instagram.com/", expected: null },
  { input: "https://notinstagram.com/tandemcoffee", expected: null },
  { input: "https://example.com", expected: null },
  { input: "@tandemcoffee", expected: null }, // bare handles are not URLs here
  { input: "tandemcoffee", expected: null },
  { input: "", expected: null },
  { input: null, expected: null },
  { input: 123, expected: null },
];

Deno.test("normalizeInstagramUrl returns the canonical URL only for account profiles", () => {
  for (const { input, expected } of normalizeInstagramCases) {
    assertEquals(
      normalizeInstagramUrl(input),
      expected,
      `input: ${JSON.stringify(input)}`,
    );
  }
});

// ────────────────────────────────────────────────────────────────
// routeRoasterUrls — one table per routing theme
// ────────────────────────────────────────────────────────────────

interface RoutingExpectation {
  website_url: string | null;
  instagram_url: string | null;
  routed: boolean;
  conflict: RoasterUrlConflict | null;
  minNotes?: number;
  maxNotes?: number;
  notesInclude?: string[];
}

interface RoutingCase {
  name: string;
  websiteInput: unknown;
  instagramInput: unknown;
  expected: RoutingExpectation;
}

function assertRouting(
  actual: ReturnType<typeof routeRoasterUrls>,
  expected: RoutingExpectation,
  label: string,
): void {
  assertEquals(
    actual.website_url,
    expected.website_url,
    `${label}: website_url`,
  );
  assertEquals(
    actual.instagram_url,
    expected.instagram_url,
    `${label}: instagram_url`,
  );
  assertEquals(actual.routed, expected.routed, `${label}: routed`);
  assertEquals(actual.conflict, expected.conflict, `${label}: conflict`);
  if (expected.maxNotes !== undefined) {
    assert(
      actual.notes.length <= expected.maxNotes,
      `${label}: expected at most ${expected.maxNotes} note(s), got ${
        JSON.stringify(actual.notes)
      }`,
    );
  }
  if (expected.minNotes !== undefined) {
    assert(
      actual.notes.length >= expected.minNotes,
      `${label}: expected at least ${expected.minNotes} note(s), got ${
        JSON.stringify(actual.notes)
      }`,
    );
  }
  for (const fragment of expected.notesInclude ?? []) {
    assert(
      actual.notes.some((note) => note.includes(fragment)),
      `${label}: no note mentions ${JSON.stringify(fragment)} — notes: ${
        JSON.stringify(actual.notes)
      }`,
    );
  }
}

function runRoutingTable(cases: RoutingCase[]): void {
  for (const { name, websiteInput, instagramInput, expected } of cases) {
    assertRouting(
      routeRoasterUrls(websiteInput, instagramInput),
      expected,
      name,
    );
  }
}

Deno.test("routeRoasterUrls stores plain and social websites without notes", () => {
  runRoutingTable([
    {
      name: "website only",
      websiteInput: "https://example.com/coffee",
      instagramInput: null,
      expected: {
        website_url: "https://example.com/coffee",
        instagram_url: null,
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
    {
      name: "social website stays in the website field",
      websiteInput: "https://www.facebook.com/tandemroasters",
      instagramInput: undefined,
      expected: {
        website_url: "https://www.facebook.com/tandemroasters",
        instagram_url: null,
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
    {
      name: "x.com in the website field alongside an Instagram handle",
      websiteInput: "x.com/TandemCoffee",
      instagramInput: "@tandemcoffee",
      expected: {
        website_url: "https://x.com/TandemCoffee",
        instagram_url: "https://www.instagram.com/tandemcoffee/",
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
  ]);
});

Deno.test("routeRoasterUrls accepts Instagram-only input, including bare handles", () => {
  runRoutingTable([
    {
      name: "full profile URL in the Instagram field",
      websiteInput: null,
      instagramInput: "https://www.instagram.com/TandemCoffee/",
      expected: {
        website_url: null,
        instagram_url: "https://www.instagram.com/TandemCoffee/",
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
    {
      name: "bare @handle in the Instagram field",
      websiteInput: null,
      instagramInput: "@tandemcoffee",
      expected: {
        website_url: null,
        instagram_url: IG_TANDEM,
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
    {
      name: "bare handle without @ in the Instagram field",
      websiteInput: null,
      instagramInput: "tandemcoffee",
      expected: {
        website_url: null,
        instagram_url: IG_TANDEM,
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
    {
      name: "both fields, distinct destinations",
      websiteInput: "https://example.com",
      instagramInput: "@TandemCoffee",
      expected: {
        website_url: "https://example.com/",
        instagram_url: "https://www.instagram.com/TandemCoffee/",
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
  ]);
});

Deno.test("routeRoasterUrls auto-routes an Instagram account out of the website field", () => {
  runRoutingTable([
    {
      name: "profile URL in the website field, no Instagram input",
      websiteInput: "https://www.instagram.com/tandemcoffee",
      instagramInput: null,
      expected: {
        website_url: null,
        instagram_url: IG_TANDEM,
        routed: true,
        conflict: null,
        minNotes: 1,
        notesInclude: ["@tandemcoffee"],
      },
    },
    {
      name: "scheme-less profile URL in the website field",
      websiteInput: "instagram.com/tandemcoffee",
      instagramInput: "",
      expected: {
        website_url: null,
        instagram_url: IG_TANDEM,
        routed: true,
        conflict: null,
        minNotes: 1,
      },
    },
  ]);
});

Deno.test("routeRoasterUrls deduplicates the same account across fields", () => {
  runRoutingTable([
    {
      name: "same account, handles differing only in case",
      websiteInput: "https://www.instagram.com/TandemCoffee/",
      instagramInput: "@tandemcoffee",
      expected: {
        website_url: null,
        instagram_url: "https://www.instagram.com/tandemcoffee/",
        routed: true,
        conflict: null,
        minNotes: 1,
        notesInclude: ["same Instagram account"],
      },
    },
  ]);
});

Deno.test("routeRoasterUrls refuses to pick between two different accounts", () => {
  runRoutingTable([
    {
      name: "different Instagram accounts in the two fields",
      websiteInput: "https://www.instagram.com/alice_roasts/",
      instagramInput: "@bob_roasts",
      expected: {
        website_url: null,
        instagram_url: null,
        routed: false,
        conflict: "instagram_account_conflict",
        minNotes: 1,
        notesInclude: ["alice_roasts", "bob_roasts"],
      },
    },
  ]);
});

Deno.test("routeRoasterUrls flags non-profile Instagram URLs in the website field", () => {
  runRoutingTable([
    {
      name:
        "post URL in the website field with an account in the Instagram field",
      websiteInput: "https://www.instagram.com/p/Cx1AbCdEfGh/",
      instagramInput: "https://www.instagram.com/tandemcoffee/",
      expected: {
        website_url: null,
        instagram_url: IG_TANDEM,
        routed: false,
        conflict: "website_is_instagram_post",
        minNotes: 1,
        notesInclude: ["instagram_reserved_path"],
      },
    },
    {
      name: "post URL in the website field alone",
      websiteInput: "https://www.instagram.com/reel/ABC123/",
      instagramInput: null,
      expected: {
        website_url: null,
        instagram_url: null,
        routed: false,
        conflict: "website_is_instagram_post",
        minNotes: 1,
      },
    },
  ]);
});

Deno.test("routeRoasterUrls never lands a non-account Instagram input and notes it", () => {
  runRoutingTable([
    {
      name: "website in the Instagram field",
      websiteInput: "https://example.com",
      instagramInput: "https://other.example.org/shop",
      expected: {
        website_url: "https://example.com/",
        instagram_url: null,
        routed: false,
        conflict: null,
        minNotes: 1,
        notesInclude: ["not_an_instagram_account"],
      },
    },
    {
      name: "explore URL in the Instagram field",
      websiteInput: "https://example.com",
      instagramInput: "https://www.instagram.com/explore/tags/coffee/",
      expected: {
        website_url: "https://example.com/",
        instagram_url: null,
        routed: false,
        conflict: null,
        minNotes: 1,
        notesInclude: ["instagram_reserved_path"],
      },
    },
    {
      name: "non-Instagram social URL in the Instagram field",
      websiteInput: "https://example.com",
      instagramInput: "https://t.me/tandemroasters",
      expected: {
        website_url: "https://example.com/",
        instagram_url: null,
        routed: false,
        conflict: null,
        minNotes: 1,
        notesInclude: ["social_telegram"],
      },
    },
    {
      name: "malformed bare handle in the Instagram field",
      websiteInput: "https://example.com",
      instagramInput: "not-a-valid-handle!!",
      expected: {
        website_url: "https://example.com/",
        instagram_url: null,
        routed: false,
        conflict: null,
        minNotes: 1,
        notesInclude: ["instagram_invalid_handle"],
      },
    },
  ]);
});

Deno.test("routeRoasterUrls survives garbage and absent input without throwing", () => {
  runRoutingTable([
    {
      name: "garbage in both fields",
      websiteInput: "!!!",
      instagramInput: "???",
      expected: {
        website_url: null,
        instagram_url: null,
        routed: false,
        conflict: null,
        minNotes: 2,
        notesInclude: ["host_missing_dot", "instagram_invalid_handle"],
      },
    },
    {
      name: "empty strings in both fields produce no notes",
      websiteInput: "",
      instagramInput: "   ",
      expected: {
        website_url: null,
        instagram_url: null,
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
    {
      name: "null in both fields",
      websiteInput: null,
      instagramInput: null,
      expected: {
        website_url: null,
        instagram_url: null,
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
    {
      name: "non-string values in both fields",
      websiteInput: 123,
      instagramInput: {},
      expected: {
        website_url: null,
        instagram_url: null,
        routed: false,
        conflict: null,
        maxNotes: 0,
      },
    },
  ]);
});
