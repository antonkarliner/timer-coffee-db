import {
  canonicalizeTranslationLocale,
  selectTerminologyByLocale,
  selectTranslationTerms,
  type TranslationSelectionDiagnostics,
} from "./translation-glossary.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

function findPreferred(
  text: string,
  locale: string,
  source: string,
): string | undefined {
  return selectTranslationTerms(text, locale).find((term) =>
    term.source === source
  )?.preferred;
}

Deno.test("canonicalizeTranslationLocale normalizes separators, case, and Android regions", () => {
  assertEquals(
    canonicalizeTranslationLocale(" zh_Hant_TW "),
    "zh-hant-tw",
    "underscore-separated script and region should be canonicalized",
  );
  assertEquals(
    canonicalizeTranslationLocale("en-rUS"),
    "en-us",
    "Android region marker should be removed",
  );
  assertEquals(
    canonicalizeTranslationLocale("PT-br"),
    "pt-br",
    "ordinary hyphenated locales should be lowercased",
  );
});

Deno.test("Brew Diary resolves to representative generated translations", () => {
  const cases = [
    ["fr", "Journal de préparation"],
    ["de", "Brühtagebuch"],
    ["ru", "Дневник заварок"],
    ["ja", "抽出日記"],
  ] as const;

  for (const [locale, expected] of cases) {
    assertEquals(
      findPreferred("Discover the new Brew Diary", locale, "Brew Diary"),
      expected,
      `Brew Diary should use the generated ${locale} translation`,
    );
  }
});

Deno.test("complete matching ignores case and repeated whitespace", () => {
  assertEquals(
    findPreferred(
      "Your BREW \n\t  DIARY has a new look",
      "fr",
      "Brew Diary",
    ),
    "Journal de préparation",
    "case and whitespace normalization should retain complete matches",
  );
});

Deno.test("Unicode-aware boundaries prevent substring matches", () => {
  assertEquals(
    findPreferred("Discover a new Roastery", "fr", "Roaster"),
    undefined,
    "Roaster must not match inside Roastery",
  );
  assertEquals(
    findPreferred("Meet your Roaster.", "fr", "Roaster"),
    "Torréfacteur",
    "punctuation should form a valid boundary",
  );
});

Deno.test("multi-word fallback requires two distinct significant complete words", () => {
  assertEquals(
    findPreferred(
      "See details about coffee",
      "fr",
      "Coffee Beans Details",
    ),
    "Détails des grains de café",
    "separated significant words should trigger the bounded fallback",
  );
  assertEquals(
    findPreferred(
      "A better diary search is here",
      "fr",
      "Brew Diary",
    ),
    undefined,
    "one significant word must not trigger the fallback",
  );
  assertEquals(
    findPreferred(
      "This is about your app, with more to come",
      "fr",
      "Brew Diary",
    ),
    undefined,
    "stopwords alone must not trigger the fallback",
  );
});

Deno.test("exact phrases suppress redundant longer fallback sentences", () => {
  const terms = selectTranslationTerms(
    "Explore Brew Diary, Coffee Beans, and Extraction yield",
    "fr",
  );
  const sources = new Set(terms.map((term) => term.source));

  for (
    const exactSource of [
      "Brew Diary",
      "Coffee Beans",
      "Extraction yield",
    ]
  ) {
    assert(
      sources.has(exactSource),
      `the exact ${exactSource} term should remain selected`,
    );
  }

  for (
    const redundantSource of [
      "Congratulations on your first brew! It has been saved to your Brew Diary.",
      "Could not save the coffee beans. Try again.",
      "Enter your brew details to see extraction yield",
      "Check your extraction yield and strength",
    ]
  ) {
    assert(
      !sources.has(redundantSource),
      `${redundantSource} should be suppressed when its matched words are covered by exact phrases`,
    );
  }
});

Deno.test("multi-word fallback uses complete Unicode words", () => {
  assertEquals(
    findPreferred(
      "Coffeehouse updates now include beanstock controls",
      "fr",
      "Coffee Beans Details",
    ),
    undefined,
    "significant words embedded inside longer words must not match",
  );
});

Deno.test("Timer.Coffee brand words do not amplify multi-word fallback", () => {
  for (
    const text of [
      "Timer.Coffee now includes Brew Diary",
      "TIMER \n . \t COFFEE now includes Brew Diary",
    ]
  ) {
    const sources = selectTranslationTerms(text, "fr").map((term) =>
      term.source
    );
    assertEquals(
      sources,
      ["Brew Diary"],
      "the brand phrase should not select yearly, welcome, get-app, or Brew Coffee fallback terms",
    );
  }
});

Deno.test("Timer.Coffee removal does not change exact complete-term matching", () => {
  const sources = selectTranslationTerms(
    "Welcome to Timer.Coffee",
    "fr",
  ).map((term) => term.source);

  assert(
    sources.includes("Welcome to Timer.Coffee"),
    "an exact catalog phrase containing Timer.Coffee should remain eligible",
  );
});

Deno.test("locale lookup uses exact canonical locales and then base language", () => {
  const exact = findPreferred("Open Brew Diary", "FR", "Brew Diary");
  const fallback = findPreferred("Open Brew Diary", "fr-rCA", "Brew Diary");

  assertEquals(
    exact,
    "Journal de préparation",
    "the canonical exact locale should resolve first",
  );
  assertEquals(
    fallback,
    exact,
    "a region-qualified locale should fall back to its base language",
  );
});

Deno.test("unmatched text and unsupported locales yield no terms", () => {
  assertEquals(
    selectTranslationTerms("Xylophonic zephyrs", "fr"),
    [],
    "unmatched text should not receive terminology",
  );
  assertEquals(
    selectTranslationTerms("Open Brew Diary", "xx-ZZ"),
    [],
    "unsupported locales should not borrow another regional translation",
  );
});

Deno.test("complete matches rank longer overlapping sources first", () => {
  const terms = selectTranslationTerms(
    "Explore Coffee Beans Details",
    "fr",
  );
  const detailsIndex = terms.findIndex((term) =>
    term.source === "Coffee Beans Details"
  );
  const beansIndex = terms.findIndex((term) => term.source === "Coffee Beans");

  assert(detailsIndex >= 0, "the longer complete phrase should match");
  assert(beansIndex >= 0, "the shorter overlapping phrase should match");
  assert(
    detailsIndex < beansIndex,
    "the longer complete phrase should sort before the shorter one",
  );
});

Deno.test("term limits are enforced deterministically and capped at 25", () => {
  const text =
    "Brew Diary, Coffee Beans Details, Grind Size, Cupping Score, Roaster, and Create Recipe";
  const first = selectTranslationTerms(text, "fr", 2);
  const second = selectTranslationTerms(text, "fr", 2);

  assertEquals(first.length, 2, "an explicit lower limit should be enforced");
  assertEquals(second, first, "limited output should be deterministic");
  assert(
    selectTranslationTerms(text, "fr", 100).length <= 25,
    "callers must not raise the hard per-locale cap",
  );
});

Deno.test("selected source/preferred pairs are deduplicated", () => {
  const terms = selectTranslationTerms(
    "Explore Coffee Beans Details in your Brew Diary",
    "fr",
  );
  const pairs = terms.map((term) =>
    JSON.stringify([
      term.source,
      term.preferred,
    ])
  );

  assertEquals(
    new Set(pairs).size,
    pairs.length,
    "identical source/preferred pairs should appear once",
  );
});

Deno.test("selectTerminologyByLocale preserves requested keys and empty unsupported lists", () => {
  const terminology = selectTerminologyByLocale(
    "Open Brew Diary",
    ["fr-FR", "xx"],
  );

  assert(
    Object.hasOwn(terminology, "fr-FR"),
    "the original region-qualified locale should remain the output key",
  );
  assertEquals(
    terminology["fr-FR"].find((term) => term.source === "Brew Diary"),
    {
      source: "Brew Diary",
      preferred: "Journal de préparation",
    },
    "the region-qualified locale should contain the base-language term",
  );
  assertEquals(
    terminology.xx,
    [],
    "an unsupported requested locale should have a stable empty list",
  );
});

Deno.test("multi-locale selection is equivalent to independent locale selection", () => {
  const text =
    "Explore Brew Diary, Coffee Beans Details, Grind Size, and Extraction yield";
  const locales = ["fr", "de", "ru", "ja", "fr-rCA", "xx"];
  const combined = selectTerminologyByLocale(text, locales, 7);

  for (const locale of locales) {
    assertEquals(
      combined[locale],
      selectTranslationTerms(text, locale, 7),
      `${locale} should preserve independent complete, fallback, overlap, locale-fallback, and unsupported-locale semantics`,
    );
  }
});

Deno.test("multi-locale selection classifies the catalog once", () => {
  const diagnostics: TranslationSelectionDiagnostics = { catalogScans: 0 };
  const terminology = selectTerminologyByLocale(
    "Explore Brew Diary and Coffee Beans Details",
    ["fr", "de", "ru", "ja", "es", "it"],
    25,
    diagnostics,
  );

  assertEquals(
    diagnostics.catalogScans,
    1,
    "catalog classification scans should be independent of locale count",
  );
  assertEquals(
    Object.keys(terminology),
    ["fr", "de", "ru", "ja", "es", "it"],
    "optimization should retain every requested locale key in order",
  );
});
