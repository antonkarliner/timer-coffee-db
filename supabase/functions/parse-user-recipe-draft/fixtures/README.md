# parse-user-recipe-draft golden fixtures

## Why this exists

Seven phases of parser rework were verified by pasting transcripts into an
admin UI by hand and eyeballing the output. That process twice let a
regression ship inside a green test suite, because an existing expectation
was rewritten to match new (wrong) behaviour. The worst example: a Chemex
recipe came out as durations `[0, 45, 217, 10]` -- a 3m37s pour followed by
a 10-second drawdown, physically backwards -- and the test suite was green
because the expectation had been updated to match.

**A pure snapshot suite would have recorded that bug as "expected."** So
this suite is golden files **plus** explicit invariant assertions that
encode what is physically correct, independent of whatever the parser
currently emits. The goldens catch *unintentional* changes; the invariants
catch *intentional-looking but wrong* ones -- the kind that get typed
straight into the golden file during a routine "update the snapshot" pass.

## Structure

```
fixtures/
  README.md                 <- this file
  fixtures_test.ts           <- runs every case below (golden + invariants)
  cases/
    kalita/                  Kalita Wave: dose multipliers, equipment aside,
                              deterministic split, spoken-word total time
    hario_switch/             Hario Switch: pre-timer fold, verify-mode
                              step-count preservation
    chemex/                   Chemex: commentary-heavy, filter-weight
                              trivia, drawdown-longer-than-pour guard
    german_v60/                German V60: labelled fields, non-English
                              text, bloom-must-not-absorb-remainder guard
    cold_brew/                 Cold Brew: imperial units, 18h explicit
                              steep, inferred-duration cap, unsupported
                              method
    underspecified/            No amounts/temp/method/timings stated --
                              nothing may be fabricated
```

Each case directory holds:

- `source.txt` -- the (reconstructed) transcript, kept awkward on purpose:
  spoken numbers, mid-sentence commentary, equipment asides, pre-timer
  actions, labelled non-English fields. Real transcripts are messy; a
  fixture that isn't messy doesn't exercise the code that has to cope with
  messy input.
- `extraction.json` -- the stubbed `ExtractionResult` a good extraction-
  stage LLM call would return for that transcript.
- `normalized.json` (Kalita instead has `normalized.variant-{a,b,c}.json`
  -- see below) -- the stubbed `NormalizedDraft` a good normalization-stage
  LLM call would return.
- `request.json` -- the rest of `RecipeDraftParserInput` (`userId`,
  `brewingMethods`, `requestId`, optional `mode`). `text` is injected from
  `source.txt` at load time, not duplicated here. Hario Switch additionally
  has `request.verify.json` for the `mode: "verify"` case.
- `golden.json` -- the recorded `ParseUserRecipeDraftResponse`, with the
  two genuinely-random UUID fields (`publish_projection
  .user_recipe_localization.id` and each `publish_projection
  .user_steps[].id`) replaced with the placeholder `"<random-uuid>"` so the
  file is stable across runs. (`user_recipe.id` is NOT random -- it's
  `usr-${userId}-${nowMs}`, deterministic under the fixed clock all fixture
  runs use -- and compares exactly.)

`fixtures_test.ts` never makes a network call: every case is driven through
`createRecipeDraftParser` with a stub `RecipeDraftAiProvider` that returns
the case's `extraction.json`/`normalized.json` verbatim (mirroring the
`createMockProvider` pattern already used in `../parser_test.ts`). Repair
and cumulative_rewrite are deliberately left unstubbed for every case here
-- none of these fixtures need them, and an unstubbed stage fails closed
(rejects, gets logged, `parseDraft` carries on with what it already had)
rather than silently fabricating a repaired/rewritten draft.

## Regenerating goldens

```sh
cd supabase/functions/parse-user-recipe-draft
UPDATE_GOLDENS=1 deno test --allow-all fixtures/fixtures_test.ts
```

This is a **deliberate, visible act**: it overwrites every `golden.json` in
`fixtures/cases/*/` with whatever `parseDraft` currently returns for that
case's stubbed extraction/normalization. Review the diff before committing
it, the same as you would review any other generated file.

## Regenerating is never a substitute for checking the invariants

`fixtures_test.ts` is written so this is enforced mechanically, not just by
convention: **every invariant assertion for a case runs before that case's
`checkGolden(...)` call**, including while `UPDATE_GOLDENS=1` is set. If an
invariant throws, the golden write for that case never happens -- a
regenerated `golden.json` can only ever contain a result that already
passed every invariant below. This was verified directly while building
this suite: mutating the Chemex fixture to reproduce the shape of the
historical `[0, 45, 217, 10]` bug (drawdown shorter than its pour) and
re-running with `UPDATE_GOLDENS=1` fails the test and leaves `golden.json`
on disk untouched, rather than quietly encoding the bug as the new
"expected" output.

If you're regenerating goldens because you changed `parser.ts` on purpose,
**you still need to read the failing/changed invariant, understand why the
new output satisfies it, and update the invariant itself (not just accept
new numbers)** if the physical model it encodes has genuinely changed. A
diff that only touches `golden.json` and turns the suite green again is not
evidence the change is correct -- that is exactly the failure mode this
suite exists to prevent.

## The invariants, and what each one guards against

Encoded as named assertions in `fixtures_test.ts`, with the physical
reasoning in the assertion message itself, not just a bare equality check:

1. **No zero-collapse** (`assertNoZeroCollapse`, every case) -- no emitted
   `description_template`/`preview_text` ever contains `(0 x ` for a
   nonzero source amount.
2. **No canned sentences** (`assertNoCannedSentences`, every case; detail-
   survival checks on Chemex) -- step text never matches the deleted
   overfit rewrites (`consistent pour pattern`, `spiraling from the center
   out and back`, `same pouring pattern, then pause`), and real source
   detail (temperatures, technique wording, "avoiding the filter walls")
   survives into the template instead of being discarded.
3. **Equipment capacities/product specs are not scaled**
   (`assertAmountNeverScaled`, Kalita + Chemex) -- the Gabi Dripmaster's
   120ml reservoir and the Chemex/Hario filter paper weights (4.5g/1.5g)
   never appear as a `preview_value` inside a scalable expression, checked
   structurally against `step.expressions`, not just by eyeballing text.
4. **Rates are not scaled** (`assertRateStaysLiteral`, Kalita + Chemex) --
   "N grams a second" pour-rate asides stay completely literal.
5. **Drawdown is longer than the pour that precedes it** (Chemex) -- the
   direct regression guard for the `[0, 45, 217, 10]` bug class. Verified
   to actually catch that bug shape (see above).
6. **Durations sum exactly to the resolved total**
   (`assertDurationsSumToResolvedTotal`, every case with a resolved total)
   when a total is resolved and the remainder fits.
7. **Explicit long durations are never clamped** (Cold Brew) -- the 18-hour
   (64800s) steep passes through untouched even though it is far past the
   300s inferred-duration cap; only durations the parser itself infers may
   be capped, proven here by also checking the inferred "strain" step *is*
   capped at 300s.
8. **Determinism** (Kalita, dedicated test) -- the same fixture run through
   three different stubbed model duration splits (the real production
   numbers `[67,10,67,66]`, `[45,45,90,30]`, `[10,10,180,10]`) produces
   byte-identical final durations. This is the per-step-variance guard:
   without it, re-running the identical transcript through the identical
   parser could legitimately produce a different (but equally "passing")
   answer every time.
9. **Non-English recipes never gain English text** (German V60) -- no step
   acquires "Wait for the complete drawdown." or other synthesized English,
   and the bloom (which historically once absorbed a 130s remainder it had
   no business absorbing) survives at its stated 30s while the drawdown,
   not the bloom, absorbs the deficit.
10. **Nothing is fabricated** (Under-specified) -- `coffee_amount`,
    `water_amount`, and `brewing_method_id` all come back `null`,
    `is_publishable: false`, and no `publish_projection`.
11. **Unsupported methods are not coerced** (Cold Brew) --
    `brewing_method_id` stays `null` even though the normalized stub
    deliberately supplies a *contradicting* id (`french_press`) to prove
    the rejection guard, not just an absent one.
12. **Verify-mode step count is preserved** (Hario Switch, dedicated test)
    -- running the same 6-step normalized draft through `mode: "verify"`
    returns all 6 steps (no pre-timer folding), while the default/`extract`
    mode folds the two pre-timer actions into preparation and returns 4.
    As of this writing this **passes**: `finalizeDraftResponse` threads
    `mode` through as `preserveStepCount = mode === "verify"`, and
    `foldPreTimerStepsIntoPreparation`'s caller consults it. If this
    regresses in the future (i.e. that gate gets removed or bypassed), do
    **not** fix `parser.ts` from inside this fixture suite and do not
    weaken the assertion -- re-`Deno.test.ignore` it with a comment
    pointing at plan 010 §3, and report it prominently, exactly the way it
    would have been reported here if it had still been failing when this
    suite was written.

## Adding a new case

1. Add `fixtures/cases/<name>/source.txt`, `extraction.json`,
   `normalized.json`, and `request.json` (see an existing case for shape).
2. Add a `Deno.test` block in `fixtures_test.ts` that loads the case, runs
   every invariant that applies to it, and only then calls
   `checkGolden("<name>", result)`.
3. Run `UPDATE_GOLDENS=1 deno test --allow-all fixtures/fixtures_test.ts`
   once to create `golden.json`, then re-run without the flag to confirm it
   reproduces.
