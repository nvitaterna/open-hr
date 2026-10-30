/** Parser for the kernel's /proc/mdstat. */

import { ParseError } from './parse-error.ts';

const BYTES_PER_BLOCK = 1024;
const HEADER =
  /^(?<name>md\S+) : (?<state>active|inactive)(?: \((?<access>auto-read-only|read-only)\))?(?<rest>.*)$/u;
const MEMBER = /^(?<device>[^\s[]+)\[(?<slot>\d+)\](?<flags>(?:\([A-Z]\))*)$/u;
const STATUS = /^\s+(?<blocks>\d+) blocks(?<rest>.*)$/u;
const HEALTH = /\[(?<expected>\d+)\/(?<working>\d+)\] \[(?<map>[U_]+)\]/u;
const PROGRESS =
  /(?<action>recovery|resync|reshape|check|repair)\s*=\s*(?<percent>[\d.]+)%\s*\((?<done>\d+)\/(?<total>\d+)\)\s*finish=(?<finish>[\d.]+)min\s*speed=(?<speed>\d+)K\/sec/u;
const WAITING = /(?<action>recovery|resync|reshape|check|repair)=(?<state>DELAYED|PENDING)/u;
const WHITESPACE = /\s+/u;
/** The kinds of background work md reports. */
export const SYNC_ACTIONS = ['recovery', 'resync', 'reshape', 'check', 'repair'] as const;

function isSyncAction(value: string): value is SyncAction {
  return (SYNC_ACTIONS as readonly string[]).includes(value);
}

function waitingState(raw: 'DELAYED' | 'PENDING'): 'delayed' | 'pending' {
  if (raw === 'DELAYED') {
    return 'delayed';
  }
  return 'pending';
}

function parseMember(token: string, arrayName: string): MdstatMember {
  const match = MEMBER.exec(token);
  const device = match?.groups?.device;
  const slot = match?.groups?.slot;
  if (device === undefined || slot === undefined) {
    throw new ParseError(`Could not parse /proc/mdstat: bad member "${token}" in ${arrayName}`);
  }
  const flags = match?.groups?.flags ?? '';
  return {
    device,
    slot: Number(slot),
    faulty: flags.includes('(F)'),
    spare: flags.includes('(S)'),
    writeMostly: flags.includes('(W)'),
    journal: flags.includes('(J)'),
    replacement: flags.includes('(R)'),
  };
}

function parseHeader(line: string): Omit<MdstatArray, 'sizeBytes' | 'health' | 'sync'> | null {
  const groups = HEADER.exec(line)?.groups;
  if (groups?.name === undefined) {
    return null;
  }
  const tokens = (groups.rest ?? '').trim().split(WHITESPACE).filter(Boolean);
  let level: string | null = null;
  const [first] = tokens;
  if (first !== undefined && !MEMBER.test(first)) {
    level = first;
    tokens.shift();
  }
  return {
    name: groups.name,
    active: groups.state === 'active',
    readOnly: groups.access === 'read-only',
    autoReadOnly: groups.access === 'auto-read-only',
    level,
    members: tokens.map((token) => parseMember(token, groups.name ?? '')),
  };
}

function parseHealth(rest: string): MdstatHealth | null {
  const groups = HEALTH.exec(rest)?.groups;
  if (groups?.expected === undefined || groups.working === undefined || groups.map === undefined) {
    return null;
  }
  return {
    expectedDevices: Number(groups.expected),
    workingDevices: Number(groups.working),
    memberMap: groups.map,
  };
}

function parseSync(line: string): MdstatSync | null {
  const progress = PROGRESS.exec(line)?.groups;
  if (progress?.action !== undefined && isSyncAction(progress.action)) {
    return {
      action: progress.action,
      state: 'running',
      percent: Number(progress.percent),
      doneBlocks: Number(progress.done),
      totalBlocks: Number(progress.total),
      finishMinutes: Number(progress.finish),
      speedKibPerSecond: Number(progress.speed),
    };
  }
  const waiting = WAITING.exec(line)?.groups;
  if (
    waiting?.action !== undefined &&
    isSyncAction(waiting.action) &&
    (waiting.state === 'DELAYED' || waiting.state === 'PENDING')
  ) {
    return {
      action: waiting.action,
      state: waitingState(waiting.state),
      percent: null,
      doneBlocks: null,
      totalBlocks: null,
      finishMinutes: null,
      speedKibPerSecond: null,
    };
  }
  return null;
}

type ArrayDraft = { -readonly [K in keyof MdstatArray]: MdstatArray[K] };

function applyDetailLine(array: ArrayDraft, line: string): void {
  const status = STATUS.exec(line)?.groups;
  if (status?.blocks !== undefined) {
    array.sizeBytes = Number(status.blocks) * BYTES_PER_BLOCK;
    array.health = parseHealth(status.rest ?? '');
    return;
  }
  array.sync ??= parseSync(line);
}

export type SyncAction = (typeof SYNC_ACTIONS)[number];

export interface MdstatMember {
  /** Kernel name of the member, such as "sda2". */
  readonly device: string;
  /** The number in brackets after the device name. */
  readonly slot: number;
  readonly faulty: boolean;
  readonly spare: boolean;
  readonly writeMostly: boolean;
  readonly journal: boolean;
  readonly replacement: boolean;
}

export interface MdstatHealth {
  /** Devices the array is meant to have. */
  readonly expectedDevices: number;
  /** Devices currently working. Fewer than expected means degraded. */
  readonly workingDevices: number;
  /** One character per slot: U is up, _ is missing or failed. */
  readonly memberMap: string;
}

export interface MdstatSync {
  readonly action: SyncAction;
  readonly state: 'running' | 'delayed' | 'pending';
  readonly percent: number | null;
  readonly doneBlocks: number | null;
  readonly totalBlocks: number | null;
  readonly finishMinutes: number | null;
  readonly speedKibPerSecond: number | null;
}

export interface MdstatArray {
  /** Kernel name, such as "md127". */
  readonly name: string;
  readonly active: boolean;
  readonly readOnly: boolean;
  readonly autoReadOnly: boolean;
  /** raid1, raid5, raid6, and so on. Null for inactive arrays. */
  readonly level: string | null;
  readonly members: readonly MdstatMember[];
  readonly sizeBytes: number | null;
  /** Null for inactive arrays and levels without redundancy. */
  readonly health: MdstatHealth | null;
  /** A running or queued resync, recovery, reshape, check, or repair. */
  readonly sync: MdstatSync | null;
}

export function parseMdstat(text: string): MdstatArray[] {
  const arrays: ArrayDraft[] = [];
  let current: ArrayDraft | null = null;
  for (const line of text.split('\n')) {
    const header = parseHeader(line);
    if (header !== null) {
      current = { ...header, sizeBytes: null, health: null, sync: null };
      arrays.push(current);
    } else if (line.trim() === '') {
      current = null;
    } else if (current !== null) {
      applyDetailLine(current, line);
    }
  }
  return arrays;
}

/** True when an array runs with fewer devices than it should. */
export function isDegraded(array: MdstatArray): boolean {
  return array.health !== null && array.health.workingDevices < array.health.expectedDevices;
}
