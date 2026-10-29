/** The one row a report about a single object must contain. */
export function singleRow<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new Error(`Expected one ${what} in the report, got ${rows.length}`);
  }
  return row;
}
