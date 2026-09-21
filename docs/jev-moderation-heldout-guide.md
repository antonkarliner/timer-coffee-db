# Writing the held-out moderation test set

The moderation evaluation (`docs/jev-moderation-evaluation.md`) has one known
flaw. Its 101-case corpus and the Jev instructions it tests were written in the
same session, and the instructions quote some of the corpus's tricky cases
word for word. A held-out set fixes that. It only works if the people writing
it have **not** seen the instructions.

## Where it goes

```
plans/034-moderation-heldout/            (private plans repo; plans/ is a symlink)
  heldout-v1-<author>.json               one file per author
```

Keep it there, not in `scripts/`. This repo is public, and anything committed
here is visible to whoever tunes the Jev instructions next.

## Rules for authors

1. **Don't read** `scripts/jev-moderation-eval.ts` (the instructions sit in
   `JEV_MODERATION_QUESTIONS`) or `scripts/jev-moderation-cases.json`. It's
   fine to read this guide and the app's content rules.
2. Write in a language you speak natively. The biggest gap is
   **ru, uk, pl, de and es** abuse and vulgarity, because that is where
   omni-moderation already misses cases.
3. Write text the way a real user would type it in the app: a bean review, a
   public recipe (name, description, grind, then one step per line), a
   display name, or a New Year greeting. Keep typos, slang and emoji. No
   textbook sentences.
4. Label from the **published rules**, not from your own taste. The rules
   are in the app's `moderationRulesBody`: links or contact details (including
   obfuscated ones), hateful or offensive content, explicit sexual content or
   graphic violence, and promotion of self-harm or dangerous activities.
5. If you have to think about a label, it is `borderline`. Borderline cases
   are reported but not scored.

## Case format

A JSON array. Every field is required unless marked optional.

```json
[
  {
    "id": "ho-ru-anna-001",
    "surface": "review",
    "lang": "ru",
    "expect": "block",
    "category": "hate_harassment",
    "text": "…",
    "heldout": true,
    "author": "anna",
    "note": "optional: why it is tricky"
  }
]
```

| Field | Values |
|---|---|
| `id` | `ho-<lang>-<author>-<nnn>`, unique across all files |
| `surface` | `review`, `recipe`, `display_name`, `wish` |
| `lang` | ISO 639-1 code (`ru`, `uk`, `pl` …) |
| `expect` | `allow`, `block`, `borderline` |
| `category` | `none` (all allow cases), `contact`, `hate_harassment`, `sexual`, `violence_graphic`, `self_harm_dangerous`, `profanity`, `spam`, `impersonation` |
| `heldout` | always `true`: the harness then never writes the text to its output |

## What to write (per author, per language)

At least 60 cases. The mix below matters more than the total:

| Kind | Count | Examples of what is wanted |
|---|---|---|
| Clean allow | 15 | Ordinary reviews, recipes, names, greetings |
| Hard allow | 15 | Things that *look* bad but aren't: violent or crude coffee slang, real names that are also swear words, profanity praising the coffee (label that `borderline`), numbers in recipes (ratios, pour ladders, `1:16.67`, `12-15 s`), roaster or cafe names without a contact channel |
| Contact block | 10 | Links, phones, emails and handles, **mostly obfuscated**: spelled-out digits, "dot com", "at gmail", split digits, in your own language's words |
| Harm block | 15 | Slurs and insults aimed at people or groups, sexual vulgarity, threats, incitement to self-harm, dangerous "recipes". Short and colloquial, as in real life ("сосал?" is a real rejected case) |
| Borderline | 5 | Profanity about the product, self-promotion with no link, impersonation ("Timer.Coffee Support"), drug references |

Aim for about a quarter of all cases to be `display_name`. It is the shortest,
most username-like surface, and that is where Jev's contact score was
least stable.

## Check, then run

```bash
# Schema check only, no network:
/opt/homebrew/bin/deno run --config scripts/jev-review-deno.json --no-lock \
  --allow-read --allow-env scripts/jev-moderation-eval.ts --validate \
  --cases plans/034-moderation-heldout/heldout-v1-anna.json

# Full run (all held-out files at once):
/opt/homebrew/bin/deno run --config scripts/jev-review-deno.json --no-lock \
  --allow-net=api.typesafe.ai,api.openai.com,api.groq.com \
  --allow-env --allow-read --allow-write --env-file=supabase/.env.local \
  scripts/jev-moderation-eval.ts --out "$SCRATCH/mod-heldout-1" \
  --cases plans/034-moderation-heldout/heldout-v1-anna.json \
  --cases plans/034-moderation-heldout/heldout-v1-piotr.json
```

The harness writes `[held-out text withheld]` in place of every held-out
case's text in `raw.jsonl` and `disagreements.json`. Read `summary.json`
and the case ids in `disagreements.json`. **Don't open the held-out files
to see why a case failed.** Ask the author, or put the case in a new set.

## When the set is used up

Changing the Jev instructions *because of* a held-out result turns that file
into training data. Rename it with a `-spent` suffix, note the date in
`docs/jev-moderation-evaluation.md`, and have a new round (`heldout-v2-…`)
written before the next decision.
