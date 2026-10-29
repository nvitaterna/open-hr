import { describe, expect, it } from 'vitest';

import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import { type CachedState, StateCache } from './state-cache.ts';

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

function snapshot(warning: string): SystemSnapshot {
  return {
    drives: [],
    mdArrays: [],
    physicalVolumes: [],
    volumeGroups: [],
    logicalVolumes: [],
    mounts: [],
    warnings: [warning],
  };
}

/** A read the test finishes by hand, to control overlap. */
function controlledReads(): {
  read: () => Promise<SystemSnapshot>;
  finish: (warning: string) => void;
  count: () => number;
} {
  const waiting: ((value: SystemSnapshot) => void)[] = [];
  let started = 0;
  return {
    read: () => {
      started += 1;
      return new Promise((resolve) => waiting.push(resolve));
    },
    finish: (warning) => waiting.shift()?.(snapshot(warning)),
    count: () => started,
  };
}

const NOW = new Date('2026-10-29T12:00:00.000Z');

describe('StateCache', () => {
  it('reads once and then serves the cached state', async () => {
    let reads = 0;
    const cache = new StateCache({
      read: () => {
        reads += 1;
        return Promise.resolve(snapshot('a'));
      },
      onChange: () => undefined,
      now: () => NOW,
    });
    const first = await cache.get();
    const second = await cache.get();
    expect(second).toBe(first);
    expect(first.readAt).toBe(NOW.toISOString());
    expect(first.stateHash).toMatch(HEX_SHA256);
    expect(reads).toBe(1);
  });

  it('reports a change only when the snapshot differs', async () => {
    const changes: CachedState[] = [];
    let warning = 'a';
    const cache = new StateCache({
      read: () => Promise.resolve(snapshot(warning)),
      onChange: (state) => changes.push(state),
    });
    await cache.refresh();
    await cache.refresh();
    expect(changes).toEqual([]);
    warning = 'b';
    await cache.refresh();
    expect(changes.map((state) => state.snapshot.warnings)).toEqual([['b']]);
  });

  it('coalesces refreshes asked for during a read into one more read', async () => {
    const reads = controlledReads();
    const cache = new StateCache({ read: reads.read, onChange: () => undefined });
    const first = cache.refresh();
    const second = cache.refresh();
    const third = cache.refresh();
    expect(second).toBe(third);
    expect(reads.count()).toBe(1);
    reads.finish('first');
    await expect(first).resolves.toMatchObject({ snapshot: { warnings: ['first'] } });
    await expect.poll(() => reads.count()).toBe(2);
    reads.finish('second');
    await expect(second).resolves.toMatchObject({ snapshot: { warnings: ['second'] } });
    expect(reads.count()).toBe(2);
  });

  it('runs the queued read even when the running one fails', async () => {
    let calls = 0;
    const cache = new StateCache({
      read: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error('lsblk failed'));
        }
        return Promise.resolve(snapshot('ok'));
      },
      onChange: () => undefined,
    });
    const failing = cache.refresh();
    const queued = cache.refresh();
    await expect(failing).rejects.toThrow('lsblk failed');
    await expect(queued).resolves.toMatchObject({ snapshot: { warnings: ['ok'] } });
  });
});
