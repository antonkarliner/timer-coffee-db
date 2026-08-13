#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
// Phase 0 (plans/016-publish-gate-correction.md) — optional LIVE cache
// refresh for the offline replay harness (replay.ts).
//
// This is the only file in this directory that talks to the network. The
// rest of the harness (replay.ts, reconstruct.ts) only ever reads the local
// cache/captures.json file, so replay runs cost zero MCP/network calls once
// a capture is cached (plans/016 §4 Phase 0 exit criteria: "re-runnable
// offline against cached JSON").
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (see .env.example). Fetches via PostgREST against the `service` schema,
// which supabase/config.toml exposes (`schemas = [..., "service"]`) —
// service_role bypasses this table's deny-all RLS (see
// 20260812101856_parse_user_recipe_draft_captures.sql).
//
// READ-ONLY: this issues a GET against
// service.parse_user_recipe_draft_captures and nothing else. It never
// writes to that table (plans/016 §8 trap: "Captures are read-only
// evidence").
//
// USAGE
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     deno run --allow-net --allow-env --allow-read --allow-write \
//     scripts/recipe-draft-replay/fetch.ts <id> [<id> ...]
//
// Merges fetched rows into cache/captures.json (creating it if absent),
// keyed by capture id, without disturbing rows already cached for other
// ids.
//
// NOTE: this was NOT exercised against a live project during Phase 0 — no
// SUPABASE_SERVICE_ROLE_KEY was available in this sandbox. The 13 captures
// used to answer Q1-Q3 were fetched via the Supabase MCP execute_sql tool
// instead (read-only SQL, project mprokbemdullwezwwscn) and written directly
// into cache/captures.json. This script exists so a FUTURE agent — e.g. one
// verifying exit criterion 3 across ~20 captures — doesn't have to hand-copy
// MCP query output again. Treat it as untested until first real use, and
// verify its output against a known capture (e.g. one already in the cache)
// before trusting it for new ones.

import type { CaptureRow } from "./reconstruct.ts";

const CACHE_PATH = new URL("./cache/captures.json", import.meta.url).pathname;

async function loadExistingCache(): Promise<Record<string, CaptureRow>> {
  try {
    const text = await Deno.readTextFile(CACHE_PATH);
    return JSON.parse(text) as Record<string, CaptureRow>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
}

async function fetchCapture(
  baseUrl: string,
  serviceRoleKey: string,
  id: string,
): Promise<CaptureRow | null> {
  const url = new URL("/rest/v1/parse_user_recipe_draft_captures", baseUrl);
  url.searchParams.set(
    "select",
    "id,request_mode,request_text,request_brewing_method_id,request_source_language_hint,stage_outputs,response",
  );
  url.searchParams.set("id", `eq.${id}`);

  const res = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Accept-Profile": "service",
    },
  });

  if (!res.ok) {
    console.error(
      `!! fetch failed for ${id}: ${res.status} ${res.statusText} — ${await res
        .text()}`,
    );
    return null;
  }

  const rows = await res.json() as Array<{
    id: string;
    request_mode: string;
    request_text: string;
    request_brewing_method_id: string | null;
    request_source_language_hint: string | null;
    stage_outputs: unknown;
    response: CaptureRow["response"];
  }>;

  if (rows.length === 0) {
    console.error(`!! no row found for capture id ${id}`);
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    request_mode: row.request_mode,
    request_text: row.request_text,
    request_brewing_method_id: row.request_brewing_method_id,
    request_source_language_hint: row.request_source_language_hint,
    response: row.response,
    // Full stage_outputs, untrimmed (every attempt's full `.parsed` object,
    // not just `extracted_amounts` — required since the Phase G fidelity
    // fix for gate-reconstruct.ts to work at all; see reconstruct.ts's
    // StageAttempt doc comment). The MCP-fetched cache entries store a
    // PROJECTION of this same field (per stage: {attempt, provider, model,
    // error, parsed}) to keep the checked-in cache file smaller; a live
    // fetch has no such size pressure, so it stores the field whole. Both
    // shapes satisfy CaptureRow["stage_outputs"].
    // deno-lint-ignore no-explicit-any
    stage_outputs: row.stage_outputs as any,
  };
}

async function main() {
  const ids = Deno.args.filter((arg) => !arg.startsWith("--"));
  if (ids.length === 0) {
    console.error("Usage: fetch.ts <capture-id> [<capture-id> ...]");
    Deno.exit(1);
  }

  const baseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    console.error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example). " +
        "Alternatively, fetch rows via the Supabase MCP execute_sql tool and merge " +
        "them into cache/captures.json by hand — that is how Phase 0's own 13 " +
        "captures were cached.",
    );
    Deno.exit(1);
  }

  const cache = await loadExistingCache();
  let fetched = 0;
  for (const id of ids) {
    const row = await fetchCapture(baseUrl, serviceRoleKey, id);
    if (row) {
      cache[id] = row;
      fetched += 1;
      console.log(`fetched ${id}`);
    }
  }

  await Deno.writeTextFile(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`wrote ${fetched} row(s) to ${CACHE_PATH}`);
}

if (import.meta.main) {
  await main();
}
