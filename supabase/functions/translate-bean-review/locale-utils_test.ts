import { baseLang } from "./locale-utils.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

Deno.test("baseLang extracts the base subtag from a hyphenated locale", () => {
  assertEquals(baseLang("en-US"), "en", "en-US should reduce to en");
});

Deno.test("baseLang extracts the base subtag from an underscored locale", () => {
  assertEquals(baseLang("pt_BR"), "pt", "pt_BR should reduce to pt");
});

Deno.test("baseLang matches bare base-language locales", () => {
  assertEquals(baseLang("pt"), "pt", "pt should stay pt");
});

Deno.test("baseLang is case-insensitive", () => {
  assertEquals(baseLang("EN-us"), "en", "EN-us should reduce to en");
});

Deno.test("baseLang trims surrounding whitespace", () => {
  assertEquals(baseLang("  en-GB  "), "en", "whitespace should be trimmed before splitting");
});

Deno.test("baseLang returns empty string for an empty locale", () => {
  assertEquals(baseLang(""), "", "empty locale should produce empty base subtag");
});

Deno.test("baseLang treats regional variants as matching base languages", () => {
  assertEquals(
    baseLang("en-US") === baseLang("en"),
    true,
    "en-US and en should share the same base language",
  );
  assertEquals(
    baseLang("pt-BR") === baseLang("pt"),
    true,
    "pt-BR and pt should share the same base language",
  );
  assertEquals(
    baseLang("pt-BR") === baseLang("pt-PT"),
    true,
    "pt-BR and pt-PT should share the same base language",
  );
  assertEquals(
    baseLang("en") === baseLang("es"),
    false,
    "en and es should not match",
  );
});
