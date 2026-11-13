/**
 * CSV cells for the export routes. Every cell is quoted with its quotes doubled, so a value can
 * never start a new column or row. A cell a spreadsheet would evaluate as a formula (it starts
 * with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe: exported rows
 * carry text that nodes and callers supplied, such as log messages and command lines.
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** One CSV row, without a line terminator. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
