/**
 * Parser for `mdadm --detail --scan`, which prints one ARRAY line per array
 * in the format mdadm.conf uses. Indented continuation lines, such as the
 * device list from --verbose, are ignored.
 */

import { ParseError } from './parse-error.ts';

const SOURCE = 'mdadm --detail --scan output';
const ARRAY_LINE = /^ARRAY\s+(?<device>\S+)(?<rest>.*)$/u;
const PAIR = /^(?<key>[A-Za-z-]+)=(?<value>.+)$/u;
const WHITESPACE = /\s+/u;

function parsePairs(rest: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const word of rest.trim().split(WHITESPACE)) {
    const groups = PAIR.exec(word)?.groups;
    if (groups?.key !== undefined && groups.value !== undefined) {
      pairs.set(groups.key, groups.value);
    }
  }
  return pairs;
}

function parseArrayLine(line: string): MdArrayDefinition | null {
  const groups = ARRAY_LINE.exec(line)?.groups;
  if (groups?.device === undefined) {
    return null;
  }
  const pairs = parsePairs(groups.rest ?? '');
  const uuid = pairs.get('UUID');
  if (uuid === undefined) {
    throw new ParseError(`Could not parse ${SOURCE}: ${groups.device} has no UUID`);
  }
  return { device: groups.device, metadata: pairs.get('metadata') ?? null, uuid };
}

export interface MdArrayDefinition {
  /** Path mdadm assembles the array at, such as /dev/md/ohr_p1_t1. */
  readonly device: string;
  readonly metadata: string | null;
  /** The array UUID in mdadm's colon-separated form. */
  readonly uuid: string;
}

export function parseMdadmScan(text: string): MdArrayDefinition[] {
  return text
    .split('\n')
    .map(parseArrayLine)
    .filter((definition) => definition !== null);
}
