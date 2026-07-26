# Timer.Coffee translation glossary

The translation glossary grounds generated copy in the terminology already used
by Timer.Coffee. Its current consumer is the `translate-openai` Edge Function,
which translates launch popups.

## Sources and runtime behavior

- Source repository: `antonkarliner/timer-coffee`
- ARB directory: `lib/l10n`
- English master locale: `lib/l10n/app_en.arb`
- Generated output: `supabase/functions/_shared/app-terminology.generated.ts`

The generator pairs source and translated text by ARB key, filters unsafe or
incomplete entries, and records the resolved source commit SHA in the generated
module. Production translation never fetches GitHub. The generated module is
committed and bundled into the Edge Function's local import graph.

Do not edit the generated module directly. Translation corrections belong in the
Timer.Coffee ARBs and enter this repository through regeneration from a reviewed
commit SHA.

## Regenerate from the pinned source

From the `timer-coffee-db` repository root:

```bash
/opt/homebrew/bin/deno run --no-lock \
  --allow-net=api.github.com,raw.githubusercontent.com \
  --allow-env=GITHUB_TOKEN \
  --allow-write=supabase/functions/_shared/app-terminology.generated.ts \
  scripts/generate-translation-glossary.ts \
  --repo antonkarliner/timer-coffee \
  --ref f36fb42a76fb3277301ba5451d05f767340b0cde \
  --arb-dir lib/l10n \
  --output supabase/functions/_shared/app-terminology.generated.ts
```

Verify that the generated artifact is current:

```bash
/opt/homebrew/bin/deno run --no-lock \
  --allow-net=api.github.com,raw.githubusercontent.com \
  --allow-env=GITHUB_TOKEN \
  --allow-read=supabase/functions/_shared/app-terminology.generated.ts \
  scripts/generate-translation-glossary.ts \
  --repo antonkarliner/timer-coffee \
  --ref f36fb42a76fb3277301ba5451d05f767340b0cde \
  --arb-dir lib/l10n \
  --output supabase/functions/_shared/app-terminology.generated.ts \
  --check
```

GitHub's public API works without authentication. `GITHUB_TOKEN` is optional and
may be supplied for rate-limit relief. Never print or commit the token.

## Update and review procedure

1. Review the proposed Timer.Coffee ARB changes.
2. Select the exact source commit SHA to pin.
3. Review changes to eligibility counts and collision diagnostics. Add or revise
   `TRANSLATION_GLOSSARY_KEY_OVERRIDES` only when an ambiguous duplicate has one
   clearly authoritative ARB key.
4. Run the generator with the reviewed commit SHA.
5. Review the generated diff, including its source metadata and representative
   locale values. Never repair the generated file by hand.
6. Run the scoped tests, type-check, format check, and runtime GitHub-dependency
   check:

   ```bash
   /opt/homebrew/bin/deno test --no-lock \
     scripts/generate-translation-glossary_test.ts \
     supabase/functions/_shared/translation-glossary_test.ts \
     supabase/functions/translate-openai/translation-prompt_test.ts

   /opt/homebrew/bin/deno check --no-lock \
     supabase/functions/translate-openai/index.ts

   /opt/homebrew/bin/deno fmt --check \
     scripts/generate-translation-glossary.ts \
     scripts/generate-translation-glossary_test.ts \
     supabase/functions/_shared/translation-glossary-policy.ts \
     supabase/functions/_shared/app-terminology.generated.ts \
     supabase/functions/_shared/translation-glossary.ts \
     supabase/functions/_shared/translation-glossary_test.ts \
     supabase/functions/translate-openai/index.ts \
     supabase/functions/translate-openai/translation-prompt.ts \
     supabase/functions/translate-openai/translation-prompt_test.ts

   rg -n "github\\.com|raw\\.githubusercontent|api\\.github|GITHUB_TOKEN|fetch\\(" \
     supabase/functions/_shared/translation-glossary.ts \
     supabase/functions/_shared/app-terminology.generated.ts \
     supabase/functions/translate-openai/translation-prompt.ts
   ```

7. Deploy `translate-openai` only after the operator explicitly approves the
   deployment.

## Deferred work

Push notifications, recipe collections, and bean-review translations may adopt
the shared term selector later. They are not current glossary consumers.

A scheduled or repository-dispatch workflow may eventually open a reviewable
glossary-refresh pull request. Do not add that automation until the generated
artifact format is stable.
