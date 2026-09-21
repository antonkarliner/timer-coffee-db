# Plan 034 follow-up: Jev in text moderation

Status 2026-09-21: **shipped.** Jev is the primary text classifier in
`content-moderation` and `submit-yearly-wish`; the old regex -> omni ->
Groq/Gemini chain is now the fallback for when Jev is unavailable. See
"What shipped" at the end of this document. The sections below are the
evaluation that led to that decision and are kept as the record.

Plan 034 put moderation out of scope ("a third opinion without a clear gap to
fill"). Reviewing the current functions turned up three concrete gaps, listed
below. The third is the one that matters most.

## What production does today

`content-moderation` (text branch) → `_shared/moderation.ts`:

1. **Regex pre-filter**: `URL_REGEX` / `PHONE_REGEX`. A hit blocks with
   "Detected link or phone number".
2. **omni-moderation** (`OPENAI_API_KEY_NON_PERSONAL`). Harm categories only.
   It does not look for contact details.
3. **Secondary link/phone check** (a yes/no classifier built on a
   generative model): Groq `openai/gpt-oss-20b` → Groq
   `llama-3.1-8b-instant` → Gemini. The Gemini fallback also runs its own
   harm checks. Output is parsed from JSON, and an invalid reply moves on to
   the next provider. **Changed 2026-09-19** (working tree, not deployed):
   `compound-mini` (soon deprecated) was replaced by `gpt-oss-20b`, and
   Cerebras was removed. gpt-oss needs `reasoning_effort: "low"` and 256
   completion tokens. With the old 32-token budget it returned 400
   `json_validate_failed` on all 6 probe calls.

Callers (timer-coffee app): display name, public recipe (combined name,
description, grind and steps), bean review text, plus `submit-yearly-wish`
server-side. Profile pictures go through omni-moderation's image mode. Jev
cannot take images, so the image path stays out of scope. The legacy
`content-moderation-gemini` endpoint has not been called since 2026-05-25,
and `content-moderation` has served 52 users in the last 30 days (about 9
calls a day).

A rejection has **no appeal** (the app's content rules say so), and the
`reason` string is shown to the user. False positives therefore cost more
than the low traffic suggests.

## Gaps found

1. **The phone regex blocks real recipes.** A Postgres approximation of
   `PHONE_REGEX` matches 4 of the 118 live public recipes, on strings like
   `1:16.6666667` and `40-(3.2`. Those authors could not re-publish today
   without rewording. The corpus reproduces the shapes, and
   `jev-moderation-eval_test.ts` checks that the real JS regex still trips on
   them.
2. **Step 3 is a generative model making a yes/no call.** This is the
   pattern plan 034 targets. Four providers are chained to get one boolean,
   parsing can fail, and the model was `compound-mini`, a tool-using agent.
   The eval also contains a JSON-shaped injection aimed at this step
   (`b-inject-en-03`).
3. **omni-moderation misses harm that the pipeline never re-checks.** It
   missed 7 of 26 harm cases in all 3 runs: both real production rejections
   ("ты гей", "сосал?"), a French slur, a Spanish sexual display name, "Women
   Belong In Kitchens", and both dangerous recipes (caffeine powder, bleach).
   The Groq step only asks about contact details. Gemini's harm checks run
   only when every Groq model fails, which is presumably how the two Russian
   wishes were rejected in January. With Groq healthy, **all 7 would be
   published today.** Jev flagged all 7 in every run (harm mass 0.76–1.0).

## Options under test (`PIPELINES` in the harness)

| Pipeline | Composition |
|---|---|
| `legacy` | Production `moderateText`, unmodified |
| `legacy_with_jev_violation_layer` | legacy OR Jev harm |
| `jev_replaces_secondary` | regex OR omni OR Jev contact |
| `jev_replaces_secondary_and_confirms_regex` | (regex AND Jev contact) OR omni OR Jev contact |
| `jev_replaces_omni_and_secondary` | regex OR Jev contact OR Jev harm |
| `jev_only` | Jev contact OR Jev harm |
| `safeguard_replaces_secondary` | regex OR omni OR gpt-oss-safeguard |
| `safeguard_only` | gpt-oss-safeguard alone (one call, harm and contact) |

Jev makes one batched call per text: `contact` (noul) and `violation` (choice
across the four policy categories, plus `acceptable` and `profanity_only`).
The profanity policy is a switch (`--profanity allow|block`), because the
published rules do not mention it.

`openai/gpt-oss-safeguard-20b` (Groq) is the second candidate. It is a
classifier that takes a written policy as its prompt (`SAFEGUARD_POLICY`,
with the same rules and examples as the Jev rubric) and returns one
`{violation, category}` verdict per call. Probe, 2026-09-19: `json_object`
works at any effort. **Low effort is not deterministic at temperature 0**:
"сосал?" came back `sexual` once and `none` once from the same request.
Medium effort agreed with itself on 2 of 2 tries, but took up to 775 ms and
556 completion tokens.

## Files

- `scripts/jev-moderation-cases.json`: 101 hand-written cases in 13
  languages. There are 49 allow cases (with hard negatives: coffee violence
  idioms, the Scunthorpe problem, "geil", "zajebista", and recipe numbers
  that trip the regex), 43 block cases (contact, hate, sexual, violence,
  self-harm, injection) and 9 borderline cases. There is no production text,
  apart from the two rejected Russian wishes, which are 2–6 characters and
  carry no identity.
- `scripts/jev-moderation-eval.ts`: runs the arms and computes confusion
  matrices by pipeline, language, category and surface, plus a threshold
  sweep, latency, cost and a disagreement list. A failed arm counts as
  `unknown`, never as an allow.
- `scripts/jev-moderation-eval_test.ts`: 15 offline tests (corpus integrity,
  regex facts, composition logic, scoring, safeguard parsing, latency
  modelling, and withholding production and held-out text).
- `scripts/jev-moderation-snapshot.sql`: read-only export of live reviews,
  150 display names, public recipes and approved wishes as `allow_presumed`.
  Use it only for "how often would a candidate *newly* block real content".
  The data is biased in favour of legacy, so it gives no recall number.
- `_shared/moderation.ts`: `containsObviousLinkOrPhone` is exported, so the
  harness tests the production regex instead of a copy. As of 2026-09-21 this
  file also holds the shipped pipeline and the Jev prompt itself — see "What
  shipped" below.

## Results on the synthetic corpus (laptop, 2026-09-19)

43 block and 49 allow cases, thresholds 0.5/0.5, profanity allowed.

| Pipeline | TP | FP | FN | Notes |
|---|---|---|---|---|
| `legacy` (gpt-oss-20b chain) | 34 | 6 | 9 | 1 run |
| `legacy_with_jev_violation_layer` | 41 | 6 | 2 | |
| `jev_replaces_secondary_and_confirms_regex` | 36 | 0–1 | 7 | keeps omni's harm misses |
| `jev_replaces_omni_and_secondary` | 43 | 4–5 | 0 | FPs are the regex |
| `jev_only` | 43 | 0–1 | 0 | 5 runs |
| `safeguard_replaces_secondary` (low) | 43 | 4 | 0 | FPs are the regex |
| `safeguard_only`, low effort | 41–43 | 0–1 | 0–2 | 3 runs: 43/0/0, 41/1/2, 42/1/1 |
| `safeguard_only`, medium effort | 42 | 0 | 1 | missed `b-sexual-es-01` (said `profanity`) |

**Safeguard at low effort is not stable across identical runs.** Three
cases changed verdict over 3 runs, and they are exactly the short, vulgar,
non-English texts that omni already misses:

| Case | Expect | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|
| `b-sexual-ru-01` "сосал?" (real production rejection) | block | 1 sexual | **0 none** | **0 profanity** |
| `b-sexual-es-01` "Chupapollas Cafetero" | block | 1 hate | **0 profanity** | 1 profanity (self-contradictory) |
| `a-en-name-02` `espresso_addict_1987` | allow | 0 none | **1 contact** | **1 contact** |

Jev, over 5 runs, had one borderline answer (`espresso_addict_1987`,
p(contact) 0.45–0.50), and a threshold can absorb that. Safeguard returns a
bare 0/1, so there is nothing to tune. Medium effort was tried once and
missed the Spanish case, so more effort alone does not look like the fix.

Apart from safeguard's instability, the synthetic corpus is saturated: every
Jev and safeguard setup lands at or near a perfect score, so it cannot rank
them. Only the held-out set can. Both put all five profanity cases in the `profanity`
category, both leave the impersonation and self-promotion cases alone, and
both call "you're gay lol" hateful.

Legacy with gpt-oss-20b: 71 of 71 Groq calls answered on the first try (no
fallback, no 429). What legacy gets wrong:
- **Misses (9):** omni's 7 harm misses (see Gaps §3), plus 2 obfuscated
  handles gpt-oss did not catch (`b-contact-en-10` "telegram, username
  coffeelover77", `b-contact-ru-01` "телеграм, ник кофеман_77").
- **False blocks (6):** the 4 regex recipes, `espresso_addict_1987`
  (gpt-oss called it contact), and "Убойная обжарка" ("killer roast")
  flagged as violence by omni. omni flagged that one in only 1 of 4 runs, so
  omni is not fully deterministic either.

Jev's margins over 4 runs: the only unstable answer is
`espresso_addict_1987`, with p(contact) between 0.45 and 0.50. At a 0.5
threshold it flips. Every real contact case scored at least 0.83, so a
**0.7 contact threshold** loses nothing here. The weakest harm block was
"Women Belong In Kitchens" (mass 0.74–0.79). All five profanity borderline
cases landed on `profanity_only` (0.73–0.91).

**None of this is decision-grade yet.** The corpus and both rubrics were
written in the same session, and the rubrics quote three of the corpus's
tricky allow cases. Next:

1. A **held-out** set written blind by native speakers (see
   `docs/jev-moderation-heldout-guide.md`).
2. The production snapshot for the new-false-block rate. This sends live
   user text to TypeSafe, a new processor, so it needs an operator decision
   first (plan 034 open question 3). Display names are the surface to watch.

## Latency

### Production today (`function_edge_logs`, 2026-09-14 to 09-18, compound-mini chain)

21 calls, all status 200: **p50 ≈ 2.6 s, p90 ≈ 4.2 s, max 5.1 s**, served
from 5 edge regions (sa-east-1, eu-central-1, us-west-1, ap-southeast-2,
eu-west-3). That is several times what the moderation layers cost on their
own (below). Most of it is function overhead: `auth.getUser`, a read and a
write to `service.moderation_rate_limits`, possibly cross-region round trips
to the database, and cold starts. The function does not log stage timings,
so this cannot be split yet. **Swapping the classifier cannot fix most of
the 2.6 s.** The next latency step is to add stage timings (auth,
rate limit, regex, omni, secondary) to `content-moderation` and read them
from `function_logs`.

### Per layer and per pipeline (harness, laptop, all arms concurrent)

The harness times every layer per case and models each pipeline from those
timings (`latencyReport`: sequential vs. parallel, regex short-circuits at
0 ms, by text length). Groq pacing happens before the timer starts.

| Layer | p50 | p95 | >800 ms |
|---|---|---|---|
| legacy `moderateText` (regex → omni → gpt-oss-20b) | 419 | 619 | 1/101 |
| omni-moderation | 227 | 496 | 1/101 |
| Jev (2 questions) | 430 | 509 | 0/101 |
| gpt-oss-safeguard, low effort | 210 | 391 | 0/101 |
| gpt-oss-safeguard, medium effort (separate run) | 285 | 562 | 3/101 |

From the run with every arm (low effort), end-to-end per pipeline, modelled:

| Pipeline | p50 | p95 | >800 ms |
|---|---|---|---|
| legacy `moderateText`, measured | 486 | 757 | 5/101 |
| `jev_replaces_secondary`, sequential | 682 | 947 | 19/101 |
| `jev_replaces_secondary`, parallel | 430 | 549 | 0/101 |
| `jev_replaces_omni_and_secondary` | 427 | 531 | 0/101 |
| `safeguard_replaces_secondary`, sequential | 467 | 768 | 4/101 |
| `safeguard_replaces_secondary`, parallel | 262 | 526 | 0/101 |
| `safeguard_only` | 210 | 391 | 0/101 |

Text length made no visible difference (all cases are under 300 chars).
Completion tokens for safeguard: low p50 72 / max 427, medium p50 145 /
max 714.

Throughput limit: Groq on_demand checks prompt + `max_completion_tokens`
against 8,000 TPM per model before running a request. Safeguard at low
effort reserves about 450 + 512 tokens, which allows roughly 8 calls a
minute across the whole org. That is fine for about 9 calls a day, but a
burst would fall back. Jev publishes no rate limit.

Jev measured 259 ms p50 when run alone and 430 ms with all arms running
concurrently from the same laptop. Compare arms within one run, not across
runs. Edge-region timings will differ from both.

## Run

```bash
/opt/homebrew/bin/deno run --config scripts/jev-review-deno.json --no-lock \
  --allow-net=api.typesafe.ai,api.openai.com,api.groq.com \
  --allow-env --allow-read --allow-write --env-file=supabase/.env.local \
  scripts/jev-moderation-eval.ts --out "$SCRATCH/mod-eval" [--arms legacy,omni,jev,safeguard] [--safeguard-effort low|medium]
/opt/homebrew/bin/deno test --no-lock --config scripts/jev-review-deno.json \
  --allow-read --allow-env scripts/jev-moderation-eval_test.ts
```

## What shipped (2026-09-21)

Two held-out sets were run after the section above was written, both written
without sight of `JEV_MODERATION_QUESTIONS`:
`plans/034-moderation-heldout/glm-multilingual-2026-09-20` (864 cases across
de, el, en, es, fa, fi, pl, pt, ro, tr, ru and uk) and
`.../codex-multilingual-2026-09-20` (300 cases across ar, fr, it, ja and zh).
17 languages, 1,164 cases, 1,067 scored once borderline cases are excluded.
All three source files are now marked `-spent`.

`jev_only` won on both sets independently. Across the combined set, sweeping
the contact threshold:

| contact | violation | Precision | Recall | FPR | TP | FP | FN | TN |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.5 | 0.5 | 0.924 | 0.897 | 0.062 | 435 | 36 | 50 | 546 |
| 0.6 | 0.5 | 0.956 | 0.891 | 0.034 | 432 | 20 | 53 | 562 |
| **0.7** | **0.5** | **0.988** | **0.878** | **0.009** | 426 | 5 | 59 | 577 |
| 0.8 | 0.5 | 0.995 | 0.866 | 0.003 | 420 | 2 | 65 | 580 |

The legacy chain on the same cases: precision 0.704, recall 0.755, FPR 0.274,
with 244 arm errors against zero Jev failures.

**Shipped configuration**, in `_shared/moderation.ts`:

- Contact 0.7, violation 0.5, profanity `allow`. 0.7 rather than 0.5 because a
  rejection has no appeal: it trades 9 true positives for 31 fewer false
  blocks. It is also the threshold the synthetic-corpus section above already
  argued for, on independent grounds (`espresso_addict_1987`).
- **No regex in the primary path.** It contributed false positives and no true
  positives on both held-out sets. It survives only inside the fallback, where
  it costs nothing until Jev is already down.
- Fallback on *any* Jev failure — missing key, timeout, non-2xx, unparseable
  or off-contract body, or answers of the wrong type — is the full previous
  pipeline, never a silent allow. `jevAsk` already returns `null` rather than
  throwing for all of these, and logs the `jev_fallback` marker.
- Harm outranks contact in the user-facing `reason` when both trip.
- `MODERATION_JEV_ENABLED=false` forces the fallback without a code change;
  `MODERATION_JEV_TIMEOUT_MS` (default 800) sets the per-call deadline.
- `prewarmJevConnection()` runs unawaited at the top of both functions, after
  request validation, so the Jev call does not spend its budget on the TLS
  handshake (~654 ms cold vs ~246 ms warm from the edge).

`JEV_MODERATION_QUESTIONS` moved from `scripts/jev-moderation-eval.ts` into
`_shared/moderation.ts` **unchanged**; the harness now imports it, so it can
never measure a prompt different from the one production sends. `jevViolation`
in the harness now calls production's `jevViolationMass` for the same reason.

### What is still open

- **The surface label.** The Jev state carries `where_it_appears`, and the
  four evaluated labels are the only ones with numbers behind them.
  `submit-yearly-wish` sends `wish`. `content-moderation` serves several
  surfaces behind one payload and the app does not send one today, so it
  accepts an optional `surface` field and otherwise falls back to a generic
  label that **was never evaluated**. Teaching the app to send `surface`
  (`review`, `recipe`, `display_name`) is the next change.
- **Recall is 0.878, not 1.0.** 59 held-out block cases pass. Per the
  held-out guide, the case IDs may be reviewed but the source text must not be
  read by anyone who will then edit the rubric.
- **Production latency.** The 2.6 s p50 measured on `function_edge_logs` is
  mostly function overhead, not classification. Stage timings still are not
  logged, so the effect of this change on end-to-end latency has to be read
  from `function_edge_logs` after deploy.
- Neither held-out set satisfies the guide's native-human-author requirement:
  both were AI-authored. They are strong directional evidence across 17
  languages, not a substitute for the native-speaker sets the guide asks for.
