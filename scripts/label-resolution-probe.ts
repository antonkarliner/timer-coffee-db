/**
 * Coffee-label RESOLUTION probe — hold the model and prompt fixed (GLM-5.3-flash,
 * thinking disabled, production prompt) and vary the IMAGE RESOLUTION of the
 * uploaded bag photos, to answer whether downscaling before upload changes
 * latency and extraction quality.
 *
 * This is a sibling of label-model-probe.ts, which varies model/prompt while
 * holding images fixed. This script is the complementary experiment: same
 * request shape, same production prompt builder, but the front/back JPEGs are
 * swapped out for pre-resized copies at several resolutions.
 *
 * WHY THIS IS A REAL LEVER, NOT AN ACADEMIC QUESTION: parse-coffee-label does
 * NO server-side resizing. supabase/functions/parse-coffee-label/index.ts only
 * slices the incoming array to the first two images
 * (`imagesBase64.slice(0, 2)`, index.ts:678) — it never touches pixel
 * dimensions. So whatever resolution the mobile app happens to upload is
 * exactly what the model sees, base64-inflated, on every scan in production.
 * If a lower resolution turns out to cost nothing in accuracy, downscaling on
 * the client is a straightforward win on upload time, request payload, and
 * (if provider pricing is resolution-sensitive) prompt tokens. If it costs
 * accuracy, that argues for the app uploading at whatever resolution it
 * currently does, or higher.
 *
 * Usage:
 *   Z_AI_API_KEY=... deno run --allow-env --allow-net --allow-read \
 *     scripts/label-resolution-probe.ts [--dir=path] [--loops=6] [--locale=en]
 *
 * Image directory convention: files named `<bag>-<res>-f.jpg` (front) and
 * `<bag>-<res>-b.jpg` (back). Bags and resolutions are discovered by scanning
 * the directory, not hardcoded, so dropping in a new bag or resolution needs
 * no code change. A bag/res pair missing either face is skipped with a
 * warning (a lone front or back photo cannot stand in for the pair
 * production actually sends).
 *
 * It does NOT print your API key.
 */
import {
  buildSystemPrompt,
  isPlausibleLabelResult,
  LABEL_RESPONSE_SCHEMA,
  normalizeResult,
} from "../supabase/functions/parse-coffee-label/label-utils.ts";

// ---------------------------------------------------------------------------
// Provider: Z.AI direct only. This probe is about resolution, not provider
// comparison, so there is exactly one provider config (unlike
// label-model-probe, which fans out across vercel/groq/zai).
// ---------------------------------------------------------------------------
const ZAI_API_KEY = Deno.env.get("Z_AI_API_KEY");
if (!ZAI_API_KEY) {
  console.error(
    "Z_AI_API_KEY is not set. Export it (or put it in .env.local and pass\n" +
      "--env-file=.env.local) — this probe only talks to Z.AI.",
  );
  Deno.exit(1);
}
// NOTE the /api/coding/ path: the plain /api/paas/v4 endpoint answers 429
// "insufficient balance" on this account, because the key is a coding-plan
// key rather than a pay-as-you-go key. That plan's terms are for coding
// tools, so this is a measurement channel only.
const ZAI_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
// Same spacing as label-model-probe's zai entry: generous enough that back
// to back Z.AI calls have not been observed to 429 in prior probe runs.
const MIN_SPACING_MS = 3000;
const REQUEST_TIMEOUT_MS = 60000;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 20000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const dirArg = Deno.args.find((a) => a.startsWith("--dir="));
const IMAGE_DIR = dirArg
  ? dirArg.slice("--dir=".length)
  : "/private/tmp/claude-501/-Users-antonkarliner-GitHub-timer-coffee-db/a6ed1a54-b1e0-4d45-99da-96535fe500e3/scratchpad/res";

const loopsArg = Deno.args.find((a) => a.startsWith("--loops="));
const LOOPS = loopsArg ? Number(loopsArg.slice("--loops=".length)) : 6;

// --thinking=on enables the reasoning pass for every call in the run.
const THINKING =
  Deno.args.some((a) => a === "--thinking=on" || a === "--thinking=enabled");
// --res=1200,2000 narrows the grid. Each resolution multiplies the call count,
// and thinking-on calls are ~5x slower, so a focused grid is often the only
// one that finishes.
const resArg = Deno.args.find((a) => a.startsWith("--res="));
const RES_FILTER = resArg
  ? new Set(resArg.slice("--res=".length).split(",").map((r) => r.trim()))
  : null;

const localeArg = Deno.args.find((a) => a.startsWith("--locale="));
const locale = localeArg ? localeArg.slice("--locale=".length) : "en";

// ---------------------------------------------------------------------------
// Discover bags and resolutions from the directory. Filenames:
//   <bag>-<res>-f.jpg   <bag>-<res>-b.jpg
// We deliberately do NOT hardcode bag names or resolution labels — dropping
// a new resized set into the directory should just work.
// ---------------------------------------------------------------------------
const FILENAME_RE = /^(.+)-([^-]+)-([fb])\.jpe?g$/i;

interface ImagePair {
  bag: string;
  res: string;
  front: string;
  back: string;
}

// Canonical resolution ordering. Anything not in this list sorts after it
// (alphabetically among the unknowns), so a typo'd or new resolution label
// still shows up rather than being dropped.
const RES_ORDER = ["640", "1200", "2000", "full"];
function resRank(res: string): number {
  const i = RES_ORDER.indexOf(res.toLowerCase());
  return i === -1 ? RES_ORDER.length : i;
}
function compareRes(a: string, b: string): number {
  const ra = resRank(a), rb = resRank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

async function discoverPairs(dir: string): Promise<ImagePair[]> {
  // bag -> res -> {f?, b?}
  const found = new Map<string, Map<string, { f?: string; b?: string }>>();
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    const m = FILENAME_RE.exec(entry.name);
    if (!m) continue;
    const [, bag, res, face] = m;
    if (!found.has(bag)) found.set(bag, new Map());
    const byRes = found.get(bag)!;
    if (!byRes.has(res)) byRes.set(res, {});
    const slot = byRes.get(res)!;
    const full = `${dir}/${entry.name}`;
    if (face.toLowerCase() === "f") slot.f = full;
    else slot.b = full;
  }

  const pairs: ImagePair[] = [];
  const bags = [...found.keys()].sort();
  for (const bag of bags) {
    const byRes = found.get(bag)!;
    const resolutions = [...byRes.keys()].sort(compareRes);
    for (const res of resolutions) {
      const slot = byRes.get(res)!;
      if (!slot.f || !slot.b) {
        console.warn(
          `Skipping ${bag}/${res}: missing ${slot.f ? "back" : "front"} face ` +
            `(a lone photo cannot stand in for the front+back pair production sends).`,
        );
        continue;
      }
      pairs.push({ bag, res, front: slot.f, back: slot.b });
    }
  }
  return pairs;
}

const discovered = await discoverPairs(IMAGE_DIR);
const allPairs = RES_FILTER
  ? discovered.filter((p) => RES_FILTER.has(p.res))
  : discovered;
if (RES_FILTER && allPairs.length === 0) {
  console.error(
    `--res=${[...RES_FILTER].join(",")} matched none of the discovered ` +
      `resolutions: ${[...new Set(discovered.map((p) => p.res))].join(", ")}`,
  );
  Deno.exit(1);
}
if (allPairs.length === 0) {
  console.error(
    `No usable <bag>-<res>-f.jpg / <bag>-<res>-b.jpg pairs found under ${IMAGE_DIR}.\n` +
      `Pass --dir=/path/to/images to point elsewhere.`,
  );
  Deno.exit(1);
}

const bags = [...new Set(allPairs.map((p) => p.bag))].sort();
const resolutionsByBag = new Map<string, string[]>();
for (const bag of bags) {
  resolutionsByBag.set(
    bag,
    allPairs.filter((p) => p.bag === bag).map((p) => p.res).sort(compareRes),
  );
}

console.log(
  `Discovered ${allPairs.length} bag/resolution pairs under ${IMAGE_DIR}:`,
);
for (const bag of bags) {
  console.log(`  ${bag}: ${resolutionsByBag.get(bag)!.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Build the same data:image/...;base64 URL parse-coffee-label's client sends.
// ---------------------------------------------------------------------------
async function toImageUrl(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const ext = path.split(".").pop()?.toLowerCase();
  const mime = ext === "png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

// Reuse the production prompt builder so this probe cannot drift from what
// parse-coffee-label actually sends. Model and prompt are held fixed for the
// whole run — only the images (per pair, below) vary.
const systemPrompt = buildSystemPrompt({
  locale,
  today: new Date().toISOString().slice(0, 10),
  ocrText: "",
});
const userText = `locale = ${locale}`;
const MODEL = "glm-5.3-flash";

// Field list, taken from the production response schema so it cannot drift.
// `error` is the error-envelope field, not a label field — exclude it.
const FIELDS = Object.keys(
  (LABEL_RESPONSE_SCHEMA.openai as { properties: Record<string, unknown> })
    .properties,
).filter((f) => f !== "error");

// ---------------------------------------------------------------------------
// Measurement plumbing
// ---------------------------------------------------------------------------
interface Row {
  bag: string;
  res: string;
  status: number | string;
  ms: number;
  parseOk: boolean;
  plausible: boolean;
  parsed: Record<string, unknown> | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  payloadMb: number;
  note: string;
}
const results: Row[] = [];

function emptyish(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

let lastCallAt = 0;
async function respectSpacing(): Promise<void> {
  const wait = MIN_SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) {
    console.log(`  …pacing ${(wait / 1000).toFixed(1)}s for provider limits…`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function callModel(
  imageUrls: string[],
): Promise<{ res: Response; ms: number }> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      },
    ],
    temperature: 1,
    top_p: 0.95,
    stream: false,
    response_format: { type: "json_object" },
    // Thinking-on needs far more room: the reasoning pass alone spends
    // ~650-900 tokens, so the production 1024 cap would truncate the JSON.
    max_tokens: THINKING ? 4096 : 1024,
    // Held fixed across every resolution within a run — this probe isolates
    // image size. --thinking=on re-runs the whole grid with the reasoning
    // pass enabled, because resolution and thinking interact: reasoning is
    // what lets the model apply the prompt's lot-number rule, and fewer image
    // tokens is what makes thinking affordable in wall-clock.
    thinking: { type: THINKING ? "enabled" : "disabled" },
  };
  await respectSpacing();
  const started = Date.now();
  const timer = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ZAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ZAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: timer,
    });
    return { res, ms: Date.now() - started };
  } finally {
    lastCallAt = Date.now();
  }
}

async function probe(
  pair: ImagePair,
  round: number,
): Promise<void> {
  const imageUrls = await Promise.all([pair.front, pair.back].map(toImageUrl));
  const payloadMb = imageUrls.reduce((n, u) => n + u.length, 0) / 1024 / 1024;

  console.log(`\n========================================`);
  console.log(
    `BAG: ${pair.bag}  RES: ${pair.res}  [round ${round}/${LOOPS}]  payload=${
      payloadMb.toFixed(2)
    }MB`,
  );

  let res: Response;
  let ms = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ res, ms } = await callModel(imageUrls));
    } catch (e) {
      console.log(`NETWORK ERROR: ${e}`);
      results.push({
        bag: pair.bag,
        res: pair.res,
        status: "network",
        ms: 0,
        parseOk: false,
        plausible: false,
        parsed: null,
        promptTokens: null,
        completionTokens: null,
        reasoningTokens: null,
        payloadMb,
        note: String(e).slice(0, 60),
      });
      return;
    }
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
    console.log(
      `HTTP 429 rate limited — retrying in ${
        RATE_LIMIT_BACKOFF_MS / 1000
      }s (attempt ${attempt + 2}/${RATE_LIMIT_RETRIES + 1})`,
    );
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
  }

  console.log(`HTTP ${res!.status} ${res!.statusText}  (${ms} ms)`);
  const text = await res!.text();

  if (!res!.ok) {
    const restricted = res!.status === 403 || /RestrictedModels/i.test(text);
    const limited = res!.status === 429;
    console.log(
      restricted
        ? "NOT FREE-TIER ELIGIBLE on this account (403 RestrictedModelsError)"
        : limited
        ? "RATE LIMITED even after retries"
        : `ERROR body: ${text.slice(0, 400)}`,
    );
    results.push({
      bag: pair.bag,
      res: pair.res,
      status: res!.status,
      ms,
      parseOk: false,
      plausible: false,
      parsed: null,
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      payloadMb,
      note: restricted
        ? "not free-tier eligible"
        : limited
        ? "rate limited"
        : text.slice(0, 60),
    });
    return;
  }

  let content = "";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let reasoningTokens: number | null = null;
  try {
    const envelope = JSON.parse(text);
    content = envelope.choices[0].message.content;
    const u = envelope.usage ?? {};
    promptTokens = u.prompt_tokens ?? null;
    completionTokens = u.completion_tokens ?? null;
    // Reasoning tokens are the direct evidence of whether thinking ran despite
    // `thinking: {type: "disabled"}`. The field name varies by upstream, so
    // check the known spellings, same as label-model-probe.
    reasoningTokens = u.completion_tokens_details?.reasoning_tokens ??
      u.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? null;
    console.log(
      `usage: prompt=${promptTokens ?? "?"} completion=${
        completionTokens ?? "?"
      } reasoning=${reasoningTokens ?? "n/a"}`,
    );
  } catch {
    console.log("Unexpected envelope:", text.slice(0, 400));
    results.push({
      bag: pair.bag,
      res: pair.res,
      status: res!.status,
      ms,
      parseOk: false,
      plausible: false,
      parsed: null,
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      payloadMb,
      note: "unexpected envelope",
    });
    return;
  }

  const trimmed = (content ?? "").trim();
  // The SAME bare parse parse-coffee-label relies on (no fence stripping).
  let raw: unknown = null;
  let parseOk = false;
  try {
    raw = JSON.parse(trimmed);
    parseOk = true;
  } catch { /* leaves parseOk false */ }

  // Compare what production would actually store, not the raw model output.
  const parsed = parseOk
    ? normalizeResult(raw) as Record<string, unknown>
    : null;
  const plausible = parseOk ? isPlausibleLabelResult(parsed) : false;

  console.log(`bare JSON.parse() (prod path): ${parseOk ? "YES" : "NO"}`);
  console.log(`isPlausibleLabelResult: ${plausible ? "YES" : "NO"}`);
  if (parsed) console.log(JSON.stringify(parsed, null, 2));
  else console.log(`raw content (first 400):\n${trimmed.slice(0, 400)}`);

  results.push({
    bag: pair.bag,
    res: pair.res,
    status: res!.status,
    ms,
    parseOk,
    plausible,
    parsed,
    promptTokens,
    completionTokens,
    reasoningTokens,
    payloadMb,
    note: "",
  });
}

// ---------------------------------------------------------------------------
// Run order: for each round, iterate bags, and WITHIN a bag iterate
// resolutions round-robin (640, 1200, 2000, full, repeat). This matters
// because provider latency drifts minute to minute (observed 4-11s swings on
// identical requests in label-model-probe runs) — if all six "640" calls ran
// back to back before any "2000" call, a slow or fast network window would
// land entirely on one resolution and get misread as a resolution effect.
// Round-robining interleaves every resolution through the same drift.
// ---------------------------------------------------------------------------
for (let round = 1; round <= LOOPS; round++) {
  console.log(`\n\n############ ROUND ${round} of ${LOOPS} ############`);
  for (const bag of bags) {
    const resolutions = resolutionsByBag.get(bag)!;
    for (const res of resolutions) {
      const pair = allPairs.find((p) => p.bag === bag && p.res === res)!;
      try {
        await probe(pair, round);
      } catch (e) {
        console.log(`\n=== ${bag}/${res} (round ${round}) ===\nUNEXPECTED: ${e}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
function median(ns: number[]): number {
  const a = [...ns].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// rows keyed by bag -> res -> Row[]
const byBagRes = new Map<string, Map<string, Row[]>>();
for (const r of results) {
  if (!byBagRes.has(r.bag)) byBagRes.set(r.bag, new Map());
  const byRes = byBagRes.get(r.bag)!;
  if (!byRes.has(r.res)) byRes.set(r.res, []);
  byRes.get(r.res)!.push(r);
}

// Parsed AND plausible only — an empty `{}` parses but carries no values and
// production would cascade on it, so it is a reliability event, not a data
// point about field accuracy (same reasoning as label-model-probe).
function usableRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.parseOk && r.parsed && r.plausible);
}

/** "value ×2, other ×1", most frequent first — identical to label-model-probe. */
function summariseValues(rows: Row[], field: string): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = r.parsed![field];
    const key = emptyish(v) ? "—" : JSON.stringify(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => (n > 1 ? `${v} x${n}` : v))
    .join(",  ");
}
function distinctCount(rows: Row[], field: string): number {
  return new Set(
    rows.map((r) => {
      const v = r.parsed![field];
      return emptyish(v) ? "—" : JSON.stringify(v);
    }),
  ).size;
}

// ---------------------------------------------------------------------------
// Ground truth, read off the physical bags by eye. Only the unambiguous
// fields are scored — this is not a claim that every field on every bag is
// known, just that these specific values are certain.
// ---------------------------------------------------------------------------
interface GroundTruth {
  roastDate?: string | null;
  elevation?: number | null;
  packageWeightGrams?: number | null;
  region?: string | null;
  origin?: string | null;
  variety?: string | null;
  processingMethod?: string | null;
}
const GROUND_TRUTH: Record<string, GroundTruth> = {
  ineffable: {
    roastDate: "2026-06-10",
    elevation: 2350,
    packageWeightGrams: 250,
    region: "Guji",
    origin: "Ethiopia",
    // The label's "74158" is a LOT number, not a variety — any non-null
    // variety here is a hallucination, not a near-miss.
    variety: null,
  },
  darkarts: {
    // Handwritten "15/6" on the bag.
    roastDate: "2026-06-15",
    origin: "Colombia",
    region: "Palestina",
    processingMethod: "Washed",
    elevation: null,
    packageWeightGrams: null,
    variety: null,
  },
};

function normForCompare(v: unknown): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim().toLowerCase();
  return JSON.stringify(v);
}
function valuesMatch(expected: unknown, actual: unknown): boolean {
  const e = normForCompare(expected);
  const a = normForCompare(actual);
  if (e === null) return a === null; // null expectation satisfied ONLY by null
  if (typeof e === "number") return typeof a === "number" && a === e;
  return a === e;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
for (const bag of bags) {
  console.log(`\n\n################################################`);
  console.log(`BAG: ${bag}`);
  console.log(`################################################`);
  const byRes = byBagRes.get(bag)!;
  const resolutions = resolutionsByBag.get(bag)!;

  // --- 1. LATENCY table ---------------------------------------------------
  console.log(`\n== LATENCY (${LOOPS} rounds) ==`);
  const resWidth = Math.max(10, ...resolutions.map((r) => r.length)) + 2;
  console.log(
    `${"res".padEnd(resWidth)}${"n".padStart(8)}${"min".padStart(8)}${
      "median".padStart(8)
    }${"max".padStart(8)}${"med.prompt".padStart(12)}${
      "med.compl".padStart(11)
    }${"med.MB".padStart(9)}`,
  );
  console.log("-".repeat(resWidth + 54));
  for (const res of resolutions) {
    const rows = byRes.get(res) ?? [];
    const good = usableRows(rows);
    if (good.length === 0) {
      const why = rows[0]?.note || String(rows[0]?.status ?? "?");
      console.log(
        `${res.padEnd(resWidth)}${`0/${rows.length}`.padStart(8)}   ${
          why.slice(0, 50)
        }`,
      );
      continue;
    }
    const ms = good.map((r) => r.ms);
    const promptTok = good.map((r) => r.promptTokens ?? 0).filter((n) => n > 0);
    const complTok = good.map((r) => r.completionTokens ?? 0).filter((n) =>
      n > 0
    );
    const mb = good.map((r) => r.payloadMb);
    console.log(
      `${res.padEnd(resWidth)}${`${good.length}/${rows.length}`.padStart(8)}${
        String(Math.min(...ms)).padStart(8)
      }${String(median(ms)).padStart(8)}${String(Math.max(...ms)).padStart(8)}${
        String(promptTok.length ? median(promptTok) : "?").padStart(12)
      }${String(complTok.length ? median(complTok) : "?").padStart(11)}${
        median(mb).toFixed(2).padStart(9)
      }`,
    );
  }

  // --- 2. FIELD table -------------------------------------------------------
  console.log(`\n== FIELDS ==`);
  const usableByRes = new Map<string, Row[]>();
  for (const res of resolutions) {
    const good = usableRows(byRes.get(res) ?? []);
    if (good.length) usableByRes.set(res, good);
  }
  if (usableByRes.size === 0) {
    console.log("No usable (parseable + plausible) result for this bag.");
  } else {
    const presentResolutions = resolutions.filter((r) => usableByRes.has(r));
    const width = Math.max(...presentResolutions.map((r) => r.length)) + 2;
    for (const field of FIELDS) {
      const allEmpty = presentResolutions.every((r) =>
        usableByRes.get(r)!.every((row) => emptyish(row.parsed![field]))
      );
      if (allEmpty) continue;

      const unstable = presentResolutions.some((r) =>
        distinctCount(usableByRes.get(r)!, field) > 1
      );
      const valueSets = presentResolutions.map((r) =>
        JSON.stringify(
          [...new Set(
            usableByRes.get(r)!.map((row) => {
              const v = row.parsed![field];
              return emptyish(v) ? null : JSON.stringify(v);
            }),
          )].sort(),
        )
      );
      const diverges = new Set(valueSets).size > 1;
      const flags = `${diverges ? "  [DIVERGES]" : ""}${
        unstable ? "  [UNSTABLE]" : ""
      }`;

      console.log(`\n${field}${flags}`);
      for (const r of presentResolutions) {
        console.log(
          `  ${r.padEnd(width)}${summariseValues(usableByRes.get(r)!, field)}`,
        );
      }
    }
  }

  // --- 3. ACCURACY block ------------------------------------------------
  const truth = GROUND_TRUTH[bag];
  if (truth) {
    console.log(
      `\n== ACCURACY vs. ground truth (read off the physical bag by eye) ==`,
    );
    for (const field of Object.keys(truth) as (keyof GroundTruth)[]) {
      const expected = truth[field];
      console.log(`\n${field}  (expected: ${JSON.stringify(expected)})`);
      for (const res of resolutions) {
        const good = usableByRes.get(res) ?? [];
        if (good.length === 0) {
          console.log(`  ${res.padEnd(resWidth)}no usable samples`);
          continue;
        }
        let correct = 0;
        const wrong: string[] = [];
        for (const row of good) {
          const actual = row.parsed![field as string];
          if (valuesMatch(expected, actual)) {
            correct++;
          } else if (!emptyish(actual)) {
            // A wrong NON-null value on a null-expected field is a
            // hallucination, not a rounding error — surface it explicitly.
            wrong.push(JSON.stringify(actual));
          } else {
            wrong.push("—");
          }
        }
        const wrongSummary = wrong.length
          ? `  wrong: ${[...new Set(wrong)].join(", ")}`
          : "";
        console.log(
          `  ${res.padEnd(resWidth)}${correct}/${good.length} correct${wrongSummary}`,
        );
      }
    }
  } else {
    console.log(`\n(no ground truth hardcoded for bag "${bag}" — skipping accuracy block)`);
  }

  // --- 4. FAILURES list ---------------------------------------------------
  const failures = [...byRes.values()].flat().filter((r) => !r.parseOk);
  if (failures.length) {
    console.log(`\n== FAILURES (${failures.length}) ==`);
    const seen = new Map<string, number>();
    for (const r of failures) {
      const k = `${r.res}  ${r.status}  ${r.note.slice(0, 70)}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, n] of seen) console.log(`  ${k}${n > 1 ? `  x${n}` : ""}`);
  }
}

console.log(
  `\n\nDone. ${results.length} calls across ${bags.length} bag(s), ${LOOPS} round(s).`,
);
