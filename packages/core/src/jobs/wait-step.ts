/**
 * The step that waits for md to finish a reshape, recovery, or resync
 * (decision 0011). It only reads, so after a daemon restart or a reboot it
 * attaches to the work the kernel kept running. It reports every progress
 * read and logs a line each tenth.
 */

import { mdArrayPath } from '../executors/md-array.ts';
import { readSyncState, type SyncProgress, waitForSync } from '../executors/md-sync.ts';
import type { StepContext, StepDefinition } from './engine.ts';
import { READY } from './pool-steps.ts';
import type { MdDeps } from './reshape-steps.ts';

const PERCENT = 100;
/** Progress is logged each time it passes another tenth. */
const LOG_STEPS = 10;
const SECONDS_PER_MINUTE = 60;

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
    async action({ log, progress }: StepContext) {
      const logProgress = progressLogger(log);
      await waitForSync({
        files: deps.files,
        array: await deps.kernelName(path),
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
