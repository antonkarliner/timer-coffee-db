import { APP_STORE_COUNTRIES } from "./countries.ts";
import { parseAppleLookup } from "./apple.ts";
import {
  collectGoogleReport,
  decodeReport,
  getGoogleStorageToken,
  parseCsv,
  parseGoogleReport,
} from "./google.ts";
import { authorizeServiceRole } from "../service-role-auth.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function throws(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    equal((error as Error).message, code);
    return;
  }
  throw new Error("Expected rejection");
}
const app = (country: string, average: number, count: number) => ({
  resultCount: 1,
  results: [{
    trackId: 6449322787,
    trackViewUrl:
      `https://apps.apple.com/${country}/app/timer-coffee/id6449322787`,
    averageUserRating: average,
    userRatingCount: count,
  }],
});
const date = "2026-09-30";
const header =
  "Date,Package Name,Country,Daily Average Rating,Total Average Rating\r\n";

Deno.test("Apple preserves numeric precision and uses rating counts, not text reviews", () => {
  const observation = parseAppleLookup(
    app("us", 4.99247, 133),
    "6449322787",
    "us",
    date,
  );
  equal(observation.average_rating, 4.99247);
  equal(observation.rating_count, 133);
  equal(APP_STORE_COUNTRIES.length, 175);
  equal(new Set(APP_STORE_COUNTRIES).size, 175);
});
Deno.test("Apple zero ratings and unavailable apps differ", () => {
  equal(
    parseAppleLookup(app("fr", 0, 0), "6449322787", "fr", date).status,
    "ok",
  );
  equal(
    parseAppleLookup(app("fr", 0, 0), "6449322787", "fr", date).average_rating,
    null,
  );
  equal(
    parseAppleLookup({ resultCount: 0, results: [] }, "6449322787", "fr", date)
      .status,
    "unavailable",
  );
});
Deno.test("Apple rejects fallback storefronts, app mismatches, and invalid ratings", () => {
  throws(
    () => parseAppleLookup(app("us", 5, 2), "6449322787", "xk", date),
    "apple_storefront_mismatch",
  );
  throws(
    () => parseAppleLookup(app("us", 5, 2), "999", "us", date),
    "apple_app_mismatch",
  );
  throws(
    () => parseAppleLookup(app("us", 6, 2), "6449322787", "us", date),
    "apple_invalid_rating",
  );
  throws(
    () => parseAppleLookup(app("us", 5, -1), "6449322787", "us", date),
    "apple_invalid_rating",
  );
  throws(
    () => parseAppleLookup(app("us", 5, 1.5), "6449322787", "us", date),
    "apple_invalid_rating",
  );
});
Deno.test("CSV decoding handles Google's UTF-16, BOM, CRLF, quotes and embedded newlines", () => {
  const text = '\uFEFFa,b\r\n"x,y","say ""hello""\nworld"\r\n';
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    bytes[i * 2] = text.charCodeAt(i) & 255;
    bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  equal(parseCsv(decodeReport(bytes)), [["a", "b"], [
    "x,y",
    'say "hello"\nworld',
  ]]);
  throws(() => parseCsv('a,b\n"unfinished'), "google_invalid_csv");
  throws(() => parseCsv('a,b\n"closed"junk,2'), "google_invalid_csv");
});
Deno.test("Google selects latest populated source date and never averages country means", () => {
  const report = parseGoogleReport(
    header +
      "2026-09-25,com.coffee.timer,US,,4.9\r\n" +
      "2026-09-26,com.coffee.timer,US,,4.8\r\n" +
      "2026-09-26,com.coffee.timer,FR,,3.0\r\n" +
      "2026-09-27,com.coffee.timer,US,,\r\n",
    "com.coffee.timer",
    date,
  );
  equal(report.sourceDate, "2026-09-26");
  equal(report.snapshot, null);
  equal(
    report.observations.map((
      o,
    ) => [o.country, o.average_rating, o.rating_count]),
    [["us", 4.8, null], ["fr", 3, null]],
  );
});
Deno.test("Google only publishes an explicit overall row and leaves unavailable counts null", () => {
  const report = parseGoogleReport(
    header + "2026-09-26,com.coffee.timer,Overall,,4.87\n",
    "com.coffee.timer",
    date,
  );
  equal(report.snapshot?.average_rating, 4.87);
  equal(report.snapshot?.rating_count, null);
  const unknown = parseGoogleReport(
    header +
      "2026-09-26,com.coffee.timer,,,4.87\n2026-09-26,com.coffee.timer,Other,,4.6\n",
    "com.coffee.timer",
    date,
  );
  equal(unknown.snapshot, null);
});
Deno.test("Google fails closed on missing headers, wrong packages, impossible dates and duplicate segments", () => {
  throws(
    () =>
      parseGoogleReport(
        "Date,Package Name,Country\n",
        "com.coffee.timer",
        date,
      ),
    "google_unsupported_report_headers",
  );
  throws(
    () =>
      parseGoogleReport(
        header + "2026-09-26,com.other.app,US,,5",
        "com.coffee.timer",
        date,
      ),
    "google_package_mismatch",
  );
  throws(
    () =>
      parseGoogleReport(
        header + "2026-10-01,com.coffee.timer,US,,5",
        "com.coffee.timer",
        date,
      ),
    "google_invalid_source_date",
  );
  throws(
    () =>
      parseGoogleReport(
        header + "2026-02-30,com.coffee.timer,US,,5",
        "com.coffee.timer",
        date,
      ),
    "google_invalid_source_date",
  );
  throws(
    () =>
      parseGoogleReport(
        header + "2026-09-26,com.coffee.timer,US,,0",
        "com.coffee.timer",
        date,
      ),
    "google_invalid_rating",
  );
  throws(
    () =>
      parseGoogleReport(
        header +
          "2026-09-26,com.coffee.timer,US,,5\n2026-09-26,com.coffee.timer,US,,4",
        "com.coffee.timer",
        date,
      ),
    "google_duplicate_country",
  );
});
Deno.test("collector bearer auth rejects user JWTs and malformed/missing credentials", () => {
  equal(authorizeServiceRole(null, "server-key").authorized, false);
  equal(
    authorizeServiceRole("Basic server-key", "server-key").authorized,
    false,
  );
  equal(
    authorizeServiceRole("Bearer user-jwt", "server-key").authorized,
    false,
  );
  equal(
    authorizeServiceRole("Bearer server-key", "server-key").authorized,
    true,
  );
});
Deno.test("Google signs read-only storage OAuth assertions and refuses token redirects", async () => {
  const key = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", key.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(Array.from(der, (n) => String.fromCharCode(n)).join(""))
  }\n-----END PRIVATE KEY-----`;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    equal(String(url), "https://oauth2.googleapis.com/token");
    equal((init as RequestInit)?.redirect, "error");
    const assertion = new URLSearchParams(String((init as RequestInit)?.body))
      .get("assertion")!;
    const [header, claims, signature] = assertion.split(".");
    const decode = (s: string) =>
      Uint8Array.from(
        atob(s.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
    const payload = JSON.parse(new TextDecoder().decode(decode(claims)));
    equal(
      payload.scope,
      "https://www.googleapis.com/auth/devstorage.read_only",
    );
    equal(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key.publicKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
      true,
    );
    return new Response(JSON.stringify({ access_token: "test-token" }));
  };
  try {
    equal(
      await getGoogleStorageToken(
        JSON.stringify({
          client_email: "test@example.iam.gserviceaccount.com",
          private_key: pem,
        }),
      ),
      "test-token",
    );
  } finally {
    globalThis.fetch = previous;
  }
});
Deno.test("Google paginates, downloads only matching country files, and falls back across month boundary", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, init) => {
    calls++;
    equal(
      ((init as RequestInit)?.headers as Record<string, string>).Authorization,
      "Bearer test-token",
    );
    const target = new URL(String(url));
    if (!target.searchParams.has("alt")) {
      if (target.searchParams.has("pageToken")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{
                name:
                  "stats/ratings/ratings_com.coffee.timer_202608_country.csv",
              }],
            }),
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({
          items: [{
            name: "stats/ratings/ratings_com.coffee.timer_202609_country.csv",
          }, {
            name: "stats/ratings/ratings_com.coffee.timer_202609_device.csv",
          }],
          nextPageToken: "page-2",
        })),
      );
    }
    return Promise.resolve(
      new Response(
        header +
          (decodeURIComponent(target.pathname).includes("202608")
            ? "2026-08-31,com.coffee.timer,US,,4.8"
            : "2026-09-01,com.coffee.timer,US,,"),
      ),
    );
  };
  try {
    const report = await collectGoogleReport(
      "pubsite_prod_example",
      "com.coffee.timer",
      "test-token",
      "2026-09-01",
    );
    equal(report.sourceDate, "2026-08-31");
    equal(calls, 4);
  } finally {
    globalThis.fetch = previous;
  }
});
