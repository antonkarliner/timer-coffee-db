import {
  CollectionError,
  fetchChecked,
  isSourceDate,
  type Observation,
  type Snapshot,
} from "./model.ts";

const STORAGE_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getGoogleStorageToken(json: string): Promise<string> {
  let account: {
    client_email?: string;
    private_key?: string;
    private_key_id?: string;
  };
  try {
    account = JSON.parse(json);
  } catch {
    throw new CollectionError("google_invalid_credentials");
  }
  if (
    !account.client_email?.endsWith(".gserviceaccount.com") ||
    !account.private_key
  ) {
    throw new CollectionError("google_invalid_credentials");
  }
  const encode = (value: unknown) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${
    encode({ alg: "RS256", typ: "JWT", kid: account.private_key_id })
  }.${
    encode({
      iss: account.client_email,
      scope: STORAGE_SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })
  }`;
  let signature: ArrayBuffer;
  try {
    const pem = account.private_key.replace(
      /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
      "",
    );
    const key = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
  } catch {
    throw new CollectionError("google_invalid_credentials");
  }
  const response = await fetchChecked(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`,
    }),
  });
  const token = await response.json();
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new CollectionError("google_token_missing");
  }
  return token.access_token;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!quoted && (field !== "" || closedQuote)) {
        throw new CollectionError("google_invalid_csv");
      } else {
        if (quoted) closedQuote = true;
        quoted = !quoted;
      }
    } else if (!quoted && char === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((item) => item !== "")) rows.push(row);
      row = [];
      field = "";
      closedQuote = false;
    } else {
      if (closedQuote && !quoted) {
        throw new CollectionError("google_invalid_csv");
      }
      field += char;
    }
  }
  if (quoted) throw new CollectionError("google_invalid_csv");
  row.push(field);
  if (row.some((item) => item !== "")) rows.push(row);
  return rows;
}

export function decodeReport(bytes: Uint8Array): string {
  if (bytes.length > MAX_REPORT_BYTES) {
    throw new CollectionError("google_report_too_large");
  }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe
    ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff
    ? "utf-16be"
    : bytes[1] === 0
    ? "utf-16le"
    : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(
    /^\uFEFF/,
    "",
  );
}

export interface GoogleReport {
  observations: Observation[];
  snapshot: Snapshot | null;
  sourceDate: string;
}
export function parseGoogleReport(
  text: string,
  packageName: string,
  today: string,
): GoogleReport {
  const [headers, ...rows] = parseCsv(text.replace(/^\uFEFF/, ""));
  const required = ["Date", "Package Name", "Country", "Total Average Rating"];
  if (
    !headers || new Set(headers).size !== headers.length ||
    required.some((name) => !headers.includes(name))
  ) {
    throw new CollectionError("google_unsupported_report_headers");
  }
  const index = Object.fromEntries(
    required.map((name) => [name, headers.indexOf(name)]),
  );
  const valid = rows.filter((row) => {
    if (row.length !== headers.length) {
      throw new CollectionError("google_invalid_csv_row");
    }
    if (row[index["Package Name"]] !== packageName) {
      throw new CollectionError("google_package_mismatch");
    }
    if (!isSourceDate(row[index.Date], today)) {
      throw new CollectionError("google_invalid_source_date");
    }
    return row[index["Total Average Rating"]].trim() !== "";
  });
  if (!valid.length) throw new CollectionError("google_no_ratings");
  const sourceDate = valid.map((row) => row[index.Date]).sort().at(-1)!;
  const latest = valid.filter((row) => row[index.Date] === sourceDate);
  const observations: Observation[] = [];
  let overall: number | null = null;
  const seen = new Set<string>();
  for (const row of latest) {
    const country = row[index.Country].trim();
    const rawRating = row[index["Total Average Rating"]].trim();
    if (!/^\d+(?:\.\d+)?$/.test(rawRating)) {
      throw new CollectionError("google_invalid_rating");
    }
    const rating = Number(rawRating);
    if (rating < 1 || rating > 5) {
      throw new CollectionError("google_invalid_rating");
    }
    // A blank or "Other" country is an unknown segment, NOT a worldwide total.
    if (
      /^(Overall|All countries|All countries or regions|All countries\/regions)$/i
        .test(country)
    ) {
      if (overall !== null) {
        throw new CollectionError("google_duplicate_overall");
      }
      overall = rating;
    } else if (/^[A-Za-z]{2}$/.test(country)) {
      const code = country.toLowerCase();
      if (seen.has(code)) throw new CollectionError("google_duplicate_country");
      seen.add(code);
      observations.push({
        country: code,
        status: "ok",
        average_rating: rating,
        rating_count: null,
        source_date: sourceDate,
      });
    }
  }
  return {
    observations,
    sourceDate,
    snapshot: overall === null ? null : {
      average_rating: overall,
      rating_count: null,
      source_date: sourceDate,
      methodology: "google_play_total_average",
      coverage: { countriesReported: observations.length, overallRow: true },
    },
  };
}

export async function collectGoogleReport(
  bucket: string,
  packageName: string,
  token: string,
  today: string,
): Promise<GoogleReport> {
  if (
    !/^[a-z0-9][a-z0-9._-]+$/.test(bucket) || bucket.includes("..") ||
    !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(packageName)
  ) throw new CollectionError("google_invalid_configuration");
  const prefix = `stats/ratings/ratings_${packageName}_`;
  const candidates: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${
        encodeURIComponent(bucket)
      }/o`,
    );
    url.search = new URLSearchParams({
      prefix,
      maxResults: "1000",
      fields: "items(name),nextPageToken",
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const response = await fetchChecked(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listing = await response.json();
    for (const item of listing.items ?? []) {
      if (typeof item.name !== "string") {
        throw new CollectionError("google_invalid_object_list");
      }
      const suffix = item.name.slice(prefix.length);
      if (
        /^\d{6}_country\.csv$/.test(suffix) &&
        suffix.slice(0, 6) <= today.slice(0, 7).replace("-", "")
      ) candidates.push(item.name);
    }
    pageToken = listing.nextPageToken;
    if (!pageToken) break;
    if (page === 9) throw new CollectionError("google_object_list_too_large");
  }
  // Try the latest and previous month: Google exports lag at month boundaries.
  for (const name of candidates.sort().reverse().slice(0, 2)) {
    const url = `https://storage.googleapis.com/storage/v1/b/${
      encodeURIComponent(bucket)
    }/o/${encodeURIComponent(name)}?alt=media`;
    const response = await fetchChecked(url, {
      headers: { Authorization: `Bearer ${token}` },
    }, 20_000);
    const reader = response.body?.getReader();
    if (!reader) throw new CollectionError("google_empty_report");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_REPORT_BYTES) {
        await reader.cancel();
        throw new CollectionError("google_report_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return parseGoogleReport(decodeReport(bytes), packageName, today);
    } catch (error) {
      if (
        !(error instanceof CollectionError) ||
        error.code !== "google_no_ratings"
      ) throw error;
    }
  }
  throw new CollectionError("google_no_country_report");
}
