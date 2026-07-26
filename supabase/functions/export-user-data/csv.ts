// CSV serialization helpers for the self-serve user data export (Plan 035,
// Phase 2). Kept in one small module so every projection (brews.csv,
// beans.csv, reviews.csv, custom_recipes.csv) escapes the same way.
//
// Escaping follows RFC 4180: a field containing a comma, double quote, or any
// line break is wrapped in double quotes, and any double quote inside the
// field is doubled. Rows are joined with CRLF, which plays nicely with both
// Excel and plain `cat`.

/** Escapes a single CSV field. Non-string values are JSON-stringified first
 * (e.g. arrays like `flavor_tags`), so the resulting CSV cell is always a
 * single string. */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",");
}

/** Builds a full CSV document (header row + data rows), CRLF-terminated. */
export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [toCsvRow(headers)];
  for (const row of rows) {
    lines.push(toCsvRow(row));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Reads the first present key from `candidates` on `record`.
 *
 * Remote rows are snake_case (e.g. `stat_uuid`, `roast_date`). The frontend
 * local-dump service (Plan 035 Phase 3) has not shipped yet, so the exact
 * shape of client-supplied `localData` records isn't finalized — it may well
 * serialize Drift columns in Dart's camelCase (e.g. `statUuid`, `roastDate`).
 * Every CSV projection reads fields through this helper, trying each spelling
 * in turn, so either shape produces a populated column without requiring a
 * backend redeploy once Phase 3 lands.
 */
export function pick(
  record: Record<string, unknown>,
  candidates: string[],
): unknown {
  for (const key of candidates) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}
