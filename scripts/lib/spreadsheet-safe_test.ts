import {
  csvRawCell,
  csvTextCell,
  neutralizeSpreadsheetFormula,
} from "./spreadsheet-safe.ts";

function assertEquals(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("dangerous prefixes are neutralized after whitespace and controls", () => {
  const prefixes = ["=", "+", "-", "@", "＝", "＋", "－", "＠"];
  const leading = [
    "",
    "   ",
    "\t",
    "\r",
    "\n",
    "\u00a0",
    "\u202f",
    "\u200b",
    "\ufeff",
    " \t\r\n\u00a0\u200b\ufeff",
    ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
    ...Array.from({ length: 33 }, (_, i) => String.fromCharCode(0x7f + i)),
  ];
  for (const prefix of prefixes) {
    for (const whitespace of leading) {
      const value = whitespace + prefix + "SUM(1)";
      assertEquals(neutralizeSpreadsheetFormula(value), "'" + value);
      assertEquals(csvTextCell(value), `"'${value}"`);
    }
  }
});

Deno.test("bare leading tabs and carriage returns are neutralized", () => {
  for (const value of ["\t", "\r", "\tFive Elephant", "\rFive Elephant"]) {
    assertEquals(neutralizeSpreadsheetFormula(value), "'" + value);
  }
});

Deno.test("benign text and Unicode are preserved", () => {
  for (
    const value of [
      "",
      "Five Elephant",
      "Café de l'Ouest",
      "1/2 Kilo",
      "Ninety+ Coffee",
      "  Five Elephant",
      "\nFive Elephant",
      "Кофе",
      "咖啡",
      "☕🫘",
    ]
  ) {
    assertEquals(neutralizeSpreadsheetFormula(value), value);
    assertEquals(csvTextCell(value), `"${value}"`);
  }
});

Deno.test("CSV quotes, commas and newlines are escaped", () => {
  const value = 'Coffee "special",\nnext line';
  const expected = '"Coffee ""special"",\nnext line"';
  assertEquals(csvTextCell(value), expected);
  assertEquals(csvRawCell(value), expected);
  assertEquals(
    csvTextCell('=HYPERLINK("http://x","click")'),
    '"\'=HYPERLINK(""http://x"",""click"")"',
  );
});

Deno.test("text cells stringify unknown values and default nullish values", () => {
  assertEquals(csvTextCell(null), '""');
  assertEquals(csvTextCell(undefined), '""');
  assertEquals(csvTextCell(123), '"123"');
  assertEquals(csvTextCell(false), '"false"');
  assertEquals(csvTextCell(-2), '"\'-2"');
});

Deno.test("raw generated cells are quoted without neutralization", () => {
  assertEquals(csvRawCell(0.123), '"0.123"');
  assertEquals(csvRawCell("0.123"), '"0.123"');
  assertEquals(csvRawCell(-2), '"-2"');
  assertEquals(csvRawCell(true), '"true"');
  assertEquals(csvRawCell("yes"), '"yes"');
  assertEquals(csvRawCell("NO"), '"NO"');
  assertEquals(csvRawCell(""), '""');
});
