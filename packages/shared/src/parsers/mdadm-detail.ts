/** Parser for `mdadm --detail --export <device>`. */

import { parseKeyValueLines } from './key-value.ts';
import { ParseError } from './parse-error.ts';

const SOURCE = 'mdadm --detail --export output';
const MEMBER_ROLE_KEY = /^MD_DEVICE_(?<id>.+)_ROLE$/u;
const NUMERIC_ROLE = /^\d+$/u;
const NAMED_ROLES = ['spare', 'faulty', 'journal'] as const;

function required(entries: ReadonlyMap<string, string>, key: string): string {
  const value = entries.get(key);
  if (value === undefined) {
    throw new ParseError(`Could not parse ${SOURCE}: missing ${key}`);
  }
  return value;
}

function parseRole(value: string): MdMemberRole {
  if (NUMERIC_ROLE.test(value)) {
    return Number(value);
  }
  const named = NAMED_ROLES.find((role) => role === value);
  if (named === undefined) {
    throw new ParseError(`Could not parse ${SOURCE}: unknown member role "${value}"`);
  }
  return named;
}

function parseMembers(entries: ReadonlyMap<string, string>): MdMember[] {
  const members: MdMember[] = [];
  for (const [key, value] of entries) {
    const id = MEMBER_ROLE_KEY.exec(key)?.groups?.id;
    if (id !== undefined) {
      members.push({
        device: required(entries, `MD_DEVICE_${id}_DEV`),
        role: parseRole(value),
      });
    }
  }
  return members.sort((a, b) => a.device.localeCompare(b.device));
}

/** A slot number for active members, otherwise what the member is. */
export type MdMemberRole = number | (typeof NAMED_ROLES)[number];

export interface MdMember {
  /** Device path, such as "/dev/sda2". */
  readonly device: string;
  readonly role: MdMemberRole;
}

export interface MdDetail {
  readonly level: string;
  /** Number of active slots in the array. */
  readonly raidDevices: number;
  readonly metadata: string | null;
  readonly uuid: string;
  /** Short name under /dev/md/, such as "ohr_p1_t1". */
  readonly devName: string | null;
  /** Name stored in the superblock, usually "host:name". */
  readonly name: string | null;
  /** Members sorted by device path. */
  readonly members: readonly MdMember[];
}

export function parseMdadmDetail(text: string): MdDetail {
  const entries = parseKeyValueLines(text);
  const raidDevices = Number(required(entries, 'MD_DEVICES'));
  if (!Number.isInteger(raidDevices)) {
    throw new ParseError(`Could not parse ${SOURCE}: MD_DEVICES is not a number`);
  }
  return {
    level: required(entries, 'MD_LEVEL'),
    raidDevices,
    metadata: entries.get('MD_METADATA') ?? null,
    uuid: required(entries, 'MD_UUID'),
    devName: entries.get('MD_DEVNAME') ?? null,
    name: entries.get('MD_NAME') ?? null,
    members: parseMembers(entries),
  };
}
