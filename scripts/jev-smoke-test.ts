/**
 * Plan 034 §0.3 — Jev (TypeSafe) smoke test.
 *
 * Confirms the API contract recorded in plan 034 §1.1 against the live
 * endpoint, and settles three things the docs do not answer:
 *   1. Does non-English input work? (undocumented; gates §3, Cyrillic origins)
 *   2. Does `probabilities[choice]` behave better than `confidence` when the
 *      candidate list is long and self-similar? (plan §1.3 asserts it does)
 *   3. What does batching actually cost in latency? (gates the §1.2 design)
 *
 * Cases are shaped like this repo's real problems, not toy examples, so the
 * output doubles as first evidence for §2 and §4.
 *
 * Run: /opt/homebrew/bin/deno run --allow-net --allow-env --allow-read \
 *        --env-file=supabase/.env.local --no-lock scripts/jev-smoke-test.ts
 */

const API_KEY = Deno.env.get("TYPESAFE_API_KEY");
if (!API_KEY) {
  console.error("TYPESAFE_API_KEY not set (expected in supabase/.env.local)");
  Deno.exit(1);
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const REPEATS = Number(Deno.env.get("JEV_SMOKE_REPEATS") ?? "5");

type JsonValue = unknown;
type Question =
  | {
    type: "noul";
    instructions: JsonValue;
    criteria?: { true?: string; false?: string };
  }
  | {
    type: "choice";
    instructions: JsonValue;
    criteria: Record<string, string | null>;
  }
  | { type: "score"; instructions: JsonValue; criteria: readonly string[] };

interface AskResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  // deno-lint-ignore no-explicit-any
  body: any;
}

async function ask(
  state: JsonValue,
  questions: Record<string, Question>,
  timeoutMs = 10_000,
): Promise<AskResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: ctrl.signal,
    });
    const latencyMs = performance.now() - started;
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, latencyMs, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: performance.now() - started,
      body: String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

const latencies: number[] = [];

/**
 * Only successful calls may enter the latency stats. A 401/429 round trip is
 * an auth rejection at the edge, not an inference, and averaging it in makes
 * the 800 ms budget look comfortable when nothing was actually evaluated.
 */
async function preflight(): Promise<void> {
  const r = await ask("ping", {
    ping: { type: "noul", instructions: "Is this a test?" },
  });
  if (r.status === 401) {
    console.error(
      `\nAUTH FAILED (401). The endpoint and header format are correct — the key value is rejected.\n` +
        `  ${JSON.stringify(r.body)}\n` +
        `  Check that TYPESAFE_API_KEY holds the *secret*, not the key's UUID id from the console list.\n`,
    );
    Deno.exit(1);
  }
  if (!r.ok) {
    console.error(
      `\nPreflight failed: status=${r.status} ${
        JSON.stringify(r.body).slice(0, 300)
      }`,
    );
    Deno.exit(1);
  }
  console.log(`preflight OK (${r.latencyMs.toFixed(0)} ms)`);
}

async function runCase(
  label: string,
  state: JsonValue,
  questions: Record<string, Question>,
  expect?: string,
) {
  const r = await ask(state, questions);
  if (r.ok) latencies.push(r.latencyMs);
  if (!r.ok) {
    console.log(
      `\n### ${label}\n  FAILED status=${r.status} ${
        JSON.stringify(r.body).slice(0, 400)
      }`,
    );
    return;
  }
  console.log(
    `\n### ${label}   (${
      r.latencyMs.toFixed(0)
    } ms, in=${r.body.usage?.input_tokens} out=${r.body.usage?.output_tokens})`,
  );
  if (expect) console.log(`  expect: ${expect}`);
  for (const [id, a] of Object.entries(r.body.answers ?? {})) {
    // deno-lint-ignore no-explicit-any
    const ans = a as any;
    if (ans.type === "noul") {
      console.log(
        `  ${id}: noul=${ans.noul.toFixed(3)}  (confidence field present? ${
          Object.hasOwn(ans, "confidence")
        })`,
      );
    } else if (ans.type === "choice") {
      const top = Object.entries(ans.probabilities as Record<string, number>)
        .sort((x, y) => y[1] - x[1]).slice(0, 4)
        .map(([k, v]) => `${k}=${v.toFixed(3)}`).join("  ");
      console.log(
        `  ${id}: choice=${ans.choice}  p[choice]=${
          (ans.probabilities[ans.choice] ?? NaN).toFixed(3)
        }  confidence=${ans.confidence.toFixed(3)}`,
      );
      console.log(`      top: ${top}`);
    } else if (ans.type === "score") {
      console.log(
        `  ${id}: score=${ans.score.toFixed(2)}  confidence=${
          ans.confidence.toFixed(3)
        }  legend=${JSON.stringify(ans.legend)}`,
      );
      console.log(`      probs: ${JSON.stringify(ans.probabilities)}`);
    } else {
      console.log(`  ${id}: UNKNOWN SHAPE ${JSON.stringify(ans)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate sets shaped like §2 (roaster link on scan).
// Option key = roaster id (as string); description = name + aliases + place.
// ---------------------------------------------------------------------------
const ROASTER_CANDIDATES: Record<string, string> = {
  "101":
    "Adrenaline Coffee Roasters — Tbilisi, Georgia. Aliases: Adrenaline, Adrenaline Coffee.",
  "102": "Aroma Coffee Roasters — Kyiv, Ukraine.",
  "103": "Alchemist Coffee — Copenhagen, Denmark. Aliases: The Alchemist.",
  "104": "Andante Coffee Roasters — Seoul, South Korea.",
  "105": "Anthem Coffee Roasters — Portland, USA.",
  "__none__":
    "None of these. The roaster on the bag is not any of the listed roasters, or the list does not contain it.",
};

// A deliberately self-similar 15-option set, to test plan §1.3's claim that
// `confidence` collapses on long lookalike lists while p[choice] stays usable.
const LOOKALIKE_CANDIDATES: Record<string, string> = {
  ...Object.fromEntries(
    [
      "Nordic Roasting Co — Oslo, Norway",
      "Nordic Coffee Roasters — Stockholm, Sweden",
      "Nordic Coffee Collective — Helsinki, Finland",
      "North Roasters — Bergen, Norway",
      "Nord Coffee Roastery — Copenhagen, Denmark",
      "Nordic Bean Roasters — Reykjavik, Iceland",
      "Northern Coffee Roasters — Tromsø, Norway",
      "Nordisk Kaffe — Aarhus, Denmark",
      "Nord & Co Coffee — Malmö, Sweden",
      "Nordic Craft Coffee — Turku, Finland",
      "Northside Roasters — Gothenburg, Sweden",
      "Nordkaffe Roastery — Trondheim, Norway",
      "Nordic Roast House — Odense, Denmark",
      "Northern Lights Coffee — Rovaniemi, Finland",
    ].map((n, i) => [String(200 + i), n]),
  ),
  "__none__": "None of these.",
};

console.log(
  `Jev smoke test — plan 034 §0.3\nendpoint=${ENDPOINT} model=${MODEL}\nNOTE: latency measured from this machine, NOT the Supabase edge region.`,
);
await preflight();

// --- CHOICE: three cases, §2 shape ----------------------------------------
const linkQuestion = (
  criteria: Record<string, string | null>,
): Record<string, Question> => ({
  roaster_link: {
    type: "choice",
    instructions:
      "The state is a coffee bag label parsed from a photo. Which roaster in the options actually roasted this coffee? Choose __none__ if the roaster is not among the options.",
    criteria,
  },
});

await runCase(
  "CHOICE 1 — dropped plural (the plan's motivating case)",
  {
    roaster: "Adrenaline Coffee Roaster",
    name: "Ethiopia Guji",
    origin: "Ethiopia",
    region: "Guji",
    tastingNotes: "peach, jasmine",
  },
  linkQuestion(ROASTER_CANDIDATES),
  "choice=101 with high p",
);

await runCase(
  "CHOICE 2 — genuine new roaster, must pick __none__",
  {
    roaster: "Kuma Coffee Works",
    name: "Colombia Huila",
    origin: "Colombia",
    region: "Huila",
    tastingNotes: "caramel, red apple",
  },
  linkQuestion(ROASTER_CANDIDATES),
  "choice=__none__",
);

await runCase(
  "CHOICE 3 — NON-ENGLISH (Cyrillic) label, English option keys",
  {
    roaster: "Адреналин Кофе Роастерс",
    name: "Эфиопия Гуджи",
    origin: "Эфиопия",
    region: "Гуджи",
    tastingNotes: "персик, жасмин",
  },
  linkQuestion(ROASTER_CANDIDATES),
  "choice=101 — if this fails, §3 (Cyrillic origins) is in doubt",
);

await runCase(
  "CHOICE 4 — 15 lookalikes: does confidence collapse while p[choice] holds?",
  {
    roaster: "Nordic Coffee Roaster",
    name: "Kenya Nyeri",
    origin: "Kenya",
    region: "Nyeri",
    tastingNotes: "blackcurrant",
  },
  linkQuestion(LOOKALIKE_CANDIDATES),
  "tests plan §1.3: expect p[choice] > confidence",
);

// --- NOUL: three cases, §4.2 shape (is_roaster) ---------------------------
const isRoaster: Record<string, Question> = {
  is_roaster: {
    type: "noul",
    instructions:
      "Is this business a coffee roaster — a company that roasts coffee beans and sells them under its own name?",
    criteria: {
      true: "Roasts and sells its own coffee.",
      false:
        "A cafe that only brews, a marketplace, a distributor, an equipment seller, or anything not coffee.",
    },
  },
};

await runCase(
  "NOUL 1 — obvious roaster",
  {
    name: "Adrenaline Coffee Roasters",
    homepage_title:
      "Adrenaline Coffee Roasters — specialty coffee roasted in Tbilisi",
    description:
      "We roast single-origin coffee weekly and ship across Georgia.",
  },
  isRoaster,
  "noul near 1",
);
await runCase(
  "NOUL 2 — obvious non-roaster",
  {
    name: "BaristaShop",
    homepage_title: "BaristaShop — espresso machines, grinders, accessories",
    description: "Authorised reseller of La Marzocco and Mahlkönig equipment.",
  },
  isRoaster,
  "noul near 0",
);
await runCase(
  "NOUL 3 — ambiguous cafe",
  {
    name: "Kompot Coffee",
    homepage_title: "Kompot — coffee bar",
    description:
      "Specialty coffee bar serving beans from rotating guest roasters.",
  },
  isRoaster,
  "noul mid — this is the review-queue ordering signal",
);

// --- SCORE: three cases, §5.1 shape (meaning preserved) -------------------
const LEVELS = [
  "Meaning changed: the rewritten step instructs a different action, time, or quantity.",
  "Meaning mostly preserved but a detail drifted (wording, an implied duration, or an added instruction).",
  "Meaning fully preserved: the same action, timing, and quantities, only wording differs.",
] as const;
const preserved: Record<string, Question> = {
  meaning_preserved: {
    type: "score",
    instructions:
      "Does the verified step preserve the meaning of the original step?",
    criteria: LEVELS,
  },
};

await runCase(
  "SCORE 1 — faithful rewording",
  {
    original_step: "Pour 60 g of water in slow circles and wait 30 seconds.",
    verified_step:
      "Slowly pour 60 g water in a circular motion, then wait 30 seconds.",
  },
  preserved,
  "score near 2",
);
await runCase(
  "SCORE 2 — invented drawdown (a real shipped defect, plan 009)",
  {
    original_step: "Pour the remaining water up to 250 g.",
    verified_step:
      "Pour the remaining water up to 250 g. Wait for the complete drawdown.",
  },
  preserved,
  "score low — an instruction was added",
);
await runCase(
  "SCORE 3 — NON-ENGLISH (German) pair",
  {
    original_step:
      "Gieße 60 g Wasser in langsamen Kreisen auf und warte 30 Sekunden.",
    verified_step:
      "Gieße 60 g Wasser langsam kreisend auf. Vollständig durchlaufen lassen.",
  },
  preserved,
  "score low — German, and the drawdown line was added",
);

// --- BATCHING: does one request with many questions cost more latency? ----
console.log("\n\n=== BATCHING CHECK (§1.2 design depends on this) ===");
const single = await ask({
  roaster: "Adrenaline Coffee Roaster",
  origin: "Ethiopia",
}, linkQuestion(ROASTER_CANDIDATES));
const batched = await ask(
  {
    name: "Adrenaline Coffee Roasters",
    homepage_title: "Adrenaline Coffee Roasters — Tbilisi",
    roaster: "Adrenaline Coffee Roaster",
    origin: "Ethiopia",
  },
  {
    ...linkQuestion(ROASTER_CANDIDATES),
    ...isRoaster,
    ...preserved as Record<string, Question>,
  },
);
console.log(
  `1 question : ${
    single.latencyMs.toFixed(0)
  } ms, in=${single.body?.usage?.input_tokens}`,
);
console.log(
  `3 questions: ${
    batched.latencyMs.toFixed(0)
  } ms, in=${batched.body?.usage?.input_tokens}  status=${batched.status}`,
);

// --- LATENCY over repeats -------------------------------------------------
console.log(`\n\n=== LATENCY (${REPEATS} repeats of CHOICE 1) ===`);
const reps: number[] = [];
for (let i = 0; i < REPEATS; i++) {
  const r = await ask({
    roaster: "Adrenaline Coffee Roaster",
    origin: "Ethiopia",
  }, linkQuestion(ROASTER_CANDIDATES));
  if (r.ok) reps.push(r.latencyMs);
  else {console.log(
      `  repeat ${i}: FAILED ${r.status} — excluded from latency stats`,
    );}
}
if (reps.length === 0) {
  console.log("  no successful calls; no latency to report.");
  Deno.exit(1);
}
reps.sort((a, b) => a - b);
console.log(
  `  n=${reps.length} p50=${pct(reps, 50).toFixed(0)} ms  p95=${
    pct(reps, 95).toFixed(0)
  } ms  min=${reps[0].toFixed(0)}  max=${reps[reps.length - 1].toFixed(0)}`,
);
console.log(
  `  all-case sample: n=${latencies.length} p50=${
    pct([...latencies].sort((a, b) => a - b), 50).toFixed(0)
  } ms`,
);
console.log(
  `\n800 ms abort budget (§1.2) is ${
    pct(reps, 95) < 800 ? "OK" : "TOO TIGHT"
  } against this p95.`,
);
