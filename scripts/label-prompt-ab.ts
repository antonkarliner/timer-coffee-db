/**
 * A/B two versions of the parse-coffee-label prompt on real saved bag photos,
 * same model and request shape as production, before shipping a prompt change.
 *
 * Built for plan 034 (the `roasterBrandName` field), but general: point
 * --old at any previous copy of label-utils.ts.
 *
 * Why each prompt runs TWICE per photo: production samples at temperature 1,
 * so a prompt disagrees with ITSELF between runs. Comparing one old run with
 * one new run would count that noise as regressions. The report therefore
 * sets the old-vs-new disagreement rate for every field beside the
 * old-vs-old and new-vs-new rates. A field only regressed if cross-prompt
 * disagreement clearly exceeds within-prompt disagreement.
 *
 * Read-only against production: downloads photos from the `bean-photos`
 * bucket with the service key, writes nothing back. Sends the photos to the
 * same provider production already sends scans to.
 *
 * Usage:
 *   git show HEAD:supabase/functions/parse-coffee-label/label-utils.ts > /tmp/old.ts
 *   deno run --allow-net --allow-env --allow-read --env-file=supabase/.env.local \
 *     --no-lock scripts/label-prompt-ab.ts --old=/tmp/old.ts [--n=20] [--locale=en]
 */
import * as NEW from "../supabase/functions/parse-coffee-label/label-utils.ts";
import { ZAI_BASE_URL, ZAI_DEFAULT_MODEL } from "../supabase/functions/_shared/ai-models.ts";

const arg = (k: string, d: string) =>
  Deno.args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OLD_PATH = arg("old", "");
const N = Number(arg("n", "20"));
const LOCALE = arg("locale", "en");
const SPACING_MS = 3000;

const ZAI_KEY = Deno.env.get("Z_AI_API_KEY");
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!OLD_PATH || !ZAI_KEY || !SB_URL || !SB_KEY) {
  console.error("need --old=<path>, Z_AI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}
const OLD = await import(new URL(`file://${OLD_PATH}`).href);
const today = new Date().toISOString().slice(0, 10);
const PROMPTS = {
  old: OLD.buildSystemPrompt({ locale: LOCALE, today, ocrText: null }) as string,
  new: NEW.buildSystemPrompt({ locale: LOCALE, today, ocrText: null }) as string,
};
console.log(`prompt chars: old=${PROMPTS.old.length} new=${PROMPTS.new.length}`);

// ---- sample: newest photo from each of N distinct users, for variety -------
const listRes = await fetch(`${SB_URL}/storage/v1/object/list/bean-photos`, {
  method: "POST",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prefix: "", limit: 1000 }),
});
const folders = (await listRes.json() as { name: string; id: string | null }[])
  .filter((f) => f.id === null).map((f) => f.name);
const photos: string[] = [];
for (const folder of folders) {
  if (photos.length >= N) break;
  const r = await fetch(`${SB_URL}/storage/v1/object/list/bean-photos`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: folder, limit: 1, sortBy: { column: "created_at", order: "desc" } }),
  });
  const items = await r.json() as { name: string; id: string | null }[];
  const f = items.find((i) => i.id !== null && /\.(jpe?g)$/i.test(i.name));
  if (f) photos.push(`${folder}/${f.name}`);
}
console.log(`sampled ${photos.length} photos from ${photos.length} distinct users\n`);

function toB64(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

let last = 0;
async function parse(prompt: string, b64: string): Promise<Record<string, unknown> | null> {
  const wait = last + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  for (let attempt = 0; attempt < 3; attempt++) {
    last = Date.now();
    try {
      const res = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ZAI_KEY}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model: ZAI_DEFAULT_MODEL,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: [
              { type: "text", text: `locale = ${LOCALE}` },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            ] },
          ],
          temperature: 1, top_p: 0.95, max_tokens: 1024, stream: false,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      // deno-lint-ignore no-explicit-any
      const body: any = await res.json();
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") return null;
      return NEW.normalizeResult(JSON.parse(content)) as Record<string, unknown>;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

type R = Record<string, unknown> | null;
const runs: { photo: string; old1: R; old2: R; new1: R; new2: R }[] = [];
for (const [i, photo] of photos.entries()) {
  const img = await fetch(`${SB_URL}/storage/v1/object/bean-photos/${photo}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!img.ok) continue;
  const b64 = toB64(new Uint8Array(await img.arrayBuffer()));
  // Interleave so drift over time does not favour one prompt.
  const old1 = await parse(PROMPTS.old, b64);
  const new1 = await parse(PROMPTS.new, b64);
  const old2 = await parse(PROMPTS.old, b64);
  const new2 = await parse(PROMPTS.new, b64);
  runs.push({ photo, old1, old2, new1, new2 });
  console.error(`[${i + 1}/${photos.length}] ${[old1, new1, old2, new2].map((x) => x ? "ok" : "FAIL").join(" ")}`);
}

// ---- report ----------------------------------------------------------------
const norm = (v: unknown) => v === undefined || v === null ? null : String(v).trim().toLowerCase();
const same = (a: R, b: R, f: string) => norm(a?.[f]) === norm(b?.[f]);
const fields = [...new Set(runs.flatMap((r) =>
  [r.old1, r.old2, r.new1, r.new2].flatMap((x) => x ? Object.keys(x) : [])
))].filter((f) => f !== "roasterBrandName").sort();

const complete = runs.filter((r) => r.old1 && r.old2 && r.new1 && r.new2);
const fails = { old: runs.flatMap((r) => [r.old1, r.old2]).filter((x) => !x).length,
                new: runs.flatMap((r) => [r.new1, r.new2]).filter((x) => !x).length };
console.log(`\nparse failures: old ${fails.old}/${runs.length * 2}, new ${fails.new}/${runs.length * 2}`);
console.log(`photos with all 4 runs: ${complete.length}\n`);

console.log("DISAGREEMENT RATE per field (lower is better). A regression shows as");
console.log("cross >> max(old-vs-old, new-vs-new). Cross pairs: old1~new1, old2~new2.\n");
console.log("field".padEnd(22) + "old~old  new~new  old~new   verdict");
const flagged: string[] = [];
for (const f of fields) {
  const n = complete.length;
  const oo = complete.filter((r) => !same(r.old1, r.old2, f)).length / n;
  const nn = complete.filter((r) => !same(r.new1, r.new2, f)).length / n;
  const on = complete.filter((r) => !same(r.old1, r.new1, f)).length / (2 * n) +
             complete.filter((r) => !same(r.old2, r.new2, f)).length / (2 * n);
  const noise = Math.max(oo, nn);
  const verdict = on > noise + 0.15 ? "REGRESSION?" : on > noise + 0.05 ? "watch" : "ok";
  if (verdict !== "ok") flagged.push(f);
  console.log(f.padEnd(22) + [oo, nn, on].map((x) => x.toFixed(2).padStart(7)).join("  ") + "   " + verdict);
}

console.log(`\nroasterBrandName (new prompt only), first run:`);
for (const r of complete) {
  console.log(`  roaster="${r.new1?.roaster ?? ""}"  ->  brand=${JSON.stringify(r.new1?.roasterBrandName ?? null)}   (2nd run: ${JSON.stringify(r.new2?.roasterBrandName ?? null)})`);
}
const brandStable = complete.filter((r) => norm(r.new1?.roasterBrandName) === norm(r.new2?.roasterBrandName)).length;
console.log(`\nroasterBrandName identical across both new runs: ${brandStable}/${complete.length}`);

if (flagged.length) {
  console.log(`\nValues for flagged fields (old1 | new1):`);
  for (const f of flagged) for (const r of complete) {
    if (!same(r.old1, r.new1, f)) console.log(`  ${f}: ${JSON.stringify(r.old1?.[f] ?? null)} | ${JSON.stringify(r.new1?.[f] ?? null)}`);
  }
}
