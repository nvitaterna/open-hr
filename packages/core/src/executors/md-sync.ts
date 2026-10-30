/**
 * Waits for an md array's background work to finish: the reshape after a
 * grow or a chunk change, the recovery after a member is added or replaced,
 * and the resync of a new array (decision 0011). It reads /proc/mdstat and
 * the array's md sysfs files every few seconds and reports progress as it
 * goes. It only reads, so it can attach to work the kernel kept running
 * across a daemon restart or a reboot.
 */

import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseMdstat, type SyncAction } from '@ohr/shared/parsers/mdstat';

import type { FileReader } from '../command-runner.ts';

const KERNEL_NAME = /^md\d+$/u;
const COMPLETED = /^(?<done>\d+)\s*\/\s*(?<total>\d+)$/u;
const DEFAULT_INTERVAL_MS = 5000;
const SECONDS_PER_MINUTE = 60;
const PERCENT = 100;
/**
 * Idle reads in a row before the work counts as finished. mdadm hands work to
 * the kernel's md thread, which can take a moment to pick it up, so one idle
 * read straight after a command proves nothing.
 */
const IDLE_READS_TO_FINISH = 2;
/** Idle but degraded reads in a row before giving up on a rebuild that never starts. */
const DEGRADED_READS_TO_FAIL = 3;
/** What the kernel writes to sync_action for each kind of work. "frozen" and "idle" are not work. */
const SYSFS_ACTIONS: Readonly<Record<string, SyncAction>> = {
  resync: 'resync',
  recover: 'recovery',
  reshape: 'reshape',
  check: 'check',
  repair: 'repair',
};

function assertKernelName(name: string): void {
  if (!KERNEL_NAME.test(name)) {
    throw new RangeError(`Expected an md kernel name such as md127, got "${name}"`);
  }
}

async function readSysfs(files: FileReader, name: string, file: string): Promise<string | null> {
  const text = await files(`/sys/block/${name}/md/${file}`);
  return text?.trim() ?? null;
}

function completedFraction(text: string | null): number | null {
  const groups = COMPLETED.exec(text ?? '')?.groups;
  const total = Number(groups?.total);
  if (groups === undefined || !(total > 0)) {
    return null;
  }
  return Math.min(1, Number(groups.done) / total);
}

interface ReadCounts {
  readonly idle: number;
  readonly degraded: number;
}

/** Counts after one read. Throws when a rebuild that must come never starts. */
function count(request: WaitForSyncRequest, state: SyncState, counts: ReadCounts): ReadCounts {
  if (state.kind === 'busy') {
    request.onProgress?.(state.progress);
    return { idle: 0, degraded: 0 };
  }
  if (request.untilInSync === true && state.degraded) {
    if (counts.degraded + 1 >= DEGRADED_READS_TO_FAIL) {
      throw new Error(`${request.array} has no rebuild running but is still degraded`);
    }
    return { idle: 0, degraded: counts.degraded + 1 };
  }
  return { idle: counts.idle + 1, degraded: 0 };
}

/** Background work an array is doing, as far as the kernel says. */
export interface SyncProgress {
  readonly operation: SyncAction;
  /** From 0 to 1. Null while the work is queued behind another array on the same drives. */
  readonly fraction: number | null;
  /** The kernel's estimate of time left. Null when it gives none. */
  readonly etaSeconds: number | null;
}

export type SyncState =
  | { readonly kind: 'busy'; readonly progress: SyncProgress }
  /** No work running or queued. `degraded` is true while a slot has no working member. */
  | { readonly kind: 'idle'; readonly degraded: boolean };

export interface WaitForSyncRequest {
  readonly files: FileReader;
  /** The array's kernel name, such as md127. See mdKernelName. */
  readonly array: string;
  /**
   * Also wait until every slot has a working member, and fail if the array
   * goes idle without getting there. For waits after adding or replacing a
   * member, where a rebuild must follow.
   */
  readonly untilInSync?: boolean;
  readonly onProgress?: (progress: SyncProgress) => void;
  readonly intervalMs?: number | undefined;
  /** Stops the wait, for example when the daemon shuts down. The work itself carries on. */
  readonly signal?: AbortSignal;
  /** Replaces the pause between reads, for tests. */
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The kernel name behind an array's device path, such as md127 for /dev/md/ohr_p1_t1. */
export async function mdKernelName(path: string): Promise<string> {
  const name = basename(await realpath(path));
  assertKernelName(name);
  return name;
}

/** What the array is doing now. Throws if it is not running. */
export async function readSyncState(files: FileReader, array: string): Promise<SyncState> {
  assertKernelName(array);
  const action = await readSysfs(files, array, 'sync_action');
  if (action === null) {
    throw new Error(`${array} is not running`);
  }
  const mdstat = parseMdstat((await files('/proc/mdstat')) ?? '').find(
    (entry) => entry.name === array,
  );
  const reshapePosition = await readSysfs(files, array, 'reshape_position');
  let operation = SYSFS_ACTIONS[action] ?? mdstat?.sync?.action ?? null;
  if (operation === null && reshapePosition !== null && reshapePosition !== 'none') {
    // A reshape that has stopped part way, for example while the array is frozen.
    operation = 'reshape';
  }
  if (operation === null && mdstat?.members.some((member) => member.replacement) === true) {
    // A replace whose copy is done but whose old member md has not yet marked
    // faulty, or one about to start: the swap is still under way.
    operation = 'recovery';
  }
  if (operation === null) {
    const degraded = Number((await readSysfs(files, array, 'degraded')) ?? '0');
    return { kind: 'idle', degraded: degraded > 0 };
  }
  const percent = mdstat?.sync?.percent ?? null;
  const finishMinutes = mdstat?.sync?.finishMinutes ?? null;
  let fraction = completedFraction(await readSysfs(files, array, 'sync_completed'));
  if (fraction === null && percent !== null) {
    fraction = percent / PERCENT;
  }
  let etaSeconds: number | null = null;
  if (finishMinutes !== null) {
    etaSeconds = Math.round(finishMinutes * SECONDS_PER_MINUTE);
  }
  return { kind: 'busy', progress: { operation, fraction, etaSeconds } };
}

/**
 * Reads the array's state every few seconds until it has no work running or
 * queued, reporting progress on each busy read. A reshape can run for days,
 * so each read schedules the next instead of awaiting it, and the reads do
 * not pile up into one long promise chain.
 */
export function waitForSync(request: WaitForSyncRequest): Promise<void> {
  const { files, array, signal } = request;
  const intervalMs = request.intervalMs ?? DEFAULT_INTERVAL_MS;
  const delay = request.delay ?? ((ms, abort) => sleep(ms, undefined, { signal: abort }));
  return new Promise((resolve, reject) => {
    const read = (counts: ReadCounts): void => {
      Promise.resolve()
        .then(async () => {
          signal?.throwIfAborted();
          const next = count(request, await readSyncState(files, array), counts);
          if (next.idle >= IDLE_READS_TO_FINISH) {
            resolve();
            return;
          }
          await delay(intervalMs, signal);
          read(next);
        })
        .catch(reject);
    };
    read({ idle: 0, degraded: 0 });
  });
}
