import { describe, expect, it } from 'vitest';

import type { FileReader } from '../command-runner.ts';
import type { SyncProgress } from '../executors/md-sync.ts';
import { fakeRunner, ok } from '../fake-system-test-helpers.ts';
import type { StepDefinition } from './engine.ts';
import { waitStep } from './wait-step.ts';

const SYSFS = '/sys/block/md126/md';
/** sync_completed on each busy read; the array is idle after them. */
const COMPLETED = ['5 / 100', '15 / 100', '18 / 100'];

const DETAIL = [
  'MD_LEVEL=raid5',
  'MD_DEVICES=3',
  'MD_METADATA=1.2',
  'MD_UUID=0c1a2b3d:4e5f6a7b:8c9d0e1f:2a3b4c5d',
  'MD_DEVNAME=ohr_p1_t2',
  '',
].join('\n');

/** An array in `arrayState` that reshapes through COMPLETED, then goes idle. */
function reshaping(arrayState = 'clean'): FileReader {
  let reads = 0;
  return (path) => {
    if (path === `${SYSFS}/array_state`) {
      return Promise.resolve(`${arrayState}\n`);
    }
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

function reshapeWait(files: FileReader): StepDefinition {
  return waitStep(
    'p1',
    { tier: 2, what: 'reshape' },
    {
      files,
      kernelName: () => Promise.resolve('md126'),
      pollIntervalMs: 0,
      delay: () => Promise.resolve(),
    },
  );
}

describe('wait step', () => {
  it('reports every progress read and logs a line each tenth', async () => {
    const step = reshapeWait(reshaping());
    const lines: string[] = [];
    const updates: SyncProgress[] = [];
    const runner = fakeRunner(new Map());
    await step.action({
      run: runner.run,
      log: (line) => lines.push(line),
      progress: (update) => updates.push(update),
    });
    expect(updates).toEqual([
      { operation: 'reshape', fraction: 0.05, etaSeconds: null },
      { operation: 'reshape', fraction: 0.15, etaSeconds: null },
      { operation: 'reshape', fraction: 0.18, etaSeconds: null },
    ]);
    expect(lines).toEqual(['reshape 5% done', 'reshape 15% done']);
    expect(runner.calls).toEqual([]);
  });

  it('sets an auto-read-only array read-write before waiting, as after a reboot', async () => {
    const step = reshapeWait(reshaping('read-auto'));
    const lines: string[] = [];
    const runner = fakeRunner(new Map([['mdadm', ok(DETAIL)]]));
    await step.action({
      run: runner.run,
      log: (line) => lines.push(line),
      progress: () => undefined,
    });
    expect(runner.calls.at(0)).toEqual({
      command: 'mdadm',
      args: ['--readwrite', '/dev/md/ohr_p1_t2'],
    });
    expect(lines.at(0)).toBe(
      '/dev/md/ohr_p1_t2 is auto-read-only; setting it read-write so its work continues',
    );
  });

  it('waits until a grown array has the size its members give', async () => {
    const sizes = ['400', '400', '600'];
    const answers = new Map([
      [`${SYSFS}/level`, 'raid5'],
      [`${SYSFS}/raid_disks`, '4'],
      [`${SYSFS}/component_size`, '100'],
      [`${SYSFS}/sync_action`, 'idle'],
      [`${SYSFS}/reshape_position`, 'none'],
      [`${SYSFS}/degraded`, '0'],
    ]);
    const reshaped: FileReader = (path) => {
      if (path !== '/sys/block/md126/size') {
        return Promise.resolve(answers.get(path) ?? '');
      }
      if (sizes.length > 1) {
        return Promise.resolve(sizes.shift() ?? '');
      }
      return Promise.resolve(sizes[0] ?? '');
    };
    await reshapeWait(reshaped).action({
      run: fakeRunner(new Map()).run,
      log: () => undefined,
      progress: () => undefined,
    });
    expect(sizes).toEqual(['600']);
  });
});
