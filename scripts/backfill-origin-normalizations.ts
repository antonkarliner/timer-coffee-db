/**
 * Backfills public.bean_origin_normalizations for every distinct, not-yet-cached
 * bean origin in public.user_coffee_beans. Delegates the actual free-text ->
 * ISO-code classification to the normalize-bean-origins edge function so there
 * is a single classification code path (the function caches each distinct key,
 * so re-runs are cheap and idempotent).
 *
 * Run:
 *   SUPABASE_SERVICE_ROLE_KEY=<key> deno run \
 *     --allow-net --allow-env \
 *     scripts/backfill-origin-normalizations.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";

const SUPABASE_URL = "https://mprokbemdullwezwwscn.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BATCH = 40;

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY env var is required");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, detectSessionInUrl: false },
});

function normalizeOriginKey(origin: string): string {
  return origin.replace(/\s+/g, " ").trim().toLowerCase();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// Distinct non-empty origins (one readable sample per normalized key).
const byKey = new Map<string, string>();
const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from("user_coffee_beans")
    .select("origin")
    .not("origin", "is", null)
    .range(from, from + PAGE - 1);
  if (error) {
    console.error("Failed to read user_coffee_beans:", error.message);
    Deno.exit(1);
  }
  if (!data || data.length === 0) break;
  for (const row of data) {
    const raw = typeof row.origin === "string" ? row.origin : "";
    const key = normalizeOriginKey(raw);
    if (key && !byKey.has(key)) byKey.set(key, raw.trim());
  }
  if (data.length < PAGE) break;
}

// Drop keys already cached.
const allKeys = [...byKey.keys()];
const cachedKeys = new Set<string>();
for (const group of chunk(allKeys, 500)) {
  const { data, error } = await supabase
    .from("bean_origin_normalizations")
    .select("origin_key")
    .in("origin_key", group);
  if (error) {
    console.error("Failed to read cache:", error.message);
    Deno.exit(1);
  }
  for (const row of data ?? []) cachedKeys.add(row.origin_key as string);
}

const todo = allKeys.filter((k) => !cachedKeys.has(k));
console.log(
  `Distinct origins: ${allKeys.length}, already cached: ${cachedKeys.size}, to classify: ${todo.length}`,
);

let done = 0;
for (const group of chunk(todo, BATCH)) {
  const origins = group.map((k) => byKey.get(k) ?? k);
  const { error } = await supabase.functions.invoke("normalize-bean-origins", {
    body: { origins },
  });
  if (error) {
    console.error("normalize-bean-origins failed:", error.message);
    Deno.exit(1);
  }
  done += group.length;
  console.log(`Classified ${done}/${todo.length}`);
}

console.log("Done.");
