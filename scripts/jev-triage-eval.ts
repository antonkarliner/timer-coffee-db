// Plan 034 §4.0: names-only Jev triage eval against operator decisions on
// roaster candidate clusters. Read-only against production. Approved clusters
// are a random 250-row sample, so re-runs vary by a few rows.
// Set JEV_TRIAGE_OUT=<path> to also write per-cluster rows as JSON. Question: can Jev, seeing only the raw candidate names (what
// triage sees today), separate rejected clusters from approved/alias ones?
const JEV_KEY = Deno.env.get("TYPESAFE_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function load(status: string, limit: number) {
  const u =
    `${SB_URL}/rest/v1/roaster_candidate_clusters?select=id,display_name,sample_names,status&status=eq.${status}&limit=${limit}`;
  const r = await fetch(u, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Accept-Profile": "service",
    },
  });
  if (!r.ok) throw new Error(`${status}: ${r.status} ${await r.text()}`);
  return await r.json();
}

const CRITERIA = {
  roaster:
    "A coffee roasting business or coffee brand that roasts and sells its own beans",
  placeholder_or_junk:
    "Not a business name: a placeholder, test entry, initials, the user's own name for themselves, 'N/A', 'Self', gibberish",
  coffee_attribute:
    "A property of the coffee rather than who roasted it: a farm, estate, producer, cooperative, origin, variety, blend or product name, roast level",
  retailer_not_roaster:
    "A grocery chain, supermarket or general retailer selling other companies' coffee",
};

async function ask(names: string[]) {
  const body = {
    model: "jev-latest",
    state: {
      field: "roaster name as typed or scanned from a coffee bag",
      values: names,
    },
    questions: {
      kind: {
        type: "choice",
        instructions:
          "Users of a coffee app entered these values in the 'roaster' field of a coffee bag. What do they refer to?",
        criteria: CRITERIA,
      },
    },
  };
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JEV_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (r.ok) return (await r.json()).answers.kind;
    if (r.status === 429 || r.status === 529) {
      await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
      continue;
    }
    throw new Error(`${r.status} ${await r.text()}`);
  }
  return null;
}

const rows = [
  ...(await load("rejected", 1000)),
  ...(await load("approved", 1000)).sort(() => Math.random() - 0.5).slice(
    0,
    250,
  ),
  ...(await load("processed_as_alias", 1000)),
];
const out: any[] = [];
let idx = 0;
async function worker() {
  while (idx < rows.length) {
    const row = rows[idx++];
    const names = Array.isArray(row.sample_names) && row.sample_names.length
      ? row.sample_names.map(String).slice(0, 10)
      : [row.display_name];
    const a = await ask(names);
    if (a) {
      out.push({
        status: row.status,
        name: row.display_name,
        choice: a.choice,
        p: a.probabilities[a.choice],
        probs: a.probabilities,
      });
    }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));
const outPath = Deno.env.get("JEV_TRIAGE_OUT");
if (outPath) await Deno.writeTextFile(outPath, JSON.stringify(out, null, 1));

const isReal = (s: string) => s !== "rejected";
for (const t of [0.5, 0.7, 0.8, 0.9, 0.95]) {
  const flagged = out.filter((o) => o.choice !== "roaster" && o.p >= t);
  const tp = flagged.filter((o) => !isReal(o.status)).length;
  const fpA = flagged.filter((o) => o.status === "approved").length;
  const fpAl = flagged.filter((o) => o.status === "processed_as_alias").length;
  console.log(
    `t=${t} flagged=${flagged.length} rejected_caught=${tp}/${
      out.filter((o) => !isReal(o.status)).length
    } approved_wrongly=${fpA} alias_wrongly=${fpAl}`,
  );
}
const byStatus: Record<string, Record<string, number>> = {};
for (const o of out) {
  (byStatus[o.status] ??= {})[o.choice] = (byStatus[o.status][o.choice] ?? 0) +
    1;
}
console.log(JSON.stringify(byStatus, null, 1));
console.log("approved/alias flagged at p>=0.8:");
for (
  const o of out.filter((o) =>
    isReal(o.status) && o.choice !== "roaster" && o.p >= 0.8
  )
) console.log(" ", o.status, o.name, o.choice, o.p.toFixed(2));
