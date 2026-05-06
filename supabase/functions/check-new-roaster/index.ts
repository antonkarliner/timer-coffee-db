//  check-new-roaster.ts
//  ────────────────────────────────────────────────────────────────
//  Full, self‑contained Edge Function that:
//    ▸ detects new roaster INSERTs
//    ▸ searches Google + Postgres for similar names
//    ▸ resolves a physical location via   1) Nominatim   2) Gemini 2.0‑Flash
//    ▸ logs everything to service.new_roaster_candidates
//    ▸ optionally e‑mails the admin via Resend
//
//  Requires the following env‑vars (all already present in your project):
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//    RESEND_API_KEY, ADMIN_EMAIL
//    GOOGLE_SEARCH_API_KEY, GOOGLE_PROGRAMMABLE_ENGINE_ID
//    ROASTER_EMAIL_ENABLED  ("false" to disable e‑mail)
//    GOOGLE_APPLICATION_CREDENTIALS_JSON (service‑account json string)
//    GEMINI_PROJECT_ID, GEMINI_REGION
//    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS (comma‑separated)
//    TELEGRAM_ENABLED ("false" to disable Telegram notifications)
//  ────────────────────────────────────────────────────────────────
//  Change‑log (2025‑07‑28)
//    • Always vet *every* Nominatim hit with Gemini 2.0‑Flash.
//    • Gemini may return {"index":‑1} → treat as "no match".
//    • If Gemini rejects all OSM hits, fall back to geminiFindAddress().
//    • Nominatim query now appends plain " coffee" (was " coffee roastery")
//      to broaden results for brands tagged as café or shop.
//  Change‑log (2026‑01‑27)
//    • Upgraded to Gemini 2.5‑Flash‑Lite (same pricing, 8x larger context)
//    • Added vector similarity search for roaster matching
//    • Hybrid matching: vector search (primary) + trigram fallback
//    • Returns both vector and trigram match details in response
//  Change‑log (2026‑01‑29)
//    • Fixed Gemini model name from gemini-2.5-flash-lite-preview-06-17 to gemini-2.5-flash-lite
//    • Added proper endpoint construction for preview vs stable models
//    • Added SSL certificate error handling in scrapeAddressFromSite
//  Change‑log (2026‑02‑02)
//    • Restored Telegram notifications for new roaster candidates
//    • Added TELEGRAM_ENABLED env-var toggle (defaults to true)
//    • Sends roaster name, bean name, similar candidates, and location
//  ────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
/* ── env ───────────────────────────────────────────────────────── */ const supabaseUrl =
  Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL");
const GOOGLE_SEARCH_API_KEY = Deno.env.get("GOOGLE_SEARCH_API_KEY");
const GOOGLE_PROGRAMMABLE_ENGINE_ID = Deno.env.get(
  "GOOGLE_PROGRAMMABLE_ENGINE_ID",
);
const ROASTER_EMAIL_ENABLED = Deno.env.get("ROASTER_EMAIL_ENABLED") !== "false";
const GOOGLE_APPLICATION_CREDENTIALS_JSON = Deno.env.get(
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
);
const GEMINI_PROJECT_ID = Deno.env.get("GEMINI_PROJECT_ID");
const GEMINI_REGION = Deno.env.get("GEMINI_REGION");
const GEOCODING_API_KEY = Deno.env.get("GEOCODING_API_KEY") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_IDS = Deno.env.get("TELEGRAM_CHAT_IDS");
const TELEGRAM_ENABLED = Deno.env.get("TELEGRAM_ENABLED") !== "false";
if (
  !supabaseUrl || !supabaseServiceRoleKey || !RESEND_API_KEY || !ADMIN_EMAIL ||
  !GOOGLE_SEARCH_API_KEY || !GOOGLE_PROGRAMMABLE_ENGINE_ID ||
  !GOOGLE_APPLICATION_CREDENTIALS_JSON || !GEMINI_PROJECT_ID || !GEMINI_REGION
) {
  throw new Error("Required environment variables are not set");
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
/* ── 1.  Nominatim search ─────────────────────────────────────── */ async function lookupWithNominatim(
  roaster,
  limit = 10,
) {
  const coffeeWords = [
    "coffee",
    "café",
    "cafe",
    "kaffee",
    "kopi",
    "caffè",
    "caffe",
    "コーヒー",
    "koffie",
    "kawa",
    "cafea",
    "кофе",
    "kahve",
    "кава",
    "咖啡",
    "قهوة",
  ];
  const norm = roaster.toLowerCase().normalize("NFD").replace(
    /[\u0300-\u036f]/g,
    "",
  );
  const hasCoffee = coffeeWords.some((w) =>
    norm.includes(w.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
  );
  const query = hasCoffee ? roaster : roaster + " coffee";
  const url = "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(query)}` + "&format=json&limit=" + limit;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "timer.coffee/1.0 (admin@timer.coffee)",
      },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((d) => ({
      address: d.display_name,
      lat: +d.lat,
      lng: +d.lon,
      source: "nominatim",
    }));
  } catch (e) {
    console.error("[lookupWithNominatim]", e);
    return [];
  }
}
/* ── util: single‑shot geocoder ──────────────────────────────── */ async function geocodeWithMapsCo(
  address,
) {
  if (!GEOCODING_API_KEY) return null;
  try {
    const url = "https://geocode.maps.co/search?q=" +
      encodeURIComponent(address) + `&api_key=${GEOCODING_API_KEY}`;
    const r = await fetch(url);
    if (r.status === 401 || r.status === 403) {
      console.warn("[geocodeWithMapsCo] invalid maps.co API key");
      return null;
    }
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.length) return null;
    return {
      address: j[0].display_name,
      lat: +j[0].lat,
      lng: +j[0].lon,
      source: "maps.co",
    };
  } catch (e) {
    console.error("[geocodeWithMapsCo]", e);
    return null;
  }
}
async function geocodeWithNominatim(address) {
  const res = await lookupWithNominatim(address, 1);
  if (res[0]) return res[0];
  return await geocodeWithMapsCo(address); // may still be null
}
/* ── 2.  Vertex access token (cached) ─────────────────────────── */ let cachedToken =
  null;
async function getVertexToken() {
  if (cachedToken) return cachedToken;
  const svc = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const h = {
    alg: "RS256",
    typ: "JWT",
  };
  const p = {
    iss: svc.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp,
  };
  const b64url = (s) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsigned = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}`;
  const keyDer = Uint8Array.from(
    atob(
      svc.private_key.replace(/-----\w+ PRIVATE KEY-----/g, "").replace(
        /\s+/g,
        "",
      ),
    ),
    (c) => c.charCodeAt(0),
  );
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    [
      "sign",
    ],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${
    b64url(String.fromCharCode(...new Uint8Array(sig)))
  }`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error("Failed to obtain Google token");
  const { access_token } = await res.json();
  cachedToken = access_token;
  return access_token;
}
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_IS_PREVIEW_MODEL = GEMINI_MODEL.includes("preview");
const GEMINI_LOCATION = GEMINI_IS_PREVIEW_MODEL
  ? "global"
  : GEMINI_REGION === "global"
  ? "global"
  : GEMINI_REGION;
const GEMINI_HOST = GEMINI_IS_PREVIEW_MODEL
  ? "aiplatform.googleapis.com"
  : GEMINI_REGION === "global"
  ? "aiplatform.googleapis.com"
  : `${GEMINI_REGION}-aiplatform.googleapis.com`;
const GEMINI_ENDPOINT =
  `https://${GEMINI_HOST}/v1/projects/${GEMINI_PROJECT_ID}/locations/${GEMINI_LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
/* ── 3.  Gemini helpers  (revised 2025‑07‑28) ─────────────────── */
/** Build a request body that honours Vertex‑AI constraints:
 *  – `google_search` tool ⇢ no controlled generation (no schema/mime‑type)
 *  – controlled generation ⇢ must NOT include `google_search`
 */ /** Build a request body that respects Vertex‑AI rules */ function buildGeminiBody(
  prompt,
  { schema = null, useSearch = false, temperature = 0.1 } = {},
) {
  // 1) generationConfig — add extra fields only when allowed
  const generationConfig = {
    temperature,
  };
  if (schema && !useSearch) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }
  // 2) body
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig,
  };
  if (useSearch) {
    body.tools = [
      {
        google_search: {},
      },
    ];
  }
  return body;
}
/* ── Gemini helper: vet OSM candidates ───────────────────────── */ async function chooseBestWithGemini(
  roaster,
  candidates,
) {
  if (!candidates.length) return null;
  const token = await getVertexToken();
  const prompt = `You are a coffee‑industry data assistant.\n` +
    `Below are candidate addresses for the roaster "${roaster}".\n` +
    `Return ONLY JSON: {"index": number} — best match (0‑based) or -1 if none.\n\n` +
    candidates.map((c, i) =>
      `${i}. ${c.address} (${c.lat.toFixed(6)}, ${c.lng.toFixed(6)})`
    ).join("\n");
  const body = buildGeminiBody(prompt, {
    schema: {
      type: "object",
      properties: {
        index: {
          type: "integer",
        },
      },
      required: [
        "index",
      ],
    },
  });
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("[chooseBestWithGemini]", res.status, await res.text());
    return null;
  }
  const raw = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text ??
    "";
  const cleaned = stripCodeFence(raw);
  try {
    const { index } = JSON.parse(cleaned);
    return index >= 0 && candidates[index]
      ? {
        ...candidates[index],
        source: "gemini",
      }
      : null;
  } catch {
    console.error("[chooseBestWithGemini] bad JSON", raw);
    return null;
  }
}
/* ── Gemini helper: web‑find an address (revised) ───────────── */ async function geminiFindAddress(
  roaster,
) {
  const token = await getVertexToken();
  const prompt =
    `Provide the street address, latitude and longitude of the coffee ` +
    `roaster named "${roaster}". If you cannot find coordinates, set them ` +
    `to null.\n\nReturn **ONLY raw JSON with no markdown fences** in exactly this shape:` +
    ` {"address": string, "lat": number|null, "lng": number|null}`;
  const body = buildGeminiBody(prompt, {
    useSearch: true,
    temperature: 1.1,
  });
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("[geminiFindAddress]", res.status, await res.text());
    return null;
  }
  const raw = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text ??
    "";
  const cleaned = stripCodeFence(raw);
  let obj = null;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // JSON not parseable; will attempt regex salvage below
  }
  /* 0️⃣ Valid JSON but address is null → Gemini couldn't find it */ if (
    obj && obj.address === null
  ) {
    // Gemini returned valid "not found" response - this is normal
    return null;
  }
  /* 1️⃣ Valid JSON with an address string */ if (
    obj && typeof obj.address === "string" && obj.address.trim()
  ) {
    const lat = Number(obj.lat);
    const lng = Number(obj.lng);
    // 1a. Gemini already supplied usable numbers
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return {
        address: obj.address,
        lat,
        lng,
        source: "gemini",
      };
    }
    // 1b. Coordinates missing → geocode ourselves
    const geo = await geocodeWithNominatim(obj.address);
    if (geo) {
      return {
        ...geo,
        source: "gemini+osm",
      };
    }
  }
  /* 2️⃣ Raw text not JSON → salvage address with regex */ const m = cleaned
    .match(/"address"\s*:\s*"([^"]+)"/s);
  if (m) {
    const geo = await geocodeWithNominatim(m[1]);
    if (geo) {
      return {
        ...geo,
        source: "gemini+osm",
      };
    }
  }
  /* 3️⃣ Truly unparseable - only log in this case */ console.error(
    "[geminiFindAddress] unparsable output",
    raw,
  );
  return null;
}
/* ── 4.  Master resolve ───────────────────────────────────────── */ async function resolveLocation(
  roaster,
  googleResults: Array<{ link?: string; url?: string }> = [],
) {
  const scraped = await geocodeFromSearch(googleResults); // new helper ↓
  const osmHits = await lookupWithNominatim(roaster, 10);
  const candidates = [
    ...scraped,
    ...osmHits,
  ];
  if (candidates.length) {
    const vetted = await chooseBestWithGemini(roaster, candidates);
    if (vetted) return vetted;
  }
  return await geminiFindAddress(roaster);
}
/* ── 5.  Google Custom Search helper ─────────────── */
const SEARCH_AGGREGATOR_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "yelp.com",
  "tripadvisor.com",
  "google.com",
  "foursquare.com",
  "sprudge.com",
  "coffeereview.com",
  "europeancoffeetrip.com",
];
const COFFEE_WORDS = [
  "coffee",
  "cafe",
  "café",
  "kaffee",
  "kopi",
  "caffè",
  "caffe",
  "roaster",
  "roasters",
  "roastery",
  "coffeehouse",
  "コーヒー",
  "koffie",
  "kawa",
  "cafea",
  "кофе",
  "kahve",
  "кава",
  "咖啡",
  "قهوة",
];
const SEARCH_RESULT_LIMIT = 8;
function normalizeForSearch(value) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(
    /[\u0300-\u036f]/g,
    "",
  );
}
function compactWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function searchTokens(value) {
  const normalized = normalizeForSearch(value).replace(/[^\p{L}\p{N}]+/gu, " ");
  const coffeeWordSet = new Set(COFFEE_WORDS.map(normalizeForSearch));
  return [
    ...new Set(
      normalized.split(/\s+/).filter((token) =>
        token.length >= 3 && !coffeeWordSet.has(token)
      ),
    ),
  ].slice(0, 6);
}
function hasCoffeeWord(value) {
  const normalized = normalizeForSearch(value);
  return COFFEE_WORDS.some((word) =>
    normalized.includes(normalizeForSearch(word))
  );
}
function quoteQuery(value) {
  return `"${compactWhitespace(value).replace(/"/g, "")}"`;
}
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
function normalizeSearchUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    return parsed.toString();
  } catch {
    return String(url ?? "");
  }
}
function isAggregatorDomain(domain) {
  return SEARCH_AGGREGATOR_DOMAINS.some((blocked) =>
    domain === blocked || domain.endsWith(`.${blocked}`)
  );
}
function buildSearchQueries(roaster, extra) {
  const name = compactWhitespace(roaster);
  const extraText = compactWhitespace(extra);
  const baseCoffee = hasCoffeeWord(name) ? name : `${name} coffee`;
  const queries = [
    {
      query: `${quoteQuery(name)} coffee roaster official`,
      kind: "roaster_official",
    },
    {
      query: `${baseCoffee} roastery`,
      kind: "roaster_general",
    },
  ];
  if (extraText) {
    queries.unshift({
      query: `${quoteQuery(name)} ${quoteQuery(extraText)} coffee`,
      kind: "roaster_bean",
    });
  }
  const seen = new Set();
  return queries.filter((entry) => {
    const key = normalizeForSearch(entry.query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 2);
}
function scoreSearchItem(item, roaster, rank) {
  const domain = extractDomain(item.link);
  const tokens = searchTokens(roaster);
  const title = normalizeForSearch(item.title);
  const snippet = normalizeForSearch(item.snippet);
  let score = Math.max(0, 12 - rank);
  if (item.link?.startsWith("https://")) score += 2;
  if (!isAggregatorDomain(domain)) score += 20;
  if (tokens.some((token) => domain.includes(token))) score += 35;
  if (tokens.length && tokens.every((token) => title.includes(token))) {
    score += 20;
  }
  if (tokens.some((token) => snippet.includes(token))) score += 8;
  if (
    /(coffee|cafe|roaster|roastery|specialty)/i.test(
      `${item.title} ${item.snippet}`,
    )
  ) {
    score += 8;
  }
  if (isAggregatorDomain(domain)) score -= 18;
  if (/\/maps|google\.[^/]+\/search/i.test(item.link ?? "")) score -= 25;
  return score;
}
async function runGoogleSearch(query, kind, roaster) {
  try {
    const url =
      `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_API_KEY}` +
      `&cx=${GOOGLE_PROGRAMMABLE_ENGINE_ID}` +
      `&q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Custom Search error ${res.status}`);
    const items = (await res.json()).items ?? [];
    return items.slice(0, 5).map((it, index) => ({
      title: it.title,
      link: it.link,
      snippet: it.snippet ?? null,
      display_link: it.displayLink ?? null,
      query,
      query_kind: kind,
      rank: index + 1,
      domain: extractDomain(it.link),
      evidence_score: scoreSearchItem(it, roaster, index + 1),
    }));
  } catch (err) {
    console.error("[searchRoasterWebsite]", err);
    return [];
  }
}
async function searchRoasterWebsite(roaster, extra = "") {
  const seen = new Set();
  const results = [];
  const queries = buildSearchQueries(roaster, extra);
  for (const { query, kind } of queries) {
    const items = await runGoogleSearch(query, kind, roaster);
    for (const item of items) {
      const key = normalizeSearchUrl(item.link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  }
  return results.sort((a, b) => b.evidence_score - a.evidence_score).slice(
    0,
    SEARCH_RESULT_LIMIT,
  );
}
function buildBeanSearchContext(record) {
  return [
    record?.name,
    record?.origin,
    record?.region,
    record?.farm,
    record?.farmer,
  ].map(compactWhitespace).filter(Boolean).slice(0, 4).join(" ");
}
function buildCandidateNotes(record, googleSearchResults, beanSearchResults) {
  const context = {
    source: "check-new-roaster",
    source_record: {
      id: record?.id ?? null,
      origin: record?.origin ?? null,
      region: record?.region ?? null,
      farm: record?.farm ?? null,
      farmer: record?.farmer ?? null,
      variety: record?.variety ?? null,
      processing_method: record?.processing_method ?? null,
      tasting_notes: record?.tasting_notes ?? null,
      cupping_score: record?.cupping_score ?? null,
    },
    search_queries: [
      ...googleSearchResults,
      ...beanSearchResults,
    ].map((result) => ({
      query: result.query ?? null,
      kind: result.query_kind ?? null,
    })).filter((entry, index, array) =>
      entry.query &&
      array.findIndex((item) => item.query === entry.query) === index
    ),
  };
  return JSON.stringify(context);
}
/* ── 6.  DB + e‑mail helpers ---------------------------------------------------------- */ async function logCandidateToTable(
  roaster,
  coffeeBeanName,
  candidates,
  googleSearchResults,
  beanSearchResults,
  location,
  notes,
) {
  const { error } = await supabase.schema("service").from(
    "new_roaster_candidates",
  ).insert({
    roaster,
    coffee_bean_name: coffeeBeanName,
    similar_candidates: candidates,
    google_search_results: googleSearchResults,
    bean_search_results: beanSearchResults,
    location,
    notes,
  });
  if (error) console.error("[logCandidateToTable]", error);
}
async function sendAlertEmail(
  roaster,
  coffeeBeanName,
  similarCandidates,
  searchResults,
  beanSearchResults,
  location,
) {
  const searchHtml = searchResults.length
    ? "<ul>" + searchResults.map((r) =>
      `<li><a href="${r.link}">${r.title}</a></li>`
    ).join("") + "</ul>"
    : "<p>No search results found.</p>";
  const beanHtml = beanSearchResults.length
    ? "<ul>" + beanSearchResults.map((r) =>
      `<li><a href="${r.link}">${r.title}</a></li>`
    ).join("") + "</ul>"
    : "<p>No search results for roaster + bean.</p>";
  const candHtml = similarCandidates.length
    ? "<ul>" + similarCandidates.map((c) =>
      `<li>${c.roaster_name} (Score: ${c.sim_score.toFixed(2)})</li>`
    ).join("") + "</ul>"
    : "<p>No similar roasters found above threshold.</p>";
  const locHtml = location
    ? `<p><strong>Location (auto):</strong> ${location.address}<br/>Lat/Lng: ${location.lat}, ${location.lng} • via ${location.source}</p>`
    : "<p><strong>Location:</strong> not resolved automatically.</p>";
  const html = `
    <p>A new coffee beans record was added:</p>
    <p><strong>Roaster:</strong> ${roaster}<br/><strong>Bean:</strong> ${coffeeBeanName}</p>
    <p><strong>Roaster search:</strong>${searchHtml}</p>
    <p><strong>Roaster + Bean search:</strong>${beanHtml}</p>
    ${locHtml}
    <p><strong>Similar names in DB:</strong>${candHtml}</p>
    <p>Please review and update <em>coffee_roasters</em> if necessary.</p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "roasters@timer.coffee",
      to: ADMIN_EMAIL,
      subject: `New Potential Roaster: ${roaster}`,
      html,
    }),
  });
  if (!res.ok) console.error("[sendAlertEmail]", res.status, await res.text());
}
/* ── Telegram notification helper ───────────────────────────── */ async function sendTelegramNotification(
  roaster,
  coffeeBeanName,
  similarCandidates,
  location,
) {
  if (!TELEGRAM_ENABLED) {
    console.log(
      "[sendTelegramNotification] Telegram disabled via TELEGRAM_ENABLED",
    );
    return;
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_IDS) {
    console.log("[sendTelegramNotification] Telegram not configured, skipping");
    return;
  }
  const chatIds = TELEGRAM_CHAT_IDS.split(",").map((id) => id.trim()).filter(
    Boolean,
  );
  if (chatIds.length === 0) {
    console.log("[sendTelegramNotification] No chat IDs configured");
    return;
  }
  // Format message
  let message = `☕ *New Roaster Candidate*\n\n`;
  message += `*Roaster:* ${roaster}\n`;
  message += `*Bean:* ${coffeeBeanName || "N/A"}\n\n`;
  if (similarCandidates.length > 0) {
    message += `*Similar roasters in DB:*\n`;
    similarCandidates.slice(0, 5).forEach((c) => {
      message += `• ${c.roaster_name} (${
        (c.sim_score * 100).toFixed(0)
      }% match)\n`;
    });
  } else {
    message += `*No similar roasters found*\n`;
  }
  if (location) {
    message += `\n📍 *Location:* ${location.address}`;
  }
  // Send to all configured chat IDs
  for (const chatId of chatIds) {
    try {
      const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const error = await res.text();
        console.error(
          `[sendTelegramNotification] Failed for chat ${chatId}:`,
          error,
        );
      } else {
        console.log(`[sendTelegramNotification] Sent to chat ${chatId}`);
      }
    } catch (e) {
      console.error(
        `[sendTelegramNotification] Exception for chat ${chatId}:`,
        e,
      );
    }
  }
}
/* ── address scraping helpers (NEW) ──────────────────────────── */ function stripCodeFence(
  s,
) {
  if (!s) return s;
  // remove ```json ... ``` or ``` ... ```
  return s.replace(/^```(\w+)?\s*/i, "").replace(/```$/i, "").trim();
}
const ADDRESS_RE =
  /\b\d{1,5}\s+[\w\.,'\-\s]{3,100},?\s+[A-Z][A-Za-z\.\-\s]{2,60},?\s+[A-Z]{2}\s+\d{4,6}\b/;
async function scrapeAddressFromSite(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(ADDRESS_RE);
    return m ? m[0] : null;
  } catch (e) {
    // Handle SSL certificate errors gracefully
    if (
      e instanceof TypeError && e.message.includes("invalid peer certificate")
    ) {
      console.warn(
        "[scrapeAddressFromSite]",
        url,
        "SSL certificate error - skipping",
      );
      return null;
    }
    console.warn("[scrapeAddressFromSite]", url, e);
    return null;
  }
}
async function geocodeFromSearch(links, n = 3) {
  const picked = links.slice(0, n);
  const out = [];
  for (const it of picked) {
    const addr = await scrapeAddressFromSite(it.link);
    if (!addr) continue;
    const geo = await geocodeWithNominatim(addr) ??
      await geocodeWithMapsCo(addr);
    if (geo) out.push(geo);
  }
  return out;
}
/* ── 7.  Edge Function handler ------------------------------------------------------- */
/**
 * Generate embedding for vector search using OpenAI API
 */ async function generateEmbedding(text) {
  try {
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiApiKey) {
      console.log(
        "[generateEmbedding] OPENAI_API_KEY not set, skipping vector search",
      );
      return null;
    }
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        model: "text-embedding-3-small",
        dimensions: 384,
      }),
    });
    if (!response.ok) {
      console.error(
        "[generateEmbedding] OpenAI error:",
        response.status,
        await response.text(),
      );
      return null;
    }
    const data = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error("[generateEmbedding] Exception:", error);
    return null;
  }
}
/**
 * Search for roasters using vector similarity
 */ async function searchRoastersByVector(roasterName) {
  try {
    const embedding = await generateEmbedding(roasterName);
    if (!embedding) return [];
    const { data, error } = await supabase.rpc("search_roasters_by_vector", {
      query_embedding: embedding,
      match_threshold: 0.75,
      match_count: 3,
    });
    if (error) {
      console.error("[searchRoastersByVector] RPC error:", error);
      return [];
    }
    return data || [];
  } catch (error) {
    console.error("[searchRoastersByVector] Exception:", error);
    return [];
  }
}
Deno.serve(async (req) => {
  try {
    const { record, type } = await req.json();
    if (type !== "INSERT" || !record?.roaster) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }
    const roaster = record.roaster.trim();
    const coffeeBeanName = record.name?.trim() ?? "";
    /* 0) Exact‑match RPC ---------------------------------------------------------- */ const {
      data: unaccentMatch,
      error: unaccentErr,
    } = await supabase.rpc("search_roaster_unaccent", {
      search_name: roaster,
    });
    if (unaccentErr) throw new Error(unaccentErr.message);
    if (unaccentMatch && unaccentMatch.length > 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Exact match; no action.",
        }),
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }
    /* 1) Vector similarity search (new) ------------------------------------------ */ const vectorMatches =
      await searchRoastersByVector(roaster);
    /* 2) Fuzzy candidates (trigram fallback) ------------------------------------- */ const SIMILARITY_THRESHOLD =
      0.6;
    const { data: roasterCandidates, error: candErr } = await supabase.rpc(
      "search_roaster_candidates",
      {
        in_value: roaster,
        match_threshold: SIMILARITY_THRESHOLD,
      },
    );
    if (candErr) throw new Error(candErr.message);
    // Combine vector and trigram results, prioritizing vector matches
    const candidatesToSend = [];
    // Add vector matches first (with high scores)
    for (const match of vectorMatches) {
      candidatesToSend.push({
        roaster_name: match.roaster_name,
        sim_score: match.similarity_score,
      });
    }
    // Add trigram matches that aren't already in the list
    for (const candidate of roasterCandidates || []) {
      const alreadyExists = candidatesToSend.some((c) =>
        c.roaster_name === candidate.roaster_name
      );
      if (!alreadyExists) {
        candidatesToSend.push(candidate);
      }
    }
    /* 3) Google web search -------------------------------------------------------- */ const googleResults =
      await searchRoasterWebsite(roaster);
    const beanSearchContext = buildBeanSearchContext(record) || coffeeBeanName;
    const beanResults = await searchRoasterWebsite(roaster, beanSearchContext);
    /* 4) Location resolve --------------------------------------------------------- */ const locationResult =
      await resolveLocation(roaster, googleResults);
    /* 5) Persist ------------------------------------------------------------------ */ const notes =
      buildCandidateNotes(record, googleResults, beanResults);
    await logCandidateToTable(
      roaster,
      coffeeBeanName,
      candidatesToSend,
      googleResults,
      beanResults,
      locationResult,
      notes,
    );
    /* 6) Optional e‑mail ---------------------------------------------------------- */ if (
      ROASTER_EMAIL_ENABLED
    ) {
      await sendAlertEmail(
        roaster,
        coffeeBeanName,
        candidatesToSend,
        googleResults,
        beanResults,
        locationResult,
      );
    }
    /* 7) Telegram notification ---------------------------------------------------- */ await sendTelegramNotification(
      roaster,
      coffeeBeanName,
      candidatesToSend,
      locationResult,
    );
    const msg = candidatesToSend.length > 0
      ? `Logged candidate and ${
        ROASTER_EMAIL_ENABLED ? "sent e‑mail" : "did not e‑mail"
      }; ${candidatesToSend.length} similar (vector: ${vectorMatches.length}, trigram: ${
        roasterCandidates?.length || 0
      }).`
      : `Logged candidate; ${
        ROASTER_EMAIL_ENABLED ? "e‑mailed" : "no e‑mail"
      }. No similar roasters.`;
    return new Response(
      JSON.stringify({
        success: true,
        message: msg,
        google_search_results: googleResults,
        bean_search_results: beanResults,
        location: locationResult,
        vector_matches: vectorMatches,
        trigram_matches: roasterCandidates || [],
        search_queries: [
          ...googleResults,
          ...beanResults,
        ].map((result) => result.query).filter((query, index, array) =>
          query && array.indexOf(query) === index
        ),
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("[EdgeFunction]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        success: false,
        error: msg,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
});
