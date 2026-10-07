// A leading apostrophe makes spreadsheet formulas literal text. Apply this only
// to free-text columns so generated numbers and fixed labels keep their content.
export function neutralizeSpreadsheetFormula(value: string): string {
  const stripped = value.replace(
    /^[\s\u0000-\u001f\u007f-\u009f\u200b\ufeff]*/,
    "",
  );
  return /^[=+\-@＝＋－＠]/.test(stripped) || /^[\t\r]/.test(value)
    ? "'" + value
    : value;
}

export function csvTextCell(value: unknown): string {
  return csvRawCell(neutralizeSpreadsheetFormula(String(value ?? "")));
}

export function csvRawCell(value: string | number | boolean): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}
