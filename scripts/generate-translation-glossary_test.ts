import {
  type ArbCatalogFile,
  assertPinnedSnapshot,
  buildGlossaryCatalog,
  generatedContentIsCurrent,
  type GlossaryCatalog,
  localeFromArbFilename,
  parseCliArgs,
  serializeGeneratedModule,
} from "./generate-translation-glossary.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

function assertThrows(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(includes),
      `Expected error containing "${includes}", received "${message}"`,
    );
    return;
  }
  throw new Error(`Expected error containing "${includes}"`);
}

function files(
  en: Record<string, unknown>,
  de: Record<string, unknown>,
  fr: Record<string, unknown>,
): ArbCatalogFile[] {
  return [
    { name: "app_fr.arb", messages: fr },
    { name: "app_en.arb", messages: en },
    { name: "app_de.arb", messages: de },
  ];
}

Deno.test("extracts and canonicalizes locales only from ARB filenames", () => {
  assertEquals(localeFromArbFilename("app_pt_BR.arb"), "pt-br");
  assertEquals(localeFromArbFilename("app_zh-Hant.arb"), "zh-hant");
  assertEquals(localeFromArbFilename("notes.json"), null);
});

Deno.test("pairs source and targets by key and ignores metadata keys", () => {
  const catalog = buildGlossaryCatalog(files(
    {
      "@@locale": "en",
      "@brew": { description: "Metadata" },
      brew: "Brew Diary",
      grind: "Grind Size",
    },
    { brew: "Brühtagebuch", grind: "Mahlgrad" },
    { brew: "Journal de préparation", grind: "Taille de mouture" },
  ));

  assertEquals(catalog.locales, ["de", "en", "fr"]);
  assertEquals(catalog.diagnostics.englishMessageKeyCount, 2);
  assertEquals(catalog.entries.map(({ key }) => key), ["brew", "grind"]);
  assertEquals(catalog.entries[0].translations, {
    de: "Brühtagebuch",
    fr: "Journal de préparation",
  });
});

Deno.test("excludes unsafe and incomplete messages with deterministic reasons", () => {
  const long = "x".repeat(81);
  const catalog = buildGlossaryCatalog(files(
    {
      nonString: 12,
      blank: " ",
      short: "Yes",
      long,
      sourceBrace: "Hello {name}",
      missing: "Coffee Beans",
      nonStringTarget: "Coffee Rating",
      absentTarget: "Coffee Roaster",
      targetBrace: "Brew Diary",
      valid: "Grind Size",
    },
    {
      nonString: "zwölf",
      blank: "leer",
      short: "Ja",
      long,
      sourceBrace: "Hallo",
      missing: "",
      nonStringTarget: 42,
      absentTarget: "Kaffeerösterei",
      targetBrace: "Tagebuch {name}",
      valid: "Mahlgrad",
    },
    {
      nonString: "douze",
      blank: "vide",
      short: "Oui",
      long,
      sourceBrace: "Bonjour",
      missing: "Grains de café",
      nonStringTarget: "Note du café",
      targetBrace: "Journal",
      valid: "Taille de mouture",
    },
  ));

  assertEquals(catalog.entries.map(({ key }) => key), ["valid"]);
  assertEquals(catalog.diagnostics.exclusionCounts, {
    sourceNotString: 1,
    sourceEmpty: 1,
    sourceTooShort: 1,
    sourceTooLong: 1,
    sourceHasBraces: 1,
    localeValueMissing: 3,
    targetHasBraces: 1,
  });
});

Deno.test("collapses consistent duplicate translations with sorted provenance", () => {
  const catalog = buildGlossaryCatalog(files(
    { second: " Brew   Diary ", first: "brew diary" },
    { second: "Brühtagebuch", first: " brühtagebuch " },
    {
      second: "Journal de préparation",
      first: "journal de préparation",
    },
  ));

  assertEquals(catalog.diagnostics.eligibleKeyCount, 2);
  assertEquals(catalog.diagnostics.normalizedSourceCount, 1);
  assertEquals(catalog.diagnostics.ambiguousCollisionCount, 0);
  assertEquals(catalog.entries.length, 1);
  assertEquals(catalog.entries[0].key, "first");
  assertEquals(catalog.entries[0].sourceKeys, ["first", "second"]);
});

Deno.test("omits conflicting duplicates unless a reviewed override selects a key", () => {
  const fixture = files(
    { noun: "Beans", verb: "beans" },
    { noun: "Bohnen", verb: "bohnt" },
    { noun: "Grains", verb: "haricots" },
  );
  const omitted = buildGlossaryCatalog(fixture);
  assertEquals(omitted.entries, []);
  assertEquals(omitted.diagnostics.ambiguousCollisionCount, 1);

  const selected = buildGlossaryCatalog(fixture, { beans: "noun" });
  assertEquals(selected.diagnostics.ambiguousCollisionCount, 1);
  assertEquals(selected.diagnostics.appliedOverrideCount, 1);
  assertEquals(selected.entries[0].key, "noun");
  assertEquals(selected.entries[0].sourceKeys, ["noun", "verb"]);
  assertEquals(selected.entries[0].translations.fr, "Grains");
});

Deno.test("rejects missing, invalid, and non-conflicting overrides", () => {
  const fixture = files(
    { noun: "Beans", verb: "beans", brew: "Brew Diary" },
    { noun: "Bohnen", verb: "bohnt", brew: "Brühtagebuch" },
    { noun: "Grains", verb: "haricots", brew: "Journal" },
  );
  assertThrows(
    () => buildGlossaryCatalog(fixture, { beans: "missing" }),
    "is not in duplicate group",
  );
  assertThrows(
    () => buildGlossaryCatalog(fixture, { absent: "noun" }),
    "does not select a conflicting duplicate group",
  );
  assertThrows(
    () => buildGlossaryCatalog(fixture, { "brew diary": "brew" }),
    "does not select a conflicting duplicate group",
  );
});

Deno.test("serialization is byte-identical and deterministically ordered", () => {
  const catalog = buildGlossaryCatalog(files(
    { zebra: "Zebra Term", alpha: "Alpha Term" },
    { zebra: "Zebra DE", alpha: "Alpha DE" },
    { zebra: "Zebra FR", alpha: "Alpha FR" },
  ));
  const source = {
    repository: "owner/repo",
    commit: "abcdef",
    arbDirectory: "lib/l10n",
  };
  const first = serializeGeneratedModule(source, catalog);
  const second = serializeGeneratedModule(
    source,
    buildGlossaryCatalog(files(
      { alpha: "Alpha Term", zebra: "Zebra Term" },
      { alpha: "Alpha DE", zebra: "Zebra DE" },
      { alpha: "Alpha FR", zebra: "Zebra FR" },
    )),
  );
  assertEquals(first, second);
  assert(first.indexOf('"alpha"') < first.indexOf('"zebra"'));
  assert(first.includes('"commit": "abcdef"'));
  assert(first.includes("// Generated file. Do not edit manually."));
  assert(first.startsWith("// deno-fmt-ignore-file\n"));
});

Deno.test("check comparison detects a mutated generated file", () => {
  assert(generatedContentIsCurrent("same", "same"));
  assert(!generatedContentIsCurrent("mutated", "generated"));
});

Deno.test("CLI arguments have stable defaults and validation", () => {
  assertEquals(
    parseCliArgs([
      "--repo",
      "owner/repo",
      "--ref",
      "main",
      "--output",
      "out.ts",
      "--check",
    ]),
    {
      repository: "owner/repo",
      ref: "main",
      arbDirectory: "lib/l10n",
      output: "out.ts",
      check: true,
    },
  );
  assertThrows(() => parseCliArgs(["--repo", "owner/repo"]), "required");
});

Deno.test("pinned snapshot validation fails closed on count drift", () => {
  const catalog: GlossaryCatalog = {
    locales: ["en"],
    entries: [],
    diagnostics: {
      englishMessageKeyCount: 0,
      eligibleKeyCount: 0,
      normalizedSourceCount: 0,
      ambiguousCollisionCount: 0,
      appliedOverrideCount: 0,
      exclusionCounts: {
        sourceNotString: 0,
        sourceEmpty: 0,
        sourceTooShort: 0,
        sourceTooLong: 0,
        sourceHasBraces: 0,
        localeValueMissing: 0,
        targetHasBraces: 0,
      },
    },
  };
  assertThrows(
    () =>
      assertPinnedSnapshot({
        repository: "antonkarliner/timer-coffee",
        commit: "f36fb42a76fb3277301ba5451d05f767340b0cde",
        arbDirectory: "lib/l10n",
      }, catalog),
    "Pinned snapshot localeCount drifted",
  );
});
