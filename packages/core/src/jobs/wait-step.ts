/**
 * The step that waits for md to finish a reshape, recovery, or resync
 * (decision 0011). It only reads, so after a daemon restart or a reboot it
 * attaches to the work the kernel kept running. It reports every progress
 * read and logs a line each tenth. An array assembled at boot can be
 * auto-read-only, and then a reshape it was running waits for the first
 * write, which may never come. The step sets such an array read-write first.
 */

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
    },
    async postcondition() {
      const state = await readSyncState(deps.files, await deps.kernelName(path));
      if (state.kind === 'busy') {
        throw new Error(`${path} is still running a ${state.progress.operation}`);
      }
    },
  };
}
