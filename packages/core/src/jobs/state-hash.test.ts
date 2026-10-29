import { describe, expect, it } from 'vitest';

import { exampleShr1Answers, exampleShr1Files, fakeRunner } from '../fake-system-test-helpers.ts';
import { readSystemState, type SystemSnapshot } from '../system-state.ts';
import { systemStateHash } from './state-hash.ts';

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

function snapshot(): Promise<SystemSnapshot> {
  return readSystemState({
    run: fakeRunner(exampleShr1Answers()).run,
    readFile: exampleShr1Files(),
    includeSmart: false,
  });
}

describe('systemStateHash', () => {
  it('is stable for the same state', async () => {
    const hash = systemStateHash(await snapshot());
    expect(hash).toMatch(HEX_SHA256);
    expect(systemStateHash(await snapshot())).toBe(hash);
  });

  it('ignores warnings and drive order', async () => {
    const base = await snapshot();
    const shuffled: SystemSnapshot = {
      ...base,
      drives: [...base.drives].reverse(),
      warnings: ['smartctl is not installed'],
    };
    expect(systemStateHash(shuffled)).toBe(systemStateHash(base));
  });

  it('changes when a drive, array, group, volume, or mount changes', async () => {
    const base = await snapshot();
    const hash = systemStateHash(base);
    const [first, ...rest] = base.drives;
    if (first === undefined) {
      throw new Error('no drives in fixture');
    }
    const grown: SystemSnapshot = {
      ...base,
      drives: [
        { ...first, device: { ...first.device, sizeBytes: first.device.sizeBytes + 1 } },
        ...rest,
      ],
    };
    expect(systemStateHash(grown)).not.toBe(hash);
    expect(systemStateHash({ ...base, mdArrays: [] })).not.toBe(hash);
    expect(systemStateHash({ ...base, volumeGroups: [] })).not.toBe(hash);
    expect(systemStateHash({ ...base, logicalVolumes: [] })).not.toBe(hash);
    expect(systemStateHash({ ...base, mounts: [] })).not.toBe(hash);
  });
});
