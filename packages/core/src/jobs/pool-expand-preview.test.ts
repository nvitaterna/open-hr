import { describe, expect, it } from 'vitest';

import type { ExpansionAction } from '@ohr/shared/expansion-plan';
import type { PoolExpandRequest } from '@ohr/shared/pool-expand-request';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import {
  EXAMPLE_POOL_UUID,
  exampleLsblkWithEmptyDrive,
  exampleShr1Answers,
  exampleShr1Labels,
  fakeFiles,
  fakeLabelIo,
  fakeRunner,
  fixture,
  ok,
} from '../fake-system-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { previewPoolExpand, recheckPoolExpand } from './pool-expand-preview.ts';

const EIGHT_TB = 8_001_563_222_016;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MDSTAT_HEALTHY = /md126 : active raid1 sdc3\[1\] sdb3\[0\]\n(?<status>.*)\n/u;

interface MachineEdits {
  readonly mdstat?: string;
  readonly labels?: boolean;
}

/** The worked example with an empty 8 TB sdd, read the way core reads it. */
function machine(edits: MachineEdits = {}): Promise<SystemSnapshot> {
  const answers = exampleShr1Answers();
  answers.set('lsblk', ok(exampleLsblkWithEmptyDrive('sdd', EIGHT_TB)));
  let labelIo = exampleShr1Labels();
  if (edits.labels === false) {
    labelIo = fakeLabelIo(new Map());
  }
  return readSystemState({
    run: fakeRunner(answers).run,
    readFile: fakeFiles(
      new Map([['/proc/mdstat', edits.mdstat ?? fixture('example-shr1/mdstat.txt')]]),
    ),
    includeSmart: false,
    labelIo,
  });
}

function describeAction(action: ExpansionAction): string {
  if ('tier' in action) {
    return `${action.kind} ${action.tier}`;
  }
  return `${action.kind} ${action.drive}`;
}

function request(devices: readonly string[], wipe = false): PoolExpandRequest {
  return { poolId: 'p1', devices: [...devices], wipe };
}

describe('previewPoolExpand', () => {
  it('plans adding an 8 TB drive: both tiers grow and the RAID1 tier becomes RAID5', async () => {
    const snapshot = await machine();
    const result = previewPoolExpand(request(['/dev/sdd']), snapshot, snapshot.drives);
    if (!result.ok) {
      throw new Error(result.reasons.join('; '));
    }
    const input = result.value;
    expect(input).toMatchObject({ poolId: 'p1', poolUuid: EXAMPLE_POOL_UUID, redundancy: 'shr1' });
    expect(input.newDrives).toEqual([
      expect.objectContaining({ path: '/dev/sdd', sizeBytes: EIGHT_TB, serial: 'FAKE-sdd' }),
    ]);
    expect(input.newDrives[0]?.driveUuid).toMatch(UUID);
    expect(input.actions.map(describeAction)).toEqual([
      'partition-drive /dev/sdd',
      'grow-tier 1',
      'convert-to-raid5 2',
      'grow-tier 2',
      'resize-physical-volume 1',
      'resize-physical-volume 2',
    ]);
    expect(input.target.tiers.map((tier) => [tier.level, tier.members.length])).toEqual([
      ['raid5', 4],
      ['raid5', 3],
    ]);
    expect(input.target.usableBytes).toBeGreaterThan(input.usableBytesBefore);
  });

  it('refuses drives in the pool, the system drive, unknown drives, and duplicates', async () => {
    const snapshot = await machine();
    const result = previewPoolExpand(
      request(['/dev/sda', '/dev/nvme0n1', '/dev/sdq', '/dev/sdd', '/dev/sdd']),
      snapshot,
      snapshot.drives,
    );
    expect(result).toEqual({
      ok: false,
      reasons: [
        '/dev/sda is already in pool p1.',
        '/dev/nvme0n1 holds the operating system. Open HR never uses it.',
        '/dev/sdq is not a physical drive on this machine.',
        '/dev/sdd is listed more than once.',
      ],
    });
  });

  it('refuses while a tier is resyncing', async () => {
    const mdstat = fixture('example-shr1/mdstat.txt').replace(
      MDSTAT_HEALTHY,
      (line) =>
        `${line}      [==>..................]  resync = 12.5% (1/8) finish=60.0min speed=1000K/sec\n`,
    );
    const snapshot = await machine({ mdstat });
    const result = previewPoolExpand(request(['/dev/sdd']), snapshot, snapshot.drives);
    expect(result).toEqual({
      ok: false,
      reasons: ['Tier 2 is running a resync, 12% done. Wait for it to finish.'],
    });
  });

  it('refuses a pool it has no label for, and a pool that does not exist', async () => {
    const snapshot = await machine({ labels: false });
    const unlabelled = previewPoolExpand(request(['/dev/sdd']), snapshot, snapshot.drives);
    expect(unlabelled.ok).toBe(false);
    const missing = previewPoolExpand({ ...request([]), poolId: 'p9' }, snapshot, snapshot.drives);
    expect(missing).toEqual({ ok: false, reasons: ['There is no pool p9.'] });
  });

  it('says when there is nothing to do', async () => {
    const snapshot = await machine();
    const result = previewPoolExpand(request([]), snapshot, snapshot.drives);
    expect(result.ok).toBe(false);
  });
});

describe('recheckPoolExpand', () => {
  it('accepts what a preview built and refuses a changed plan', async () => {
    const snapshot = await machine();
    const result = previewPoolExpand(request(['/dev/sdd']), snapshot, snapshot.drives);
    if (!result.ok) {
      throw new Error(result.reasons.join('; '));
    }
    expect(recheckPoolExpand(result.value, snapshot, snapshot.drives)).toEqual([]);
    const tampered = { ...result.value, actions: result.value.actions.slice(1) };
    expect(recheckPoolExpand(tampered, snapshot, snapshot.drives)).toEqual([
      'The submitted change does not match a fresh preview of this pool. Preview it again.',
    ]);
  });
});
