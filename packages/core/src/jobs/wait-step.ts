/**
 * The step that waits for md to finish a reshape, recovery, or resync
 * (decision 0011). It only reads, so after a daemon restart or a reboot it
 * attaches to the work the kernel kept running. It reports every progress
 * read and logs a line each tenth. An array assembled at boot can be
 * auto-read-only, and then a reshape it was running waits for the first
 * write, which may never come. The step sets such an array read-write first.
 * md goes idle a moment before a grown array takes its new size, and
 * mdadm can set the size itself once the kernel is done, so the step also
 * waits until the size matches the array's members.
 */

import type { FileReader } from '../command-runner.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { setReadWrite } from '../executors/md-reshape.ts';
import { readSyncState, type SyncProgress, waitForSync } from '../executors/md-sync.ts';
import type { StepContext, StepDefinition } from './engine.ts';
import { READY } from './pool-steps.ts';
import type { MdDeps } from './reshape-steps.ts';

const PERCENT = 100;
/** Progress is logged each time it passes another tenth. */
const LOG_STEPS = 10;
const SECONDS_PER_MINUTE = 60;
/** What md's array_state says for an array that becomes read-write on its first write. */
const AUTO_READ_ONLY = 'read-auto';
/** md's component_size is in KiB, a block device's size in 512-byte sectors. */
const SECTORS_PER_KIB = 2;
/** Members that hold no data, by level. Levels not listed have no size rule here. */
const REDUNDANT_MEMBERS: Readonly<Record<string, number>> = { raid4: 1, raid5: 1, raid6: 2 };
const CAPACITY_INTERVAL_MS = 500;
/** How many reads, CAPACITY_INTERVAL_MS apart, before a size that never comes fails the step. */
const CAPACITY_READS = 240;

interface Capacity {
  readonly sectors: number;
  readonly expected: number;
}

/** The array's size and the size its level, member count, and member size give, or null for no rule. */
async function readCapacity(files: FileReader, array: string): Promise<Capacity | null> {
  const read = async (path: string): Promise<string> =>
    (await files(`/sys/block/${array}/${path}`))?.trim() ?? '';
  const level = await read('md/level');
  const members = Number(await read('md/raid_disks'));
  const componentKib = Number(await read('md/component_size'));
  const sectors = Number(await read('size'));
  const redundant = REDUNDANT_MEMBERS[level];
  let dataMembers: number | null = null;
  if (level === 'raid1') {
    dataMembers = 1;
  } else if (redundant !== undefined) {
    dataMembers = members - redundant;
  }
  if (dataMembers === null || !(dataMembers > 0 && componentKib > 0)) {
    return null;
  }
  return { sectors, expected: componentKib * SECTORS_PER_KIB * dataMembers };
}

/** Waits until the array has the size its members give. Throws once CAPACITY_READS have passed. */
async function waitForCapacity(deps: MdDeps, array: string, reads = 0): Promise<void> {
  const capacity = await readCapacity(deps.files, array);
  if (capacity === null || capacity.sectors >= capacity.expected) {
    return;
  }
  if (reads >= CAPACITY_READS) {
    throw new Error(
      `${array} has ${capacity.sectors} sectors; its members give ${capacity.expected}`,
    );
  }
  await deps.delay(CAPACITY_INTERVAL_MS);
  await waitForCapacity(deps, array, reads + 1);
}

/** Logs a line each time the work passes another tenth. */
function progressLogger(log: (line: string) => void): (progress: SyncProgress) => void {
  let logged = -1;
  return (progress) => {
    if (progress.fraction === null) {
      return;
    }
    const tenth = Math.floor(progress.fraction * LOG_STEPS);
    if (tenth <= logged) {
      return;
    }
    logged = tenth;
    let line = `${progress.operation} ${Math.floor(progress.fraction * PERCENT)}% done`;
    if (progress.etaSeconds !== null) {
      line += `, about ${Math.ceil(progress.etaSeconds / SECONDS_PER_MINUTE)} min left`;
    }
    log(line);
  };
}

export function waitStep(
  poolId: string,
  wait: {
    readonly tier: number;
    readonly what: string;
    /** Also wait until no slot is empty, and fail if the array goes idle short of that. */
    readonly untilInSync?: boolean;
  },
  deps: MdDeps,
): StepDefinition {
  const path = mdArrayPath(poolId, wait.tier);
  return {
    name: `wait for tier ${wait.tier} ${wait.what}`,
    description: `Wait until ${path} has finished its ${wait.what}`,
    commands: [`read /proc/mdstat until ${path} is idle`],
    precondition: () => Promise.resolve(READY),
    async action({ run, log, progress }: StepContext) {
      const logProgress = progressLogger(log);
      const array = await deps.kernelName(path);
      const state = await deps.files(`/sys/block/${array}/md/array_state`);
      if (state?.trim() === AUTO_READ_ONLY) {
        log(`${path} is auto-read-only; setting it read-write so its work continues`);
        await setReadWrite(run, path);
      }
      await waitForSync({
        files: deps.files,
        array,
        intervalMs: deps.pollIntervalMs,
        untilInSync: wait.untilInSync === true,
        onProgress: (update) => {
          progress(update);
          logProgress(update);
        },
      });
      await waitForCapacity(deps, array);
    },
    async postcondition() {
      const state = await readSyncState(deps.files, await deps.kernelName(path));
      if (state.kind === 'busy') {
        throw new Error(`${path} is still running a ${state.progress.operation}`);
      }
    },
  };
}
