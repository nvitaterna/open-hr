/**
 * Byte sizes. Units are always explicit: decimal units (KB, MB, GB, TB) are
 * powers of 1000 like drive labels, binary units (KiB, MiB, GiB, TiB) are
 * powers of 1024 like the kernel. A bare number or a bare "T" is rejected so a
 * size can never be read two ways.
 */

const DECIMAL_STEP = 1000;
const BINARY_STEP = 1024;
const DISPLAY_DECIMALS = 2;
const SIZE_PATTERN = /^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>[A-Za-z]+)$/u;

const KB = DECIMAL_STEP;
const MB = KB * DECIMAL_STEP;
const GB = MB * DECIMAL_STEP;
const TB = GB * DECIMAL_STEP;
const PB = TB * DECIMAL_STEP;
const KIB = BINARY_STEP;
const MIB = KIB * BINARY_STEP;
const GIB = MIB * BINARY_STEP;
const TIB = GIB * BINARY_STEP;
const PIB = TIB * BINARY_STEP;

const UNIT_FACTORS: ReadonlyMap<string, number> = new Map([
  ['B', 1],
  ['KB', KB],
  ['MB', MB],
  ['GB', GB],
  ['TB', TB],
  ['PB', PB],
  ['KiB', KIB],
  ['MiB', MIB],
  ['GiB', GIB],
  ['TiB', TIB],
  ['PiB', PIB],
]);

const DISPLAY_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export class SizeParseError extends Error {
  override readonly name = 'SizeParseError';
}

/** Parses a size such as "4TB", "3.5 TiB" or "512MiB" into a whole number of bytes. */
export function parseSize(text: string): number {
  const match = SIZE_PATTERN.exec(text.trim());
  const amount = match?.groups?.amount;
  const unit = match?.groups?.unit;
  if (amount === undefined || unit === undefined) {
    throw new SizeParseError(
      `Invalid size "${text}". Use a number and a unit, such as 4TB or 4TiB.`,
    );
  }
  const factor = UNIT_FACTORS.get(unit);
  if (factor === undefined) {
    throw new SizeParseError(
      `Unknown unit "${unit}" in "${text}". Use one of: ${[...UNIT_FACTORS.keys()].join(', ')}.`,
    );
  }
  const bytes = Math.round(Number(amount) * factor);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new SizeParseError(`Size "${text}" is out of range.`);
  }
  return bytes;
}

/** Formats bytes with decimal units, matching how drives are labelled, for example "4.00 TB". */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= DECIMAL_STEP && unitIndex < DISPLAY_UNITS.length - 1) {
    value /= DECIMAL_STEP;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${bytes} B`;
  }
  return `${value.toFixed(DISPLAY_DECIMALS)} ${DISPLAY_UNITS[unitIndex] ?? 'B'}`;
}

/** Rounds down to a multiple of `alignment`. */
export function alignDown(bytes: number, alignment: number): number {
  return Math.floor(bytes / alignment) * alignment;
}
