// Normalizes free-text bean origins into canonical ISO 3166-1 alpha-2 country
// codes and caches the result in public.bean_origin_normalizations, keyed on the
// normalized origin string. Origins are entered by users in many languages and
// spellings ("Эфиопия", "エチオピア", "Brasil"), as blends ("Kenya/Brazil"), or
// as non-country values ("Blend", "Arabica", "Unknown"); an LLM is the most
// reliable way to collapse all of that to ISO codes.
//
// Each distinct origin string is paid for at most once: callers pass raw origin
// strings, already-cached keys are skipped, and only the misses hit OpenAI.
//
// Request (explicit): { "origins": ["Ethiopia", "Кения", "Kenya/Brazil", "Blend"] }
// Request (backfill/cron): { "backfill": true, "limit": 200 } — the function pulls
//   up to `limit` distinct, not-yet-cached origins itself (via the service role),
//   so callers need no service key and no origin list. `more` in the response is
//   true when the limit was hit and another pass is likely needed.
// Response: { "results": [{ "origin", "origin_key", "country_codes" }], "more": bool }

import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import OpenAI from "https://esm.sh/openai";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { OPENAI_MODELS } from "../_shared/ai-models.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const openaiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL") ?? "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}
if (!openaiApiKey) {
  throw new Error("OPENAI_API_KEY_NON_PERSONAL is required.");
}

const MODEL = OPENAI_MODELS.MEDIUM;
const MAX_PER_LLM_CALL = 40;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});

const openai = new OpenAI({ apiKey: openaiApiKey });

// Must match public.normalize_origin_key(text) in SQL exactly.
function normalizeOriginKey(origin: string): string {
  return origin.replace(/\s+/g, " ").trim().toLowerCase();
}

const ISO_ALPHA2 = /^[A-Z]{2}$/;

function sanitizeCodes(codes: unknown): string[] {
  if (!Array.isArray(codes)) return [];
  const seen = new Set<string>();
  for (const raw of codes) {
    if (typeof raw !== "string") continue;
    const code = raw.trim().toUpperCase();
    if (ISO_ALPHA2.test(code)) seen.add(code);
  }
  return [...seen];
}

const SYSTEM_PROMPT =
  `You normalize coffee bean "origin" strings into ISO 3166-1 alpha-2 country codes. ` +
  `Input is a JSON array of strings; each may be in ANY language, misspelled, a blend ` +
  `of multiple countries (e.g. "Kenya/Brazil", "Колумбия + Эфиопия"), or not a country ` +
  `at all (e.g. "Blend", "Arabica", "Single Origin", "Unknown", "-"). ` +
  `For each input string return its country codes as an array of UPPERCASE ISO 3166-1 ` +
  `alpha-2 codes: one element for a single country, multiple for a blend, and an EMPTY ` +
  `array when no real country can be identified. Map region/farm/city names to their ` +
  `country (e.g. "Yirgacheffe" -> ["ET"], "Huila" -> ["CO"]). Do not invent countries. ` +
  `Respond with JSON {"results":[{"i":<input index>,"codes":["XX",...]}, ...]} covering ` +
  `every input index exactly once.`;

async function classify(origins: string[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const completion = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "none",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(origins) },
    ],
  });
  const content = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as {
    results?: Array<{ i?: number; codes?: unknown }>;
  };
  for (const row of parsed.results ?? []) {
    if (typeof row?.i !== "number") continue;
    out.set(row.i, sanitizeCodes(row.codes));
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

serve(async (req) => {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }

  let body: { origins?: string[]; backfill?: boolean; limit?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const isBackfill = body.backfill === true;
  const backfillLimit =
    typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 500) : 200;

  let rawOrigins: string[];
  if (isBackfill) {
    const { data, error } = await supabase.rpc("get_unnormalized_bean_origins", {
      p_limit: backfillLimit,
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 503,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    rawOrigins = (data as string[] | null) ?? [];
  } else {
    rawOrigins = Array.isArray(body.origins) ? body.origins : [];
  }
  // Collapse to distinct keys, keeping one raw sample per key.
  const byKey = new Map<string, string>();
  for (const raw of rawOrigins) {
    if (typeof raw !== "string") continue;
    const key = normalizeOriginKey(raw);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, raw.trim());
  }
  const keys = [...byKey.keys()];
  if (keys.length === 0) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Skip keys already cached. In backfill mode the RPC already returns only
  // un-cached keys, so we skip this pre-check entirely — it would otherwise issue
  // a PostgREST `in.(...)` GET whose URL overflows once there are many (often
  // multibyte) keys.
  const cached = new Map<string, string[]>();
  if (!isBackfill) {
    const { data: existing, error: existingErr } = await supabase
      .from("bean_origin_normalizations")
      .select("origin_key, country_codes")
      .in("origin_key", keys);
    if (existingErr) {
      return new Response(JSON.stringify({ error: existingErr.message }), {
        status: 503,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    for (const r of existing ?? []) {
      cached.set(r.origin_key as string, (r.country_codes as string[]) ?? []);
    }
  }
  const missingKeys = keys.filter((k) => !cached.has(k));

  // Classify the misses (the cache key is normalized; send a readable sample).
  const resolved = new Map<string, string[]>();
  for (const group of chunk(missingKeys, MAX_PER_LLM_CALL)) {
    const samples = group.map((k) => byKey.get(k) ?? k);
    let classified: Map<number, string[]>;
    try {
      classified = await classify(samples);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 503, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    group.forEach((key, idx) => {
      resolved.set(key, classified.get(idx) ?? []);
    });
  }

  if (resolved.size > 0) {
    const now = new Date().toISOString();
    const rows = [...resolved.entries()].map(([origin_key, country_codes]) => ({
      origin_key,
      raw_sample: byKey.get(origin_key) ?? origin_key,
      country_codes,
      model: MODEL,
      updated_at: now,
    }));
    const { error: upsertErr } = await supabase
      .from("bean_origin_normalizations")
      .upsert(rows, { onConflict: "origin_key" });
    if (upsertErr) {
      return new Response(JSON.stringify({ error: upsertErr.message }), {
        status: 503,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  const results = keys.map((origin_key) => ({
    origin: byKey.get(origin_key) ?? origin_key,
    origin_key,
    country_codes: cached.get(origin_key) ?? resolved.get(origin_key) ?? [],
  }));

  // In backfill mode, signal whether another pass is likely needed (we fetched a
  // full page of un-cached origins).
  const more = isBackfill && rawOrigins.length >= backfillLimit;

  return new Response(JSON.stringify({ results, more }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
