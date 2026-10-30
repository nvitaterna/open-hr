import { describe, expect, it } from 'vitest';

import type { FileReader } from '../command-runner.ts';
import { fakeFiles, fixture } from '../fake-system-test-helpers.ts';
import { readSyncState, type SyncProgress, waitForSync } from './md-sync.ts';

const NOT_RUNNING = /md9 is not running/u;
const BAD_NAME = /md kernel name/u;
const STILL_DEGRADED = /md127 has no rebuild running but is still degraded/u;
const RESHAPE_MDSTAT = `md127 : active raid5 sdd2[3] sdc2[2] sdb2[1]
      7813772288 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]
      [===>.................]  reshape = 17.3% (676123456/3906886144) finish=812.5min speed=66273K/sec
`;
const IDLE_MDSTAT = `md127 : active raid5 sdd2[3] sdc2[2] sdb2[1]
      7813772288 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]
`;

interface SysfsState {
  readonly mdstat: string;
  readonly action: string;
  readonly completed?: string;
  readonly reshapePosition?: string;
  readonly degraded?: string;
}

function sysfs(name: string, state: SysfsState): FileReader {
  const md = `/sys/block/${name}/md`;
  return fakeFiles(
    new Map([
      ['/proc/mdstat', state.mdstat],
      [`${md}/sync_action`, `${state.action}\n`],
      [`${md}/sync_completed`, `${state.completed ?? 'none'}\n`],
      [`${md}/reshape_position`, `${state.reshapePosition ?? 'none'}\n`],
      [`${md}/degraded`, `${state.degraded ?? '0'}\n`],
    ]),
  );
}

/** Files that change to the next state each time the waiter pauses. */
function sequence(states: readonly SysfsState[]): {
  files: FileReader;
  delay: () => Promise<void>;
  pauses: () => number;
} {
  let step = 0;
  return {
    files: (path) => {
      const state = states[Math.min(step, states.length - 1)];
      if (state === undefined) {
        throw new Error('no states');
      }
      return sysfs('md127', state)(path);
    },
    delay: () => {
      step += 1;
      return Promise.resolve();
    },
    pauses: () => step,
  };
}

const RESHAPING: SysfsState = {
  mdstat: RESHAPE_MDSTAT,
  action: 'reshape',
  completed: '1953443072 / 7813772288',
  reshapePosition: '1352246912',
};
const IDLE: SysfsState = { mdstat: IDLE_MDSTAT, action: 'idle' };

describe('readSyncState', () => {
  it('is idle when the array has no work', async () => {
    await expect(readSyncState(sysfs('md127', IDLE), 'md127')).resolves.toEqual({
      kind: 'idle',
      degraded: false,
    });
  });

  it('reports a degraded idle array', async () => {
    await expect(
      readSyncState(sysfs('md127', { ...IDLE, degraded: '1' }), 'md127'),
    ).resolves.toEqual({ kind: 'idle', degraded: true });
  });

  it('reports a reshape with the fraction from sysfs and the kernel estimate', async () => {
    const state = await readSyncState(sysfs('md127', RESHAPING), 'md127');
    expect(state).toEqual({
      kind: 'busy',
      progress: { operation: 'reshape', fraction: 0.25, etaSeconds: 48_750 },
    });
  });

  it('names a recovery as the kernel shows it and falls back to the mdstat percent', async () => {
    const files = sysfs('md127', {
      mdstat: fixture('vm-shr1/mdstat-resync.txt'),
      action: 'recover',
    });
    await expect(readSyncState(files, 'md127')).resolves.toEqual({
      kind: 'busy',
      progress: { operation: 'recovery', fraction: 0.708, etaSeconds: 0 },
    });
  });

  it('counts work queued behind another array as busy, with no progress yet', async () => {
    const files = sysfs('md124', {
      mdstat: fixture('vm-shr1/mdstat-resync.txt'),
      action: 'idle',
    });
    await expect(readSyncState(files, 'md124')).resolves.toEqual({
      kind: 'busy',
      progress: { operation: 'resync', fraction: null, etaSeconds: null },
    });
  });

  it('counts a frozen array part way through a reshape as reshaping', async () => {
    const files = sysfs('md127', { ...IDLE, action: 'frozen', reshapePosition: '4096' });
    await expect(readSyncState(files, 'md127')).resolves.toMatchObject({
      kind: 'busy',
      progress: { operation: 'reshape' },
    });
  });

  it('counts a member still flagged as a replacement as a recovery', async () => {
    const mdstat = IDLE_MDSTAT.replace('sdd2[3]', 'sdd2[3](R)');
    await expect(readSyncState(sysfs('md127', { ...IDLE, mdstat }), 'md127')).resolves.toEqual({
      kind: 'busy',
      progress: { operation: 'recovery', fraction: null, etaSeconds: null },
    });
  });

  it('throws when the array is not running', async () => {
    await expect(readSyncState(fakeFiles(new Map()), 'md9')).rejects.toThrow(NOT_RUNNING);
  });

  it('refuses a name that is not an md kernel name', async () => {
    await expect(readSyncState(fakeFiles(new Map()), '../sda')).rejects.toThrow(BAD_NAME);
  });
});

describe('waitForSync', () => {
  it('reports progress until two idle reads in a row', async () => {
    const { files, delay, pauses } = sequence([RESHAPING, RESHAPING, IDLE, RESHAPING, IDLE]);
    const progress: SyncProgress[] = [];
    await waitForSync({
      files,
      array: 'md127',
      delay,
      onProgress: (update) => progress.push(update),
    });
    expect(progress.map((update) => update.operation)).toEqual(['reshape', 'reshape', 'reshape']);
    expect(pauses()).toBe(5);
  });

  it('returns after two reads when the array is already idle', async () => {
    const { files, delay, pauses } = sequence([IDLE]);
    await waitForSync({ files, array: 'md127', delay });
    expect(pauses()).toBe(1);
  });

  it('waits for a rebuild to start when asked to end in sync', async () => {
    const recovering = { ...RESHAPING, action: 'recover', reshapePosition: 'none', degraded: '1' };
    const { files, delay } = sequence([{ ...IDLE, degraded: '1' }, recovering, IDLE]);
    const progress: SyncProgress[] = [];
    await waitForSync({
      files,
      array: 'md127',
      delay,
      untilInSync: true,
      onProgress: (update) => progress.push(update),
    });
    expect(progress.map((update) => update.operation)).toEqual(['recovery']);
  });

  it('fails when an array that should end in sync stays degraded and idle', async () => {
    const { files, delay, pauses } = sequence([{ ...IDLE, degraded: '1' }]);
    await expect(waitForSync({ files, array: 'md127', delay, untilInSync: true })).rejects.toThrow(
      STILL_DEGRADED,
    );
    expect(pauses()).toBe(2);
  });

  it('returns for a degraded idle array when not asked to end in sync', async () => {
    const { files, delay } = sequence([{ ...IDLE, degraded: '1' }]);
    await expect(waitForSync({ files, array: 'md127', delay })).resolves.toBeUndefined();
  });

  it('stops waiting when aborted', async () => {
    const controller = new AbortController();
    const { files } = sequence([RESHAPING]);
    const delay = (): Promise<void> => {
      controller.abort();
      return Promise.resolve();
    };
    await expect(
      waitForSync({ files, array: 'md127', delay, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
