import { describe, expect, it } from 'vitest';

import type { FileReader } from '../command-runner.ts';
import type { SyncProgress } from '../executors/md-sync.ts';
import { fakeRunner } from '../fake-system-test-helpers.ts';
import { waitStep } from './wait-step.ts';

const SYSFS = '/sys/block/md126/md';
/** sync_completed on each busy read; the array is idle after them. */
const COMPLETED = ['5 / 100', '15 / 100', '18 / 100'];

/** An array that reshapes through COMPLETED, then goes idle. */
function reshaping(): FileReader {
  let reads = 0;
  return (path) => {
    if (path === `${SYSFS}/sync_action`) {
      reads += 1;
      if (reads <= COMPLETED.length) {
        return Promise.resolve('reshape');
      }
      return Promise.resolve('idle');
    }
    if (path === `${SYSFS}/sync_completed`) {
      return Promise.resolve(COMPLETED[reads - 1] ?? 'none');
    }
    if (path === `${SYSFS}/reshape_position`) {
      return Promise.resolve('none');
    }
    if (path === `${SYSFS}/degraded`) {
      return Promise.resolve('0');
    }
    return Promise.resolve('');
  };
}

describe('wait step', () => {
  it('reports every progress read and logs a line each tenth', async () => {
    const step = waitStep(
      'p1',
      { tier: 2, what: 'reshape' },
      {
        files: reshaping(),
        kernelName: () => Promise.resolve('md126'),
        pollIntervalMs: 0,
        delay: () => Promise.resolve(),
      },
    );
    const lines: string[] = [];
    const updates: SyncProgress[] = [];
    await step.action({
      run: fakeRunner(new Map()).run,
      log: (line) => lines.push(line),
      progress: (update) => updates.push(update),
    });
    expect(updates).toEqual([
      { operation: 'reshape', fraction: 0.05, etaSeconds: null },
      { operation: 'reshape', fraction: 0.15, etaSeconds: null },
      { operation: 'reshape', fraction: 0.18, etaSeconds: null },
    ]);
    expect(lines).toEqual(['reshape 5% done', 'reshape 15% done']);
  });
});
