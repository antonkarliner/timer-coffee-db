/**
 * Plan 034 §2.1 steps 1–2, 4–5 — Jev against REAL unmatched scans.
 *
 * Companion to scripts/jev-roaster-eval.ts. That one perturbs catalog rows, so
 * ground truth is free but the inputs are synthetic. This one uses the actual
 * free-text `roaster` strings users' scans produced, which have no ground
 * truth — so instead of accuracy it measures two things that need no labels:
 *
 *   1. Does Jev AGREE with the trigram baseline? Agreement is weak evidence of
 *      correctness; disagreement is the set worth an operator's time.
 *   2. Does Jev link or abstain, and at what p? The abstain rate on real
 *      unmatched scans is the number that decides whether §2 is worth shipping.
 *
 * It writes the §2.1 labelling CSV as a by-product.
 *
 * Run: /opt/homebrew/bin/deno run --allow-net --allow-env --allow-read --allow-write \
 *        --env-file=supabase/.env.local --no-lock scripts/jev-real-scan-eval.ts
 */

import { csvRawCell, csvTextCell } from "./lib/spreadsheet-safe.ts";

const JEV_KEY = Deno.env.get("TYPESAFE_API_KEY");
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!JEV_KEY || !SB_URL || !SB_KEY) {
  console.error(
    "need TYPESAFE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
  );
  Deno.exit(1);
}

const N = Number(Deno.env.get("JEV_REAL_N") ?? "250");
const WIDTH = Number(Deno.env.get("JEV_REAL_WIDTH") ?? "15");
const CONCURRENCY = Number(Deno.env.get("JEV_REAL_CONCURRENCY") ?? "5");
const DIR =
  "/private/tmp/claude-501/-Users-antonkarliner-GitHub-timer-coffee-db/ff9efa37-1e86-4425-9d15-f83299f1ef2f/scratchpad";

async function rpc(fn: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY!,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  return await r.json();
}
async function rest(q: string): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, {
    headers: { apikey: SB_KEY!, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`${q}: ${r.status} ${await r.text()}`);
  return await r.json();
}

interface Bean {
  roaster: string;
  name: string | null;
  origin: string | null;
  region: string | null;
  variety: string | null;
  tasting_notes: string | null;
}
interface Candidate {
  roaster_id: number;
  roaster_name: string;
  confidence: number;
  match_method: string;
}
interface Meta {
  id: number;
  roaster_name: string;
  city: string | null;
  country: string | null;
  aliases: string | null;
}

async function jev(
  state: unknown,
  criteria: Record<string, string>,
  attempt = 0,
): Promise<
  {
    choice: string;
    p: number;
    confidence: number;
    probs: Record<string, number>;
    ms: number;
    tok: number;
  } | null
> {
  const t0 = performance.now();
  try {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JEV_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        model: "jev-latest",
        questions: {
          roaster_link: {
            type: "choice",
            instructions:
              "The state is a coffee bag label read from a photo. Which roaster in the options roasted this coffee? Pick __none__ if the roaster that made this bag is not among the options, or if the roaster text is not a roaster name at all.",
            criteria,
          },
        },
      }),
    });
    if ((r.status === 429 || r.status === 529) && attempt < 5) {
      await new Promise((s) => setTimeout(s, 400 * 2 ** attempt));
      return jev(state, criteria, attempt + 1);
    }
    if (!r.ok) return null;
    // deno-lint-ignore no-explicit-any
    const b: any = await r.json();
    const a = b.answers.roaster_link;
    return {
      choice: a.choice,
      p: a.probabilities[a.choice],
      confidence: a.confidence,
      probs: a.probabilities,
      ms: performance.now() - t0,
      tok: b.usage.input_tokens,
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- sample
console.log(`Real-scan eval — N=${N}, width=${WIDTH}`);
const beans =
  await rpc("jev_real_sample", {}).catch(() => null) as Bean[] | null ??
    await (async () => {
      // No helper RPC: pull the most-scanned unmatched roaster strings client-side.
      const rows = await rest(
        `global_coffee_beans?select=roaster,name,origin,region,variety,tasting_notes&roaster=not.is.null&limit=12000`,
      ) as Bean[];
      const cat = await rest(`coffee_roasters?select=roaster_name`) as {
        roaster_name: string;
      }[];
      const norm = (s: string) =>
        s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
      const known = new Set(cat.map((c) => norm(c.roaster_name)));
      const counts = new Map<string, { n: number; bean: Bean }>();
      for (const b of rows) {
        if (!b.roaster || b.roaster.trim().length < 2) continue;
        if (known.has(norm(b.roaster))) continue;
        const k = b.roaster;
        const cur = counts.get(k);
        if (cur) cur.n++;
        else counts.set(k, { n: 1, bean: b });
      }
      return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, N).map((
        v,
      ) => v.bean);
    })();

console.log(
  `sampled ${beans.length} distinct unmatched roaster strings (most-scanned first)`,
);

interface Row {
  raw_roaster: string;
  bean_name: string | null;
  n_options: number;
  jev_choice: string;
  jev_choice_name: string | null;
  jev_p: number;
  jev_confidence: number;
  trigram_top_id: number | null;
  trigram_top_name: string | null;
  trigram_top_sim: number | null;
  baseline_links: boolean;
  jev_links: boolean;
  agree: boolean;
  latency_ms: number;
  input_tokens: number;
}
const rows: Row[] = [];

async function pool<T>(items: T[], fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const k = i++;
      try {
        await fn(items[k]);
      } catch { /* keep going */ }
      if (k % 25 === 0) Deno.stderr.write(new TextEncoder().encode("."));
    }
  }));
}

await pool(beans, async (b) => {
  const cands = await rpc("find_potential_roaster_matches", {
    search_normalized_name: b.roaster.toLowerCase(),
    search_display_name: b.roaster,
    max_results: WIDTH,
    min_confidence: 0.05,
    search_website_url: null,
  }) as Candidate[];
  if (!cands.length) return;

  const ids = cands.map((c) => c.roaster_id);
  const metas = await rest(
    `coffee_roasters?select=id,roaster_name,city,country,aliases&id=in.(${
      ids.join(",")
    })`,
  ) as Meta[];
  const mm = new Map(metas.map((m) => [m.id, m]));

  const criteria: Record<string, string> = {};
  for (const c of cands) {
    const m = mm.get(c.roaster_id);
    const place = [m?.city, m?.country].filter(Boolean).join(", ");
    criteria[String(c.roaster_id)] = `${c.roaster_name}${
      place ? ` — ${place}.` : "."
    }${m?.aliases ? ` Also known as: ${m.aliases}.` : ""}`;
  }
  criteria["__none__"] =
    "None of these. The roaster that made this bag is not any of the roasters listed above, or the roaster text is not a roaster name.";

  const out = await jev({
    roaster: b.roaster,
    name: b.name,
    origin: b.origin,
    region: b.region,
    variety: b.variety,
    tastingNotes: b.tasting_notes,
  }, criteria);
  if (!out) return;

  const top = cands[0];
  const baselineLinks = top.confidence >= 0.6;
  const jevLinks = out.choice !== "__none__";
  rows.push({
    raw_roaster: b.roaster,
    bean_name: b.name,
    n_options: Object.keys(criteria).length,
    jev_choice: out.choice,
    jev_choice_name: jevLinks
      ? (mm.get(Number(out.choice))?.roaster_name ?? null)
      : null,
    jev_p: out.p,
    jev_confidence: out.confidence,
    trigram_top_id: top.roaster_id,
    trigram_top_name: top.roaster_name,
    trigram_top_sim: top.confidence,
    baseline_links: baselineLinks,
    jev_links: jevLinks,
    agree: baselineLinks === jevLinks &&
      (!jevLinks || out.choice === String(top.roaster_id)),
    latency_ms: out.ms,
    input_tokens: out.tok,
  });
});

console.log(`\n${rows.length} evaluated\n`);
await Deno.writeTextFile(
  `${DIR}/jev-real-scan.jsonl`,
  rows.map((r) => JSON.stringify(r)).join("\n"),
);

const csv = [
  "raw_roaster,bean_name,jev_choice_name,jev_p,trigram_top_name,trigram_top_sim,agree,TRUE_ROASTER_OR_NONE",
  ...rows.map((r) =>
    [
      csvTextCell(r.raw_roaster),
      csvTextCell(r.bean_name ?? ""),
      csvTextCell(r.jev_choice_name ?? "__none__"),
      csvRawCell(r.jev_p.toFixed(3)),
      csvTextCell(r.trigram_top_name ?? ""),
      csvRawCell((r.trigram_top_sim ?? 0).toFixed(3)),
      csvRawCell(r.agree ? "yes" : "NO"),
      csvRawCell(""),
    ].join(",")
  ),
].join("\n");
await Deno.writeTextFile(`${DIR}/jev-real-scan-to-label.csv`, csv);

const pctl = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))];
};

console.log(
  `=== LINK vs ABSTAIN on real unmatched scans (n=${rows.length}) ===`,
);
const links = rows.filter((r) => r.jev_links);
console.log(
  `  Jev linked   : ${links.length} (${
    (links.length / rows.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  Jev abstained: ${rows.length - links.length} (${
    ((rows.length - links.length) / rows.length * 100).toFixed(1)
  }%)`,
);
for (const t of [0.5, 0.7, 0.9, 0.95]) {
  const l = links.filter((r) => r.jev_p >= t);
  console.log(
    `    links surviving p >= ${t.toFixed(2)}: ${l.length} (${
      (l.length / rows.length * 100).toFixed(1)
    }% of all scans)`,
  );
}

console.log(`\n=== AGREEMENT WITH TRIGRAM BASELINE (top hit, sim >= 0.6) ===`);
const bl = rows.filter((r) => r.baseline_links);
console.log(
  `  baseline would link: ${bl.length} (${
    (bl.length / rows.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  agree            : ${rows.filter((r) => r.agree).length} (${
    (rows.filter((r) => r.agree).length / rows.length * 100).toFixed(1)
  }%)`,
);
console.log(
  `  jev links, baseline does NOT : ${
    rows.filter((r) => r.jev_links && !r.baseline_links).length
  }  <- the value Jev adds, IF correct`,
);
console.log(
  `  baseline links, jev does NOT : ${
    rows.filter((r) => !r.jev_links && r.baseline_links).length
  }  <- the false links Jev avoids, IF correct`,
);
console.log(
  `  both link, DIFFERENT roaster : ${
    rows.filter((r) =>
      r.jev_links && r.baseline_links &&
      r.jev_choice !== String(r.trigram_top_id)
    ).length
  }`,
);

console.log(
  `\n  Sample where Jev links but the baseline would not (high p first):`,
);
for (
  const r of rows.filter((x) => x.jev_links && !x.baseline_links).sort((a, b) =>
    b.jev_p - a.jev_p
  ).slice(0, 12)
) {
  console.log(
    `    "${r.raw_roaster}" -> ${r.jev_choice_name}  p=${
      r.jev_p.toFixed(3)
    }  (trigram top "${r.trigram_top_name}" sim=${
      (r.trigram_top_sim ?? 0).toFixed(2)
    })`,
  );
}
console.log(`\n  Sample where the baseline links but Jev abstains:`);
for (
  const r of rows.filter((x) => !x.jev_links && x.baseline_links).sort((a, b) =>
    (b.trigram_top_sim ?? 0) - (a.trigram_top_sim ?? 0)
  ).slice(0, 12)
) {
  console.log(
    `    "${r.raw_roaster}" -> baseline "${r.trigram_top_name}" sim=${
      (r.trigram_top_sim ?? 0).toFixed(2)
    }, jev __none__ p=${r.jev_p.toFixed(3)}`,
  );
}

console.log(`\n=== COST / LATENCY ===`);
const lat = rows.map((r) => r.latency_ms);
const tok = rows.reduce((a, r) => a + r.input_tokens, 0);
console.log(
  `  p50=${pctl(lat, 50).toFixed(0)}ms p95=${
    pctl(lat, 95).toFixed(0)
  }ms  mean_tokens=${(tok / rows.length).toFixed(0)}`,
);
console.log(
  `  cost for all 3,675 distinct unmatched strings: $${
    (tok / rows.length * 3675 / 1e6 * 0.042).toFixed(4)
  }`,
);
console.log(`\nlabelling CSV -> ${DIR}/jev-real-scan-to-label.csv`);
