/**
 * Coffee-label model probe — compare candidate vision models across providers
 * using the EXACT request shape parse-coffee-label sends, without touching
 * prod. Both the Vercel AI Gateway and Groq expose OpenAI-compatible chat
 * completions, so one script can put them side by side on the same images.
 *
 * Usage:
 *   AI_GATEWAY_API_KEY=... GROQ_API_KEY=... Z_AI_API_KEY=... deno run \
 *     --allow-env --allow-net \
 *     --allow-read scripts/label-model-probe.ts <front.jpg> [back.jpg] [--locale=en]
 *
 * A provider whose key is absent is skipped rather than failing the run.
 *
 * Pass BOTH bag faces. parse-coffee-label sends up to two images
 * (imagesBase64.slice(0, 2)) and every production scan so far has sent two;
 * a one-image run understates latency and usually misses the roast date,
 * which is typically printed on the back.
 *
 * Output has three parts:
 *   1. Per-variant result as it streams (status, latency, token usage, JSON).
 *   2. FIELD COMPARISON — every extracted field, value by value, with
 *      disagreements first. A high field count means nothing if the values are
 *      invented, so this is what decides which model is actually right.
 *   3. Latency + usage summary, fastest first.
 *
 * 403 = not free-tier eligible. 429 = per-model rate limit; retried with
 * backoff so a limit is not misread as a model failure.
 *
 * It does NOT print your API keys.
 */
import {
  buildSystemPrompt,
  isPlausibleLabelResult,
  LABEL_RESPONSE_SCHEMA,
  normalizeResult,
} from "../supabase/functions/parse-coffee-label/label-utils.ts";
import { VERCEL_GATEWAY_BASE_URL } from "../supabase/functions/_shared/ai-models.ts";

// Candidates: vision-capable, modern, and cheap enough that the $5/month free
// credit covers ~650 label parses/month. Prices per 1M input/output tokens and
// release dates from the gateway catalog (read 2026-08-21).
//
// Deliberately excluded after the first probe run:
//   google/gemini-3.5-flash-lite, google/gemini-3.1-flash-lite — 403, not
//     free-tier eligible on this account.
//   openai/gpt-4.1-nano — works, but a 2025 model; superseded by gpt-5.x nano.
//   amazon/nova-lite — 2024 model, never got past a 429 to prove itself.
interface Provider {
  url: string;
  key: string | undefined;
  /** Groq uses OpenAI's newer name; the gateway catalog advertises max_tokens. */
  tokenParam: "max_tokens" | "max_completion_tokens";
  /**
   * Minimum ms between calls to THIS provider. Groq's on_demand tier caps at
   * 8,000 tokens/minute and two label images alone cost ~4,100 prompt tokens,
   * so barely one request per ~35s fits. The gateway free tier limits by
   * request rate instead.
   */
  minSpacingMs: number;
}
const PROVIDERS: Record<string, Provider> = {
  vercel: {
    url: `${VERCEL_GATEWAY_BASE_URL}/chat/completions`,
    key: Deno.env.get("AI_GATEWAY_API_KEY"),
    tokenParam: "max_tokens",
    // 6s was not enough: a 5-round, 3-gateway-variant run lost 8 of 15 calls
    // to 429 even with the retry, leaving 1-2 usable samples per variant —
    // too few to say anything about a model. The free tier limits by request
    // rate across the whole account, so every gateway variant you add eats the
    // same budget.
    minSpacingMs: 20000,
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: Deno.env.get("GROQ_API_KEY"),
    tokenParam: "max_completion_tokens",
    minSpacingMs: 35000,
  },
  // Z.AI's own OpenAI-compatible endpoint. NOTE the /api/coding/ path: the
  // plain /api/paas/v4 endpoint answers 429 "insufficient balance" on this
  // account, because the key is a coding-plan key. That plan's terms are for
  // coding tools, so this is a measurement channel only — shipping label
  // parsing here would need a pay-as-you-go key (or the gateway, if it ever
  // lists GLM).
  zai: {
    url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    key: Deno.env.get("Z_AI_API_KEY"),
    tokenParam: "max_tokens",
    minSpacingMs: 3000,
  },
};

// Variants: [label, provider, model, extra body params].
//
// The point of this list is a CONTROLLED comparison: same images, same prompt,
// same schema, so differences are attributable to the model/config rather than
// to which bag happened to be scanned.
//
// Qwen-family models are reasoning models. With reasoning off they are fast but
// misread roast dates and invent fields; with it on they read dates correctly
// but spend ~1,200 thinking tokens. On Groq's hardware those tokens are far
// cheaper in wall-clock than on the gateway, which is what the groq
// reasoning-on variants below are testing. Note reasoning_format:"hidden"
// keeps the thinking out of `content` (without it, json_object enforcement
// fails with 400 json_validate_failed) but does NOT stop the tokens being
// generated — hence the raised completion budget.
const MODELS: [string, string, string, Record<string, unknown>, string?][] = [
  // Reference: what production runs today.
  ["vercel gemma (PROD)", "vercel", "google/gemma-4-31b-it", {}],
  // GLM-5.3-flash think:off across the three prompt variants above — same
  // model/config, only the translate-instruction placement changes, to see
  // whether prompt placement (not model choice) is what fixes non-English
  // field leakage.
  ["glm think:off prompt:prod", "zai", "glm-5.3-flash", {
    thinking: { type: "disabled" },
  }, "prod"],
  ["glm think:off prompt:tail", "zai", "glm-5.3-flash", {
    thinking: { type: "disabled" },
  }, "tail"],
  ["glm think:off prompt:user", "zai", "glm-5.3-flash", {
    thinking: { type: "disabled" },
  }, "user"],
  // The SAME model served through the Vercel gateway instead of Z.AI direct.
  // The gateway does not route this to Z.AI: it resolves to baseten (with
  // fireworks/runware/togetherai/zai and a dozen others as fallbacks), so the
  // upstream can differ call to call — hence resolvedProvider is logged per
  // request below. Two configs because the gateway silently DROPS Z.AI's
  // `thinking: {type:"disabled"}` (verified: reasoning text still came back);
  // `reasoning_effort: "none"` is the lever that reaches this upstream.
  ["gw glm default", "vercel", "zai/glm-5.3-flash", {}, "prod"],
  ["gw glm reasoning:none", "vercel", "zai/glm-5.3-flash", {
    reasoning_effort: "none",
  }, "prod"],
  // NOTE: a `reasoning_format: "hidden"` variant was tested here across two
  // separate 3-round runs and failed 6/6 with 400 json_validate_failed, on top
  // of Groq's 8,000 TPM ceiling making the budget marginal. Reasoning-on Groq
  // is not viable with json_object enforcement; removed rather than re-run,
  // since each attempt costs ~35s of TPM pacing.
];

// Each variant runs LOOPS times. One sample cannot distinguish a model that is
// right from one that got lucky: latency on the same model/images has varied
// 4.1s-10.8s across runs, and field values have varied too (gemma returned
// variety=null one run and a lot number the next). Repeats expose that.
const loopsArg = Deno.args.find((a) => a.startsWith("--loops="));
const LOOPS = loopsArg ? Number(loopsArg.slice("--loops=".length)) : 3;

// Per-request timeout. The slowest legitimate response observed was ~16s
// (qwen with reasoning on); 60s leaves headroom without hanging the run.
const REQUEST_TIMEOUT_MS = 60000;

// Free-tier accounts are rate limited per model. Pace calls, and retry a 429
// rather than writing the model off.
const DELAY_MS = 6000;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 20000;

if (!Object.values(PROVIDERS).some((p) => p.key)) {
  console.error(
    "No provider key set. Export AI_GATEWAY_API_KEY, GROQ_API_KEY and/or Z_AI_API_KEY\n" +
      "(or put them in .env.local and pass --env-file=.env.local).",
  );
  Deno.exit(1);
}
for (const [name, p] of Object.entries(PROVIDERS)) {
  if (!p.key) console.warn(`No key for "${name}" — its variants will be skipped.`);
}

const localeArg = Deno.args.find((a) => a.startsWith("--locale="));
const locale = localeArg ? localeArg.slice("--locale=".length) : "en";
const imageArgs = Deno.args.filter((a) => !a.startsWith("--"));
if (imageArgs.length === 0) {
  console.error(
    "Provide one or two coffee-label image paths or https URLs (front and back).",
  );
  Deno.exit(1);
}
// Mirror production: parse-coffee-label sends at most two images.
const PROD_MAX_IMAGES = 2;
if (imageArgs.length > PROD_MAX_IMAGES) {
  console.warn(
    `Only the first ${PROD_MAX_IMAGES} images are sent — parse-coffee-label slices to ${PROD_MAX_IMAGES}.`,
  );
}
const selectedImages = imageArgs.slice(0, PROD_MAX_IMAGES);
if (selectedImages.length === 1) {
  console.warn(
    "WARNING: only one image given. Production sends two; the roast date is\n" +
      "usually on the back, so roastDate results here will not be representative.",
  );
}

// Build the same data:image/...;base64 URL the function sends.
async function toImageUrl(arg: string): Promise<string> {
  if (/^https?:\/\//.test(arg)) return arg;
  const bytes = await Deno.readFile(arg);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const ext = arg.split(".").pop()?.toLowerCase();
  const mime = ext === "png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

// Reuse the production prompt builder so this probe cannot drift from what
// parse-coffee-label actually sends.
const systemPrompt = buildSystemPrompt({
  locale,
  today: new Date().toISOString().slice(0, 10),
  ocrText: "",
});

// Prompt variants: each is a DELTA on top of the production prompt/user text,
// never a rewritten copy — the whole point is that this probe cannot drift
// from what parse-coffee-label actually sends. The production prompt already
// carries three separate translate instructions, so these variants test
// PLACEMENT and RECENCY of the instruction (a system-tail reminder right
// before the model answers vs. moving it into the last user turn) rather than
// whether the instruction exists at all.
interface PromptVariant {
  /** Appended to the production system prompt, or "" for production as-is. */
  systemSuffix: string;
  /** The text part of the user message. */
  userText: string;
}
const PROMPT_VARIANTS: Record<string, PromptVariant> = {
  prod: { systemSuffix: "", userText: `locale = ${locale}` },
  tail: {
    systemSuffix:
      `\n\nBefore you answer, re-read every value you are about to output. If name, origin, processingMethod, region, roastLevel or tastingNotes is still written in the label's own language, translate it into ${locale} now. Those fields must contain no words left in the label's language.`,
    userText: `locale = ${locale}`,
  },
  user: {
    systemSuffix: "",
    userText:
      `locale = ${locale}\nOutput name, origin, processingMethod, region, roastLevel and tastingNotes in ${locale}, translated from whatever language the label uses.`,
  },
};

for (const entry of MODELS) {
  const variantKey = entry[4] ?? "prod";
  if (!(variantKey in PROMPT_VARIANTS)) {
    console.error(
      `MODELS entry "${entry[0]}" names unknown prompt variant "${variantKey}". ` +
        `Known variants: ${Object.keys(PROMPT_VARIANTS).join(", ")}`,
    );
    Deno.exit(1);
  }
}

const imageUrls = await Promise.all(selectedImages.map(toImageUrl));
const payloadMb = imageUrls.reduce((n, u) => n + u.length, 0) / 1024 / 1024;
console.log(
  `Probing ${
    MODELS.filter(([, prov]) => PROVIDERS[prov].key).length
  } variants with ${imageUrls.length} image(s), locale=${locale}.`,
);
console.log(
  `Encoded image payload: ${payloadMb.toFixed(1)} MB — uploaded once per model.\n` +
    `Latency includes your upload, but measurement showed payload size is NOT the\n` +
    `dominant factor: a 10x smaller payload moved one model by ~1s and the other\n` +
    `not at all. Absolute numbers still run higher than production (different\n` +
    `network path), so compare variants against each other, not against the logs.`,
);

// Field list, taken from the production response schema so it cannot drift.
// `error` is the error-envelope field, not a label field — exclude it.
const FIELDS = Object.keys(
  (LABEL_RESPONSE_SCHEMA.openai as { properties: Record<string, unknown> })
    .properties,
).filter((f) => f !== "error");

interface Row {
  label: string;
  status: number | string;
  ms: number;
  parseOk: boolean;
  plausible: boolean;
  populated: number | null;
  parsed: Record<string, unknown> | null;
  usage: string;
  note: string;
}
const results: Row[] = [];

function emptyish(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

async function callModel(
  provider: Provider,
  model: string,
  extra: Record<string, unknown>,
  variant: PromptVariant,
): Promise<{ res: Response; ms: number }> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt + variant.systemSuffix },
      {
        role: "user",
        content: [
          { type: "text", text: variant.userText },
          ...imageUrls.map((url) => ({
            type: "image_url",
            image_url: { url },
          })),
        ],
      },
    ],
    temperature: 1,
    top_p: 0.95,
    stream: false,
    response_format: { type: "json_object" },
    // Production caps completions at 1024; variants may override via `extra`.
    [provider.tokenParam]: 1024,
    ...extra,
  };
  await respectSpacing(provider);
  const started = Date.now();
  const timer = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: timer,
    });
    return { res, ms: Date.now() - started };
  } finally {
    lastCallAt.set(provider.url, Date.now());
  }
}

const lastCallAt = new Map<string, number>();

/** Wait out this provider's minimum inter-request spacing (rate/TPM limits). */
async function respectSpacing(provider: Provider): Promise<void> {
  const last = lastCallAt.get(provider.url);
  if (last === undefined) return;
  const wait = provider.minSpacingMs - (Date.now() - last);
  if (wait > 0) {
    console.log(`  …pacing ${(wait / 1000).toFixed(0)}s for provider limits…`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function probe(
  label: string,
  providerName: string,
  model: string,
  extra: Record<string, unknown>,
  round: number,
  variant: PromptVariant,
): Promise<void> {
  const provider = PROVIDERS[providerName];
  console.log(`\n========================================`);
  console.log(`MODEL: ${label}   [round ${round}/${LOOPS}]`);

  let res: Response;
  let ms = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ res, ms } = await callModel(provider, model, extra, variant));
    } catch (e) {
      console.log(`NETWORK ERROR: ${e}`);
      results.push({
        label,
        status: "network",
        ms: 0,
        parseOk: false,
        plausible: false,
        populated: null,
        parsed: null,
        usage: "",
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
        ? "RATE LIMITED even after retries — free-tier limit for this model"
        : `ERROR body: ${text.slice(0, 400)}`,
    );
    results.push({
      label,
      status: res!.status,
      ms,
      parseOk: false,
      plausible: false,
      populated: null,
      parsed: null,
      usage: "",
      note: restricted
        ? "not free-tier eligible"
        : limited
        ? "rate limited"
        : text.slice(0, 60),
    });
    return;
  }

  let content = "";
  let usage = "";
  try {
    const envelope = JSON.parse(text);
    content = envelope.choices[0].message.content;
    const u = envelope.usage ?? {};
    // Reasoning tokens are the direct evidence of whether thinking ran. The
    // field name varies by upstream provider, so check the known spellings.
    const reasoningTokens = u.completion_tokens_details?.reasoning_tokens ??
      u.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? null;
    // Which upstream the gateway actually chose. A gateway model id is not one
    // vendor's endpoint — latency belongs to whoever it resolved to that call.
    const routedTo = envelope.choices?.[0]?.message?.provider_metadata?.gateway
      ?.routing?.resolvedProvider ?? null;
    usage = `prompt=${u.prompt_tokens ?? "?"} completion=${
      u.completion_tokens ?? "?"
    } reasoning=${reasoningTokens ?? "n/a"}${
      routedTo ? ` via=${routedTo}` : ""
    }`;
    console.log(`usage: ${usage}`);
  } catch {
    console.log("Unexpected envelope:", text.slice(0, 400));
    results.push({
      label,
      status: res!.status,
      ms,
      parseOk: false,
      plausible: false,
      populated: null,
      parsed: null,
      usage: "",
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
  const populated = parsed
    ? Object.values(parsed).filter((v) => !emptyish(v)).length
    : null;

  console.log(`bare JSON.parse() (prod path): ${parseOk ? "YES" : "NO"}`);
  console.log(`isPlausibleLabelResult: ${plausible ? "YES" : "NO"}`);
  console.log(`populated fields: ${populated}`);
  if (parsed) console.log(JSON.stringify(parsed, null, 2));
  else console.log(`raw content (first 400):\n${trimmed.slice(0, 400)}`);

  results.push({
    label,
    status: res!.status,
    ms,
    parseOk,
    plausible,
    populated,
    parsed,
    usage,
    note: "",
  });
}

// --only=<substring> narrows the run to matching variant labels. The gateway
// free tier limits by request rate across the ACCOUNT, so every variant in a
// run competes for the same budget; isolating one variant is how you get
// enough usable samples to say anything about it.
const onlyArg = Deno.args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : null;
const RUNNABLE = MODELS.filter(([label, prov]) =>
  PROVIDERS[prov].key && (!only || label.includes(only))
);
if (RUNNABLE.length === 0) {
  console.error(`--only=${only} matched no variant with an available key.`);
  Deno.exit(1);
}
// Round-robin rather than all repeats of one variant back to back: provider
// latency drifts minute to minute, and interleaving stops any single variant
// from owning a fast or slow window.
for (let round = 1; round <= LOOPS; round++) {
  console.log(`\n\n############ ROUND ${round} of ${LOOPS} ############`);
  for (const [label, prov, model, extra, variantKey] of RUNNABLE) {
    const variant = PROMPT_VARIANTS[variantKey ?? "prod"];
    try {
      await probe(`${label}`, prov, model, extra, round, variant);
    } catch (e) {
      console.log(`\n=== ${label} (round ${round}) ===\nUNEXPECTED: ${e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation across rounds
// ---------------------------------------------------------------------------
const byLabel = new Map<string, Row[]>();
for (const r of results) {
  if (!byLabel.has(r.label)) byLabel.set(r.label, []);
  byLabel.get(r.label)!.push(r);
}
// Parsed AND plausible. An empty `{}` parses fine but carries no values; in
// production isPlausibleLabelResult rejects it and the chain cascades, so it
// is a reliability event, not a data point about field accuracy. Counting it
// as a "—" per field previously flagged nearly every field UNSTABLE.
const okByLabel = new Map<string, Row[]>();
for (const [label, rows] of byLabel) {
  const good = rows.filter((r) => r.parseOk && r.parsed && r.plausible);
  if (good.length) okByLabel.set(label, good);
}

/** "value ×2, other ×1", most frequent first. */
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
function median(ns: number[]): number {
  const a = [...ns].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

console.log(`\n\n================ FIELD COMPARISON (${LOOPS} rounds) ================`);
if (okByLabel.size === 0) {
  console.log("No variant returned parseable JSON.");
} else {
  const labels = [...okByLabel.keys()];
  const width = Math.max(...labels.map((l) => l.length)) + 2;

  const rank: { field: string; flags: string }[] = [];
  for (const field of FIELDS) {
    const allEmpty = labels.every((l) =>
      okByLabel.get(l)!.every((r) => emptyish(r.parsed![field]))
    );
    if (allEmpty) continue;
    const unstable = labels.some((l) => distinctCount(okByLabel.get(l)!, field) > 1);
    // Compare the SET of values each variant produced, not the formatted
    // "value x2" summary — otherwise a differing round count alone reads as
    // disagreement even when every variant returned the same value.
    const valueSets = labels.map((l) =>
      JSON.stringify(
        [...new Set(
          okByLabel.get(l)!.map((r) => {
            const v = r.parsed![field];
            return emptyish(v) ? null : JSON.stringify(v);
          }),
        )].sort(),
      )
    );
    const disagree = new Set(valueSets).size > 1;
    if (!unstable && !disagree) {
      rank.push({ field, flags: "" });
    } else {
      rank.push({
        field,
        flags: `${disagree ? "  [DISAGREEMENT]" : ""}${
          unstable ? "  [UNSTABLE ACROSS ROUNDS]" : ""
        }`,
      });
    }
  }
  // Flagged fields first — those are the ones worth checking against the bag.
  rank.sort((a, b) => (b.flags ? 1 : 0) - (a.flags ? 1 : 0));

  for (const { field, flags } of rank) {
    console.log(`\n${field}${flags}`);
    for (const l of labels) {
      console.log(`  ${l.padEnd(width)}${summariseValues(okByLabel.get(l)!, field)}`);
    }
  }
  console.log(
    `\n\nUNSTABLE means the SAME variant gave different answers across rounds —` +
      `\nthat is a reliability problem regardless of which answer is right.` +
      `\nMore populated fields is not better if the extra values are invented.`,
  );
}

console.log(`\n\n================ RELIABILITY ================`);
for (const [label, rows] of byLabel) {
  const usable = rows.filter((r) => r.parseOk && r.parsed && r.plausible).length;
  const empty = rows.filter((r) => r.parseOk && r.parsed && !r.plausible).length;
  const failed = rows.filter((r) => !r.parseOk).length;
  const notes = [
    empty ? `${empty} empty/implausible (production would cascade)` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean).join(", ");
  console.log(
    `  ${label.padEnd(36)}${usable}/${rows.length} usable${
      notes ? `   — ${notes}` : ""
    }`,
  );
}

console.log(`\n\n================ LATENCY & USAGE ================`);
const labelWidth = Math.max(20, ...[...byLabel.keys()].map((l) => l.length)) + 2;
console.log(
  `${"variant".padEnd(labelWidth)}${"ok".padStart(5)}${"min".padStart(8)}${
    "med".padStart(8)
  }${"max".padStart(8)}   usage (last ok run)`,
);
console.log("-".repeat(labelWidth + 40));
const ordered = [...byLabel.keys()].sort((a, b) => {
  const ra = okByLabel.get(a), rb = okByLabel.get(b);
  if (!ra) return 1;
  if (!rb) return -1;
  return median(ra.map((r) => r.ms)) - median(rb.map((r) => r.ms));
});
for (const label of ordered) {
  const rows = byLabel.get(label)!;
  const good = okByLabel.get(label) ?? [];
  if (good.length === 0) {
    const why = rows[0]?.note || String(rows[0]?.status ?? "?");
    console.log(
      `${label.padEnd(labelWidth)}${`0/${rows.length}`.padStart(5)}${
        "".padStart(24)
      }   ${why.slice(0, 60)}`,
    );
    continue;
  }
  const ms = good.map((r) => r.ms);
  console.log(
    `${label.padEnd(labelWidth)}${`${good.length}/${rows.length}`.padStart(5)}${
      String(Math.min(...ms)).padStart(8)
    }${String(median(ms)).padStart(8)}${String(Math.max(...ms)).padStart(8)}   ${
      good[good.length - 1].usage
    }`,
  );
}

const failures = results.filter((r) => !r.parseOk);
if (failures.length) {
  console.log(`\nFailed calls (${failures.length}/${results.length}):`);
  const seen = new Map<string, number>();
  for (const r of failures) {
    const k = `${r.label}  ${r.status}  ${r.note.slice(0, 70)}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) console.log(`  ${k}${n > 1 ? `  x${n}` : ""}`);
}
