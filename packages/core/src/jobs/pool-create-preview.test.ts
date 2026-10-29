import { describe, expect, it } from 'vitest';

import type { PoolCreateRequest } from '@ohr/shared/pool-create-request';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import { exampleShr1Answers, exampleShr1Files, fakeRunner } from '../fake-system-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { previewPoolCreate, recheckPoolCreate } from './pool-create-preview.ts';

const UUID = /^[0-9a-f-]{36}$/u;

const REQUEST: PoolCreateRequest = {
  poolId: 'p2',
  redundancy: 'shr1',
  devices: ['/dev/sda', '/dev/sdb', '/dev/sdc'],
  wipe: true,
};

function example(): Promise<SystemSnapshot> {
  return readSystemState({
    run: fakeRunner(exampleShr1Answers()).run,
    readFile: exampleShr1Files(),
    includeSmart: false,
  });
}

function reasons(result: ReturnType<typeof previewPoolCreate>): readonly string[] {
  if (result.ok) {
    return [];
  }
  return result.reasons;
}

describe('previewPoolCreate', () => {
  it('refuses the OS drive, unknown and repeated drives, drives with data, and an id in use', async () => {
    const snapshot = await example();
    const result = previewPoolCreate(
      {
        poolId: 'p1',
        redundancy: 'shr1',
        devices: ['/dev/nvme0n1', '/dev/sda', '/dev/sda', '/dev/sdq'],
        wipe: false,
      },
      snapshot,
      snapshot.drives,
    );
    expect(reasons(result)).toEqual([
      '/dev/nvme0n1 holds the operating system. Open HR never uses it.',
      '/dev/sda is not empty (an Open HR pool). It has to be wiped first.',
      '/dev/sda is listed more than once.',
      '/dev/sdq is not a physical drive on this machine.',
      'Volume group ohr-p1 already exists. Choose another pool id.',
      'Arrays named ohr_p1_t* already exist. Choose another pool id.',
    ]);
  });

  it('explains why the drives cannot form a pool', async () => {
    const snapshot = await example();
    const result = previewPoolCreate({ ...REQUEST, redundancy: 'shr2' }, snapshot, snapshot.drives);
    expect(reasons(result).join('\n')).toContain('needs at least 4 drives');
  });

  it('plans the pool with fresh UUIDs when the drives may be wiped', async () => {
    const snapshot = await example();
    const result = previewPoolCreate(REQUEST, snapshot, snapshot.drives);
    if (!result.ok) {
      throw new Error(result.reasons.join('\n'));
    }
    const input = result.value;
    expect(input.poolId).toBe('p2');
    expect(input.poolUuid).toMatch(UUID);
    expect(input.drives.map((drive) => drive.path)).toEqual(REQUEST.devices);
    expect(new Set(input.drives.map((drive) => drive.driveUuid)).size).toBe(3);
    expect(input.layout.tiers.map((tier) => tier.level)).toEqual(['raid5', 'raid1']);
  });
});

describe('recheckPoolCreate', () => {
  async function planned(): Promise<{
    snapshot: SystemSnapshot;
    input: Extract<ReturnType<typeof previewPoolCreate>, { ok: true }>['value'];
  }> {
    const snapshot = await example();
    const result = previewPoolCreate(REQUEST, snapshot, snapshot.drives);
    if (!result.ok) {
      throw new Error(result.reasons.join('\n'));
    }
    return { snapshot, input: result.value };
  }

  it('accepts the input a preview built, unchanged', async () => {
    const { snapshot, input } = await planned();
    expect(recheckPoolCreate(input, snapshot, snapshot.drives)).toEqual([]);
  });

  it('refuses an input whose layout was changed after the preview', async () => {
    const { snapshot, input } = await planned();
    const tampered = {
      ...input,
      layout: { ...input.layout, usableBytes: input.layout.usableBytes + 1 },
    };
    expect(recheckPoolCreate(tampered, snapshot, snapshot.drives)).toEqual([
      'The submitted pool does not match a fresh preview of these drives. Preview it again.',
    ]);
  });

  it('refuses an input whose drive changed size or went away', async () => {
    const { snapshot, input } = await planned();
    const smaller = {
      ...input,
      drives: input.drives.map((drive) => ({ ...drive, sizeBytes: drive.sizeBytes - 1 })),
    };
    expect(recheckPoolCreate(smaller, snapshot, snapshot.drives)).toHaveLength(1);
    const gone = snapshot.drives.filter((drive) => drive.device.path !== '/dev/sdc');
    expect(recheckPoolCreate(input, snapshot, gone)).toEqual([
      '/dev/sdc is not a physical drive on this machine.',
    ]);
  });

  it('refuses a drive that is no longer allowed to be wiped', async () => {
    const { snapshot, input } = await planned();
    expect(recheckPoolCreate({ ...input, wipe: false }, snapshot, snapshot.drives)).toContain(
      '/dev/sdb is not empty (an Open HR pool). It has to be wiped first.',
    );
  });
});
