const COLUMN_GAP = '  ';

/** Formats rows as left-aligned columns under upper-case headers. */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join(COLUMN_GAP)
      .trimEnd();
  return [line(headers.map((header) => header.toUpperCase())), ...rows.map(line)];
}
