// buildEmbeddingInput cases moved to ../_shared/roaster-embedding-core_test.ts
import { parseRoasterId } from "./request-utils.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("parseRoasterId accepts only positive safe integers", () => {
  assertEquals(parseRoasterId(42), 42, "A positive integer should be valid.");

  for (
    const invalid of [
      null,
      undefined,
      "42",
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    assertEquals(
      parseRoasterId(invalid),
      null,
      `Expected ${String(invalid)} to be rejected.`,
    );
  }
});
