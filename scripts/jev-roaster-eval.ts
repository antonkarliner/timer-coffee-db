/**
 * Plan 034 §0.3 / §2.1 — large-sample Jev evaluation on the REAL catalog.
 *
 * Ground truth without human labelling: take a real `coffee_roasters` row,
 * perturb its name the way real scans do, retrieve real candidates with the
 * real trigram function, and check whether Jev picks the row we started from.
 * Distractors therefore come from production, not imagination — the retrieval
 * call is the same one §2.2 would make.
 *
 * Four runs:
 *   lang   — 1 perturbation x N languages. Does non-English degrade?
 *   perturb— N perturbation classes, English. Which scan defects survive?
 *   absent — true roaster REMOVED from the options. False-positive rate.
 *   width  — candidate-list size sweep. How many options should §2.2 send?
 *
 * The headline output is a CALIBRATION table. TypeSafe's entire pitch is
 * calibrated probabilities and plan 034 thresholds on them, so if p is not
 * calibrated on our data the threshold policy is void.
 *
 * Run: /opt/homebrew/bin/deno run --allow-net --allow-env --allow-read \
 *        --env-file=supabase/.env.local --no-lock scripts/jev-roaster-eval.ts [runs...]
 */

const JEV_KEY = Deno.env.get("TYPESAFE_API_KEY");
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!JEV_KEY || !SB_URL || !SB_KEY) {
  console.error(
    "need TYPESAFE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
  );
  Deno.exit(1);
}

const N = Number(Deno.env.get("JEV_EVAL_N") ?? "120");
const CONCURRENCY = Number(Deno.env.get("JEV_EVAL_CONCURRENCY") ?? "4");
const OUT = Deno.env.get("JEV_EVAL_OUT") ??
  "/private/tmp/claude-501/-Users-antonkarliner-GitHub-timer-coffee-db/ff9efa37-1e86-4425-9d15-f83299f1ef2f/scratchpad/jev-eval.jsonl";

// ---------------------------------------------------------------- supabase
async function sb(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY!,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
  return await r.json();
}

interface Roaster {
  id: number;
  roaster_name: string;
  city: string | null;
  country: string | null;
  aliases: string | null;
}
interface Candidate {
  roaster_id: number;
  roaster_name: string;
  confidence: number;
  match_method: string;
}

// ------------------------------------------------------------------- jev
interface JevOut {
  choice: string;
  p: number;
  confidence: number;
  latencyMs: number;
  inputTokens: number;
}

async function jevChoose(
  state: unknown,
  criteria: Record<string, string>,
  attempt = 0,
): Promise<JevOut | null> {
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
              "The state is a coffee bag label read from a photo. Which roaster in the options roasted this coffee? Pick __none__ if the roaster that made this bag is not among the options.",
            criteria,
          },
        },
      }),
    });
    if ((r.status === 429 || r.status === 529) && attempt < 5) {
      await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
      return jevChoose(state, criteria, attempt + 1);
    }
    if (!r.ok) return null;
    // deno-lint-ignore no-explicit-any
    const b: any = await r.json();
    const a = b.answers.roaster_link;
    return {
      choice: a.choice,
      p: a.probabilities[a.choice],
      confidence: a.confidence,
      latencyMs: performance.now() - t0,
      inputTokens: b.usage.input_tokens,
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- perturbations
const SUFFIX_RE =
  /\s*(coffee\s+roasters?|coffee\s+roastery|roasting\s+co\.?|coffee\s+co\.?|roasters?|roastery|coffee|caf[eé]|kaffee)\s*$/i;

const stripSuffix = (n: string) => n.replace(SUFFIX_RE, "").trim() || n;

function typo(n: string): string {
  const i = Math.max(1, Math.floor(n.length / 2));
  if (i + 1 >= n.length) return n;
  return n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2);
}

const PERTURB: Record<string, (n: string) => string> = {
  exact: (n) => n,
  drop_plural: (n) =>
    n.replace(/Roasters\b/g, "Roaster").replace(/Roastery\b/g, "Roaster"),
  drop_suffix: stripSuffix,
  upper: (n) => n.toUpperCase(),
  typo,
  first_word: (n) => n.split(/\s+/)[0],
};

// ------------------------------------------------------------- languages
// The proper noun stays; the generic suffix and the surrounding label context
// localize, which is what a real non-English bag actually looks like.
interface Lang {
  suffix: string;
  origin: string;
  region: string;
  process: string;
  notes: string;
}
const LANGS: Record<string, Lang> = {
  en: {
    suffix: "Coffee Roasters",
    origin: "Ethiopia",
    region: "Guji",
    process: "Washed",
    notes: "peach, jasmine, black tea",
  },
  de: {
    suffix: "Kaffeerösterei",
    origin: "Äthiopien",
    region: "Guji",
    process: "Gewaschen",
    notes: "Pfirsich, Jasmin, schwarzer Tee",
  },
  ru: {
    suffix: "Обжарщик кофе",
    origin: "Эфиопия",
    region: "Гуджи",
    process: "Мытая обработка",
    notes: "персик, жасмин, чёрный чай",
  },
  uk: {
    suffix: "Обсмажувач кави",
    origin: "Ефіопія",
    region: "Гуджі",
    process: "Мита обробка",
    notes: "персик, жасмин, чорний чай",
  },
  fr: {
    suffix: "Torréfacteur",
    origin: "Éthiopie",
    region: "Guji",
    process: "Lavé",
    notes: "pêche, jasmin, thé noir",
  },
  es: {
    suffix: "Tostador de café",
    origin: "Etiopía",
    region: "Guji",
    process: "Lavado",
    notes: "melocotón, jazmín, té negro",
  },
  it: {
    suffix: "Torrefazione",
    origin: "Etiopia",
    region: "Guji",
    process: "Lavato",
    notes: "pesca, gelsomino, tè nero",
  },
  pt: {
    suffix: "Torrefação",
    origin: "Etiópia",
    region: "Guji",
    process: "Lavado",
    notes: "pêssego, jasmim, chá preto",
  },
  pl: {
    suffix: "Palarnia kawy",
    origin: "Etiopia",
    region: "Guji",
    process: "Myta",
    notes: "brzoskwinia, jaśmin, czarna herbata",
  },
  cs: {
    suffix: "Pražírna kávy",
    origin: "Etiopie",
    region: "Guji",
    process: "Praná",
    notes: "broskev, jasmín, černý čaj",
  },
  tr: {
    suffix: "Kahve Kavurucusu",
    origin: "Etiyopya",
    region: "Guji",
    process: "Yıkanmış",
    notes: "şeftali, yasemin, siyah çay",
  },
  ja: {
    suffix: "コーヒー焙煎所",
    origin: "エチオピア",
    region: "グジ",
    process: "ウォッシュト",
    notes: "桃、ジャスミン、紅茶",
  },
  ko: {
    suffix: "커피 로스터리",
    origin: "에티오피아",
    region: "구지",
    process: "워시드",
    notes: "복숭아, 자스민, 홍차",
  },
  zh: {
    suffix: "咖啡烘焙商",
    origin: "埃塞俄比亚",
    region: "古吉",
    process: "水洗",
    notes: "桃子、茉莉、红茶",
  },
};

// ------------------------------------------------------------------ helpers
function describe(c: Candidate, meta: Map<number, Roaster>): string {
  const m = meta.get(c.roaster_id);
  const place = [m?.city, m?.country].filter(Boolean).join(", ");
  const al = m?.aliases ? ` Also known as: ${m.aliases}.` : "";
  return `${c.roaster_name}${place ? ` — ${place}.` : "."}${al}`;
}

const NONE_DESC =
  "None of these. The roaster that made this bag is not any of the roasters listed above.";

interface Row {
  run: string;
  cell: string;
  true_id: number;
  true_name: string;
  shown_roaster: string;
  n_options: number;
  true_present: boolean;
  choice: string;
  p: number;
  confidence: number;
  correct: boolean;
  trigram_top_id: number | null;
  trigram_top_conf: number | null;
  trigram_recall: boolean;
  latency_ms: number;
  input_tokens: number;
}
const rows: Row[] = [];

async function pool<T>(items: T[], fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k]);
      if (k % 50 === 0) Deno.stderr.write(new TextEncoder().encode("."));
    }
  });
  await Promise.all(workers);
}

// --------------------------------------------------------------- main
console.log(`Jev roaster eval — N=${N} roasters, concurrency=${CONCURRENCY}`);

const roasters =
  await sb("rpc/jev_eval_sample", {}).catch(() => null) as Roaster[] | null ??
    await (async () => {
      const r = await fetch(
        `${SB_URL}/rest/v1/coffee_roasters?select=id,roaster_name,city,country,aliases&roaster_name=not.is.null&order=id.asc`,
        { headers: { apikey: SB_KEY!, Authorization: `Bearer ${SB_KEY}` } },
      );
      const all = await r.json() as Roaster[];
      // Deterministic spread across the catalog, not the first N ids.
      const step = Math.max(1, Math.floor(all.length / N));
      return all.filter((_, i) => i % step === 0).slice(0, N);
    })();

console.log(`sampled ${roasters.length} roasters from the live catalog`);

// Retrieve real candidates once per roaster and reuse across runs.
const candMap = new Map<number, Candidate[]>();
const metaMap = new Map<number, Roaster>();
for (const r of roasters) metaMap.set(r.id, r);

await pool(roasters, async (r) => {
  const c = await sb("rpc/find_potential_roaster_matches", {
    search_normalized_name: r.roaster_name.toLowerCase(),
    search_display_name: r.roaster_name,
    max_results: 40,
    min_confidence: 0.05,
    search_website_url: null,
  }) as Candidate[];
  candMap.set(r.id, c);
  for (const x of c) {
    if (!metaMap.has(x.roaster_id)) {
      metaMap.set(x.roaster_id, {
        id: x.roaster_id,
        roaster_name: x.roaster_name,
        city: null,
        country: null,
        aliases: null,
      });
    }
  }
});
console.log(`\nretrieved candidates for ${candMap.size} roasters`);

// Fill missing metadata for distractors in one shot.
const needed = [...metaMap.values()].filter((m) => m.city === null).map((m) =>
  m.id
);
if (needed.length) {
  const res = await fetch(
    `${SB_URL}/rest/v1/coffee_roasters?select=id,roaster_name,city,country,aliases&id=in.(${
      needed.join(",")
    })`,
    { headers: { apikey: SB_KEY!, Authorization: `Bearer ${SB_KEY}` } },
  );
  for (const m of await res.json() as Roaster[]) metaMap.set(m.id, m);
}

function buildCriteria(
  target: Roaster,
  width: number,
  includeTrue: boolean,
): {
  criteria: Record<string, string>;
  truePresent: boolean;
  trigramTop: Candidate | null;
  recall: boolean;
} {
  const cands = (candMap.get(target.id) ?? []).slice();
  const trigramTop = cands[0] ?? null;
  const recall = cands.some((c) => c.roaster_id === target.id);
  let use = cands.filter((c) => includeTrue || c.roaster_id !== target.id)
    .slice(0, width);
  if (includeTrue && !use.some((c) => c.roaster_id === target.id)) {
    // Guarantee the ground truth is an option; otherwise the cell measures
    // retrieval, not decision.
    use = [
      {
        roaster_id: target.id,
        roaster_name: target.roaster_name,
        confidence: 1,
        match_method: "injected",
      },
      ...use.slice(0, width - 1),
    ];
  }
  const criteria: Record<string, string> = {};
  for (const c of use) criteria[String(c.roaster_id)] = describe(c, metaMap);
  criteria["__none__"] = NONE_DESC;
  return { criteria, truePresent: includeTrue, trigramTop, recall };
}

async function cell(
  run: string,
  cellName: string,
  target: Roaster,
  shownRoaster: string,
  state: unknown,
  width: number,
  includeTrue: boolean,
) {
  const { criteria, trigramTop, recall } = buildCriteria(
    target,
    width,
    includeTrue,
  );
  const out = await jevChoose(state, criteria);
  if (!out) return;
  const correct = includeTrue
    ? out.choice === String(target.id)
    : out.choice === "__none__";
  rows.push({
    run,
    cell: cellName,
    true_id: target.id,
    true_name: target.roaster_name,
    shown_roaster: shownRoaster,
    n_options: Object.keys(criteria).length,
    true_present: includeTrue,
    choice: out.choice,
    p: out.p,
    confidence: out.confidence,
    correct,
    trigram_top_id: trigramTop?.roaster_id ?? null,
    trigram_top_conf: trigramTop?.confidence ?? null,
    trigram_recall: recall,
    latency_ms: out.latencyMs,
    input_tokens: out.inputTokens,
  });
}

const RUNS = Deno.args.length
  ? Deno.args
  : ["lang", "perturb", "absent", "width"];
const tasks: (() => Promise<void>)[] = [];

if (RUNS.includes("lang")) {
  for (const r of roasters) {
    for (const [code, L] of Object.entries(LANGS)) {
      const shown = `${stripSuffix(r.roaster_name)} ${L.suffix}`;
      tasks.push(() =>
        cell(
          "lang",
          code,
          r,
          shown,
          {
            roaster: shown,
            origin: L.origin,
            region: L.region,
            process: L.process,
            tastingNotes: L.notes,
          },
          15,
          true,
        )
      );
    }
  }
}
if (RUNS.includes("perturb")) {
  const L = LANGS.en;
  for (const r of roasters) {
    for (const [name, fn] of Object.entries(PERTURB)) {
      const shown = fn(r.roaster_name);
      tasks.push(() =>
        cell(
          "perturb",
          name,
          r,
          shown,
          {
            roaster: shown,
            origin: L.origin,
            region: L.region,
            process: L.process,
            tastingNotes: L.notes,
          },
          15,
          true,
        )
      );
    }
  }
}
if (RUNS.includes("absent")) {
  for (const r of roasters) {
    for (const code of ["en", "de", "ru"]) {
      const L = LANGS[code];
      const shown = `${stripSuffix(r.roaster_name)} ${L.suffix}`;
      tasks.push(() =>
        cell(
          "absent",
          code,
          r,
          shown,
          {
            roaster: shown,
            origin: L.origin,
            region: L.region,
            process: L.process,
            tastingNotes: L.notes,
          },
          15,
          false,
        )
      );
    }
  }
}
if (RUNS.includes("width")) {
  const L = LANGS.en;
  for (const r of roasters.slice(0, Math.floor(N / 2))) {
    for (const w of [5, 15, 40, 100]) {
      const shown = PERTURB.drop_plural(r.roaster_name);
      tasks.push(() =>
        cell(
          "width",
          `w${w}`,
          r,
          shown,
          {
            roaster: shown,
            origin: L.origin,
            region: L.region,
            process: L.process,
            tastingNotes: L.notes,
          },
          w,
          true,
        )
      );
    }
  }
}

console.log(`running ${tasks.length} evaluations...`);
const t0 = performance.now();
await pool(tasks, (t) => t());
console.log(
  `\ndone in ${
    ((performance.now() - t0) / 1000).toFixed(0)
  }s — ${rows.length} rows\n`,
);

await Deno.writeTextFile(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
console.log(`raw rows -> ${OUT}\n`);

// ------------------------------------------------------------- reporting
const pctl = (a: number[], q: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))];
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

function table(run: string, label: string) {
  const sub = rows.filter((r) => r.run === run);
  if (!sub.length) return;
  console.log(`\n=== ${label} (n=${sub.length}) ===`);
  const cells = [...new Set(sub.map((r) => r.cell))];
  console.log(
    `  cell        n    acc     mean_p  p50_p   acc@p>=0.9  share>=0.9`,
  );
  for (const c of cells) {
    const s = sub.filter((r) => r.cell === c);
    const hi = s.filter((r) => r.p >= 0.9);
    const accHi = hi.length
      ? hi.filter((r) => r.correct).length / hi.length
      : NaN;
    console.log(
      `  ${c.padEnd(11)} ${String(s.length).padStart(4)}  ` +
        `${(s.filter((r) => r.correct).length / s.length).toFixed(3)}  ` +
        `${mean(s.map((r) => r.p)).toFixed(3)}  ${
          pctl(s.map((r) => r.p), 50).toFixed(3)
        }  ` +
        `${isNaN(accHi) ? "  n/a " : accHi.toFixed(3).padStart(6)}      ${
          (hi.length / s.length).toFixed(3)
        }`,
    );
  }
}

table("lang", "LANGUAGE — true roaster present, 15 options");
table("perturb", "PERTURBATION — English, 15 options");
table("absent", "TRUE ROASTER ABSENT — correct answer is __none__");
table("width", "CANDIDATE COUNT — drop_plural, true roaster present");

// Calibration — the headline result.
// Split by decision kind: a high p on "__none__" and a high p on a roaster id
// drive completely different behaviour in §2.2, and averaging them together
// hides whichever one is miscalibrated.
const BUCKETS = [[0, 0.5], [0.5, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 0.95], [
  0.95,
  1.01,
]];

function calibration(label: string, sub: Row[]) {
  if (!sub.length) return;
  console.log(`\n=== CALIBRATION — ${label} (n=${sub.length}) ===`);
  console.log(
    `  If p is calibrated, accuracy tracks mean_p. Negative gap = OVERCONFIDENT.`,
  );
  console.log(`  p range        n     mean_p   accuracy   gap`);
  for (const [lo, hi] of BUCKETS) {
    const s = sub.filter((r) => r.p >= lo && r.p < hi);
    if (!s.length) continue;
    const mp = mean(s.map((r) => r.p));
    const acc = s.filter((r) => r.correct).length / s.length;
    console.log(
      `  [${lo.toFixed(2)},${hi >= 1 ? "1.00" : hi.toFixed(2)})  ${
        String(s.length).padStart(5)
      }   ` +
        `${mp.toFixed(3)}    ${acc.toFixed(3)}     ${
          (acc - mp >= 0 ? "+" : "") + (acc - mp).toFixed(3)
        }`,
    );
  }
}

console.log("\n");
calibration(
  "LINK decisions (Jev named a roaster) — this is what §2.2 acts on",
  rows.filter((r) => r.choice !== "__none__"),
);
calibration(
  "ABSTAIN decisions (Jev said __none__)",
  rows.filter((r) => r.choice === "__none__"),
);
calibration("all decisions pooled", rows);

// The metric that decides whether §2 is safe to enforce.
console.log(`\n\n=== MISPICK RATE (the user-visible harm in §2) ===`);
console.log(
  `  A mispick = the true roaster WAS an option, and Jev named a different one.`,
);
console.log(
  `  Abstaining (__none__) is not a mispick — it just means no link.`,
);
const pres = rows.filter((r) => r.true_present);
const mispick = pres.filter((r) =>
  r.choice !== "__none__" && r.choice !== String(r.true_id)
);
const abstain = pres.filter((r) => r.choice === "__none__");
console.log(
  `  n=${pres.length}  correct=${
    pres.filter((r) => r.correct).length
  }  abstained=${abstain.length}  MISPICKED=${mispick.length} (${
    (mispick.length / pres.length * 100).toFixed(1)
  }%)`,
);
for (const t of [0.5, 0.7, 0.9]) {
  const m = mispick.filter((r) => r.p >= t);
  console.log(
    `    mispicks surviving p >= ${t}: ${m.length}${
      m.length
        ? `  e.g. "${m[0].shown_roaster}" -> ${m[0].choice} (p=${
          m[0].p.toFixed(2)
        }, truth was ${m[0].true_id})`
        : ""
    }`,
  );
}
const fp = rows.filter((r) => !r.true_present && r.choice !== "__none__");
if (rows.some((r) => !r.true_present)) {
  console.log(`\n  FALSE LINKS when the true roaster was absent entirely:`);
  console.log(
    `    n=${
      rows.filter((r) => !r.true_present).length
    }  falsely linked=${fp.length} (${
      (fp.length / rows.filter((r) => !r.true_present).length * 100).toFixed(1)
    }%)`,
  );
  for (const t of [0.5, 0.7, 0.9]) {
    console.log(
      `    surviving p >= ${t}: ${fp.filter((r) => r.p >= t).length}`,
    );
  }
}

// Precision/recall over thresholds — what §2.1 step 4 asks for.
console.log(
  `\n\n=== PRECISION / RECALL vs THRESHOLD (all runs, present + absent) ===`,
);
console.log(`  A "link" = Jev picked a roaster id (not __none__) with p >= t.`);
console.log(`  thresh   links   precision  recall   missed      wrong_links`);
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const links = rows.filter((r) => r.choice !== "__none__" && r.p >= t);
  const tp = links.filter((r) =>
    r.true_present && r.choice === String(r.true_id)
  ).length;
  const bad = links.length - tp;
  const linkable = rows.filter((r) => r.true_present).length;
  console.log(
    `  ${t.toFixed(2)}    ${String(links.length).padStart(5)}   ` +
      `${links.length ? (tp / links.length).toFixed(3) : " n/a "}      ` +
      `${(tp / linkable).toFixed(3)}    ${
        String(linkable - tp).padStart(5)
      }      ${bad}`,
  );
}

console.log(
  `\n\n=== RETRIEVAL (does the trigram search even contain the answer?) ===`,
);
const uniq = [...new Map(rows.map((r) => [r.true_id, r])).values()];
console.log(
  `  recall@40 = ${
    (uniq.filter((r) => r.trigram_recall).length / uniq.length).toFixed(3)
  } over ${uniq.length} roasters`,
);
console.log(
  `  (plan §2.1 step 3 STOPs below 0.85 — but note this samples catalog`,
);
console.log(
  `   rows, which are by construction present; real unmatched scans are harder.)`,
);

console.log(`\n=== LATENCY / COST ===`);
const lat = rows.map((r) => r.latency_ms);
console.log(
  `  p50=${pctl(lat, 50).toFixed(0)}ms p95=${pctl(lat, 95).toFixed(0)}ms p99=${
    pctl(lat, 99).toFixed(0)
  }ms`,
);
const toks = rows.reduce((a, r) => a + r.input_tokens, 0);
console.log(
  `  input tokens total=${toks} mean=${
    (toks / rows.length).toFixed(0)
  }  cost@$0.042/M = $${(toks / 1e6 * 0.042).toFixed(4)}`,
);
