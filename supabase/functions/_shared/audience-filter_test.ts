import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  type AudienceFilter,
  validateAudienceFilter,
} from "./audience-filter.ts";

Deno.test("audience: absent and null mean everyone", () => {
  assertEquals(validateAudienceFilter(undefined), { ok: true, value: null });
  assertEquals(validateAudienceFilter(null), { ok: true, value: null });
});

Deno.test("audience: all dimensions, primary/subtag locales and geo union", () => {
  const value: AudienceFilter = {
    locales: ["de", "pt-br", "zh-hant"],
    countries: ["DE", "AT"],
    regions: ["EU", "WW"],
    platforms: ["ios", "android", "web"],
  };
  assertEquals(validateAudienceFilter(value), { ok: true, value });
});

Deno.test("audience: empty objects, arrays and null dimensions are valid", () => {
  for (
    const value of [{}, {
      locales: [],
      countries: null,
      regions: [],
      platforms: null,
    }]
  ) {
    assertEquals(validateAudienceFilter(value), { ok: true, value });
  }
});

Deno.test("audience: reject non-objects, unknown keys and wrong dimension types", () => {
  for (
    const input of [[], "de", 42, true, { locale: ["de"] }, { locales: "de" }, {
      countries: {},
    }]
  ) {
    assertEquals(
      validateAudienceFilter(input).ok,
      false,
      JSON.stringify(input),
    );
  }
});

Deno.test("audience: reject invalid locale casing, length and syntax", () => {
  for (
    const locale of [
      "DE",
      "pt-BR",
      "e",
      "abcdefghijk",
      "en_uk",
      "-en",
      "en-",
      "12",
      "en\n",
      "en\u2028",
      "EU\u2029",
    ]
  ) {
    assertEquals(
      validateAudienceFilter({ locales: [locale] }).ok,
      false,
      locale,
    );
  }
});

Deno.test("audience: reject bad countries, regions, platforms and non-string entries", () => {
  for (
    const input of [
      { countries: ["de"] },
      { countries: ["DEU"] },
      { countries: ["DE\n"] },
      { regions: ["eu"] },
      { regions: ["E"] },
      { regions: ["EU1"] },
      { platforms: ["all"] },
      { platforms: ["IOS"] },
      { locales: [null] },
      { countries: [1] },
      { regions: [true] },
    ]
  ) {
    assertEquals(
      validateAudienceFilter(input).ok,
      false,
      JSON.stringify(input),
    );
  }
});

Deno.test("audience: result does not alias caller arrays", () => {
  const input = { locales: ["de"] };
  const result = validateAudienceFilter(input);
  input.locales.push("pt");
  assertEquals(result, { ok: true, value: { locales: ["de"] } });
});
