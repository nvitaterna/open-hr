/** Parser for KEY=value lines, as printed by `mdadm --export` and `blkid -o export`. */

const LINE = /^(?<key>[A-Za-z0-9_]+)=(?<value>.*)$/u;
const ESCAPED = /\\(?<char>.)/gu;
const BLANK_LINES = /\n\s*\n/u;

/** Parses one block of KEY=value lines. Backslash escapes are removed from values. */
export function parseKeyValueLines(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split('\n')) {
    const groups = LINE.exec(line.trim())?.groups;
    if (groups?.key !== undefined && groups.value !== undefined) {
      entries.set(groups.key, groups.value.replace(ESCAPED, '$<char>'));
    }
  }
  return entries;
}

/** Splits text into blocks separated by blank lines and parses each. */
export function parseKeyValueBlocks(text: string): Map<string, string>[] {
  return text
    .split(BLANK_LINES)
    .map(parseKeyValueLines)
    .filter((block) => block.size > 0);
}
