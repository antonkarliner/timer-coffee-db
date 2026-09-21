import {
  type Case,
  decide,
  DEFAULT_THRESHOLDS,
  disagreements,
  JEV_MODERATION_QUESTIONS,
  jevState,
  jevViolation,
  latencyReport,
  latencyStats,
  parseSafeguard,
  redact,
  type Row,
  SAFEGUARD_MODEL,
  safeguardRequest,
  summarize,
  validateCases,
} from "./jev-moderation-eval.ts";
import { containsObviousLinkOrPhone } from "../supabase/functions/_shared/moderation.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nExpected: ${e}\nActual:   ${a}`);
}

const c = (
  id: string,
  expect: Case["expect"],
  category = "none",
  text = "text",
): Case => ({ id, surface: "review", lang: "en", expect, category, text });

function row(
  kase: Case,
  opts: {
    regex?: boolean;
    legacyBlock?: boolean | null;
    omni?: boolean | null;
    contact?: number;
    violation?: Record<string, number>;
    jevFailed?: boolean;
  },
): Row {
  const probs = opts.violation ?? { acceptable: 1 };
  const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  return {
    case: kase,
    regex: opts.regex ?? false,
    legacy: opts.legacyBlock === undefined ? undefined : {
      result: opts.legacyBlock === null
        ? null
        : opts.legacyBlock
        ? { safe: false, reason: "x" }
        : { safe: true },
      error: opts.legacyBlock === null ? "boom" : null,
      stage: "omni",
      secondary: [],
      latencyMs: 300,
    },
    omni: opts.omni === undefined
      ? undefined
      : { flagged: opts.omni, categories: [], error: null, latencyMs: 200 },
    jev: opts.jevFailed ? null : {
      latencyMs: 250,
      usage: { input_tokens: 400, output_tokens: 10 },
      answers: {
        contact: { type: "noul", noul: opts.contact ?? 0 },
        violation: {
          type: "choice",
          choice,
          probabilities: probs,
          confidence: 0.9,
        },
      },
    },
  };
}

Deno.test("corpus: ids unique, labels valid, every block case has a category", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("./jev-moderation-cases.json", import.meta.url),
    ),
  );
  const cases: Case[] = raw.cases;
  assertEquals(validateCases(cases, "corpus"), [], "schema");
  assert(cases.length >= 100, `only ${cases.length} cases`);
  assertEquals(new Set(cases.map((x) => x.id)).size, cases.length, "dup ids");
  for (const x of cases) {
    assert(["allow", "block", "borderline"].includes(x.expect), x.id);
    assert(
      ["review", "recipe", "display_name", "wish"].includes(x.surface),
      x.id,
    );
    assert(x.text.trim().length > 0, x.id);
    assert(!x.production, `${x.id}: committed corpus must be synthetic`);
    if (x.expect === "block") assert(x.category !== "none", x.id);
    if (x.expect === "allow") assertEquals(x.category, "none", x.id);
  }
  const langs = new Set(cases.map((x) => x.lang));
  assert(langs.size >= 10, `only ${langs.size} languages`);
});

Deno.test("corpus: the regex false positives it was built to expose are real", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("./jev-moderation-cases.json", import.meta.url),
    ),
  );
  const byId = new Map<string, Case>(raw.cases.map((x: Case) => [x.id, x]));
  // Benign recipe text the production pre-filter rejects as "link or phone".
  for (
    const id of [
      "a-en-recipe-02",
      "a-en-recipe-04",
      "a-en-recipe-07",
      "a-en-recipe-09",
    ]
  ) {
    assert(
      containsObviousLinkOrPhone(byId.get(id)!.text),
      `${id} no longer trips the regex; update the corpus note`,
    );
  }
  assert(containsObviousLinkOrPhone(byId.get("b-contact-en-01")!.text));
  assert(!containsObviousLinkOrPhone(byId.get("b-contact-en-03")!.text));
});

Deno.test("question set is one batched call with the documented shapes", () => {
  const qs = JEV_MODERATION_QUESTIONS;
  assertEquals(Object.keys(qs), ["contact", "violation"]);
  assertEquals(qs.contact.type, "noul");
  assert(qs.violation.type === "choice");
  assert("acceptable" in qs.violation.criteria);
  assert(
    !("__none__" in qs.violation.criteria),
    "acceptable is the none option",
  );
  assertEquals(jevState(c("x", "allow", "none", "hi")).text, "hi");
});

Deno.test("violation mass sums only violation keys; profanity is a policy switch", () => {
  const r = row(c("x", "borderline", "profanity"), {
    violation: { acceptable: 0.3, profanity_only: 0.5, sexually_explicit: 0.2 },
  });
  assertEquals(jevViolation(r, "allow"), {
    mass: 0.2,
    category: "sexually_explicit",
  });
  assertEquals(jevViolation(r, "block")!.category, "profanity_only");
  assert(Math.abs(jevViolation(r, "block")!.mass - 0.7) < 1e-9);
});

Deno.test("decide: each pipeline composes the layers it claims to", () => {
  const t = DEFAULT_THRESHOLDS;
  // Regex false positive on a benign recipe; Jev says not contact.
  const fpRegex = decide(
    row(c("r", "allow"), {
      regex: true,
      legacyBlock: true,
      omni: false,
      contact: 0.05,
    }),
    t,
  );
  assertEquals(fpRegex.legacy, true);
  assertEquals(fpRegex.jev_replaces_secondary, true);
  assertEquals(fpRegex.jev_replaces_secondary_and_confirms_regex, false);
  assertEquals(fpRegex.jev_only, false);

  // Obfuscated contact omni cannot see; Jev catches it.
  const obf = decide(
    row(c("o", "block", "contact"), {
      legacyBlock: false,
      omni: false,
      contact: 0.9,
    }),
    t,
  );
  assertEquals(obf.legacy, false);
  assertEquals(obf.jev_replaces_secondary, true);
  assertEquals(obf.jev_replaces_omni_and_secondary, true);
  assertEquals(obf.legacy_with_jev_violation_layer, false);

  // Harm only Jev sees (e.g. a non-English slur omni misses).
  const harm = decide(
    row(c("h", "block", "hate_harassment"), {
      legacyBlock: false,
      omni: false,
      violation: { acceptable: 0.2, hateful_or_harassing: 0.8 },
    }),
    t,
  );
  assertEquals(harm.legacy_with_jev_violation_layer, true);
  assertEquals(
    harm.jev_replaces_secondary,
    false,
    "that pipeline keeps omni for harm",
  );
  assertEquals(harm.jev_replaces_omni_and_secondary, true);
});

Deno.test("decide: a failed arm is unknown, never a silent allow", () => {
  const d = decide(
    row(c("f", "block", "contact"), {
      legacyBlock: null,
      omni: false,
      jevFailed: true,
    }),
    DEFAULT_THRESHOLDS,
  );
  assertEquals(d.legacy, null);
  assertEquals(d.jev_only, null);
  assertEquals(d.jev_replaces_secondary, null);
  // ...but a definite block from another layer still wins.
  const d2 = decide(
    row(c("f2", "block", "contact"), {
      regex: true,
      jevFailed: true,
      omni: false,
    }),
    DEFAULT_THRESHOLDS,
  );
  assertEquals(d2.jev_replaces_omni_and_secondary, true);
  assertEquals(d2.jev_replaces_secondary_and_confirms_regex, null);
});

Deno.test("summarize: confusion, borderline exclusion, presumed-allow, cost", () => {
  const rows: Row[] = [
    row(c("tp", "block", "contact"), {
      legacyBlock: true,
      omni: false,
      contact: 0.9,
    }),
    row(c("fn", "block", "hate_harassment"), {
      legacyBlock: false,
      omni: false,
    }),
    row(c("fp", "allow"), {
      regex: true,
      legacyBlock: true,
      omni: false,
      contact: 0.1,
    }),
    row(c("tn", "allow"), { legacyBlock: false, omni: false }),
    row(c("bl", "borderline", "profanity"), { legacyBlock: true, omni: true }),
    row({ ...c("p1", "allow_presumed"), production: true }, {
      legacyBlock: false,
      omni: false,
      contact: 0.95,
    }),
  ];
  const s = summarize(rows);
  assertEquals(s.counts, {
    total: 6,
    scored: 4,
    borderline: 1,
    allow_presumed: 1,
  });
  const legacy = s.overall.legacy;
  assertEquals([legacy.tp, legacy.fn, legacy.fp, legacy.tn], [1, 1, 1, 1]);
  assertEquals(legacy.precision, 0.5);
  const confirm = s.overall.jev_replaces_secondary_and_confirms_regex;
  assertEquals([confirm.tp, confirm.fp], [1, 0], "regex FP removed");
  assertEquals(s.production_presumed_allow_block_rate.jev_only.blocked, 1);
  assertEquals(s.production_presumed_allow_block_rate.legacy.blocked, 0);
  assertEquals(s.jev_cost.input_tokens, 2400);
  assertEquals(s.threshold_sweep.length, 16);
  assertEquals(s.borderline.map((b) => b.id), ["bl"]);
});

Deno.test("disagreements withhold production text", () => {
  const rows = [
    row({
      ...c("p", "allow_presumed", "none", "real user text"),
      production: true,
    }, {
      legacyBlock: false,
      omni: false,
      contact: 0.99,
    }),
  ];
  const d = disagreements(rows);
  assertEquals(d.length, 1);
  assertEquals(d[0].text, "[production text withheld]");
});

Deno.test("validateCases names every schema problem", () => {
  const errors = validateCases([
    {
      id: "a",
      surface: "review",
      lang: "en",
      expect: "block",
      category: "none",
      text: "x",
    },
    {
      id: "a",
      surface: "tweet",
      lang: "",
      expect: "maybe",
      category: "rude",
      text: " ",
    },
    {
      id: "b",
      surface: "wish",
      lang: "en",
      expect: "allow",
      category: "sexual",
      text: "x",
    },
  ], "f.json");
  const joined = errors.join("\n");
  for (
    const want of [
      "a: a block case needs a category",
      "a: duplicate id",
      "a: surface",
      "a: lang",
      "a: expect",
      "a: text",
      "a: category must be one of",
      "b: an allow case has category none",
    ]
  ) assert(joined.includes(want), `missing: ${want}\n${joined}`);
  assertEquals(validateCases({ cases: [] }, "f.json"), [
    "f.json: expected an array of cases",
  ]);
});

Deno.test("redact removes held-out and production text and notes", () => {
  const held = row(
    { ...c("h", "block", "sexual", "secret"), heldout: true, note: "why" },
    { contact: 0.1 },
  );
  const r = redact(held);
  assertEquals(r.case.text, "[held-out text withheld]");
  assertEquals(r.case.note, undefined);
  assertEquals(held.case.text, "secret", "input not mutated");
  const plain = row(c("p", "allow", "none", "visible"), {});
  assertEquals(redact(plain).case.text, "visible");
  const d = disagreements([
    row({ ...c("h2", "block", "sexual", "secret"), heldout: true }, {}),
  ]);
  assertEquals(d[0].text, "[held-out text withheld]");
});

Deno.test("parseSafeguard accepts only the contracted verdict", () => {
  assertEquals(parseSafeguard('{"violation":1,"category":"contact"}'), {
    violation: 1,
    category: "contact",
  });
  assertEquals(parseSafeguard('{"violation": false}'), {
    violation: 0,
    category: "none",
  });
  assertEquals(parseSafeguard('{"violation":"yes"}'), null);
  assertEquals(parseSafeguard("not json"), null);
  assertEquals(parseSafeguard(undefined), null);
});

Deno.test("safeguardRequest: policy as system prompt, effort sets the budget", () => {
  const low = safeguardRequest(c("x", "allow", "none", "hello"), "low");
  assertEquals(low.model, SAFEGUARD_MODEL);
  assertEquals(low.messages[0].role, "system");
  assert(low.messages[1].content.endsWith("hello"));
  assertEquals([low.reasoning_effort, low.max_completion_tokens], ["low", 512]);
  const med = safeguardRequest(c("x", "allow"), "medium");
  assertEquals(med.max_completion_tokens, 1024);
});

Deno.test("safeguard pipelines: failure is unknown, profanity follows the switch", () => {
  const withSg = (
    violation: 0 | 1 | null,
    category: string | null,
    extra: Partial<Row> = {},
  ): Row => ({
    ...row(c("s", "block", "sexual"), { omni: false }),
    safeguard: {
      violation,
      category,
      effort: "low",
      error: violation === null ? "x" : null,
      latencyMs: 200,
      promptTokens: 400,
      completionTokens: 50,
    },
    ...extra,
  });
  assertEquals(
    decide(withSg(1, "sexual"), DEFAULT_THRESHOLDS).safeguard_only,
    true,
  );
  assertEquals(
    decide(withSg(null, null), DEFAULT_THRESHOLDS).safeguard_only,
    null,
  );
  assertEquals(
    decide(withSg(null, null, { regex: true }), DEFAULT_THRESHOLDS)
      .safeguard_replaces_secondary,
    true,
    "regex hit still blocks when safeguard fails",
  );
  const prof = withSg(0, "profanity");
  assertEquals(decide(prof, DEFAULT_THRESHOLDS).safeguard_only, false);
  assertEquals(
    decide(prof, { ...DEFAULT_THRESHOLDS, profanity: "block" }).safeguard_only,
    true,
  );
});

Deno.test("latencyStats percentiles and the 800 ms budget count", () => {
  const s = latencyStats([100, 200, 300, 400, 900]);
  assertEquals([s.n, s.p50, s.max, s.over_800ms], [5, 300, 900, 1]);
  assertEquals(latencyStats([]).p50, null);
});

Deno.test("latencyReport models sequential vs parallel and regex short-circuit", () => {
  const timed = (
    id: string,
    regex: boolean,
    omniMs: number,
    jevMs: number,
  ): Row => {
    const r = row(c(id, "allow", "none", "short"), { regex, omni: false });
    r.omni!.latencyMs = omniMs;
    r.jev!.latencyMs = jevMs;
    return r;
  };
  const rep = latencyReport([
    timed("a", false, 200, 300),
    timed("b", true, 200, 300),
  ]);
  const p = rep.pipelines_modelled;
  // Row a: sequential 500, parallel 300. Row b: regex hit, 0 ms.
  assertEquals(p.jev_replaces_secondary_sequential.max, 500);
  assertEquals(p.jev_replaces_secondary_parallel.max, 300);
  assertEquals(p.jev_replaces_secondary_sequential.n, 2);
  assertEquals(p.jev_replaces_omni_and_secondary.max, 300);
  const regexOnly = latencyReport([timed("b", true, 200, 300)])
    .pipelines_modelled;
  assertEquals(regexOnly.jev_replaces_secondary_sequential.max, 0);
  assertEquals(regexOnly.jev_replaces_omni_and_secondary.max, 0);
  // No legacy or safeguard timings: those pipelines are empty, not zero.
  assertEquals(p.safeguard_only.n, 0);
  assertEquals(p.legacy_with_jev_violation_layer_parallel.n, 0);
  assertEquals(Object.keys(rep.by_text_length), ["under_50_chars"]);
});
