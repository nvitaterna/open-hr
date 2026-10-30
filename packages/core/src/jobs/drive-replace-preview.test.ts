import { describe, expect, it } from 'vitest';

import type { DriveReplaceRequest } from '@ohr/shared/drive-replace-request';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import {
  EXAMPLE_POOL_UUID,
  exampleLsblkWithEmptyDrive,
  exampleShr1Answers,
  exampleShr1Labels,
  fakeFiles,
  fakeRunner,
  fixture,
  ok,
} from '../fake-system-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { previewDriveReplace, recheckDriveReplace } from './drive-replace-preview.ts';

const EIGHT_TB = 8_001_563_222_016;
const FOUR_TB = 4_000_787_030_016;
const MD127_HEALTHY =
  /md127 : active raid5 sdc2\[2\] sdb2\[1\] sda2\[0\]\n(?<blocks>.*)\[3\/3\] \[UUU\]/u;

/** The worked example with an empty drive sdd of `size`, and /proc/mdstat changed by `edit`. */
function machine(
  size = EIGHT_TB,
  edit: (mdstat: string) => string = (mdstat) => mdstat,
): Promise<SystemSnapshot> {
  const answers = exampleShr1Answers();
  answers.set('lsblk', ok(exampleLsblkWithEmptyDrive('sdd', size)));
  return readSystemState({
    run: fakeRunner(answers).run,
    readFile: fakeFiles(new Map([['/proc/mdstat', edit(fixture('example-shr1/mdstat.txt'))]])),
    includeSmart: false,
    labelIo: exampleShr1Labels(),
  });
}

function request(oldDrive: string | null, newDrive = '/dev/sdd'): DriveReplaceRequest {
  return { poolId: 'p1', oldDrive, newDrive, wipe: false };
}

function modes(snapshot: SystemSnapshot, oldDrive: string | null): string[] {
  const result = previewDriveReplace(request(oldDrive), snapshot, snapshot.drives);
  if (!result.ok) {
    throw new Error(result.reasons.join('; '));
  }
  return result.value.actions.map((action) => {
    if (action.kind === 'replace-member') {
      return `tier ${action.tier} ${action.mode}`;
    }
    return action.kind;
  });
}

describe('previewDriveReplace', () => {
  it('copies a healthy drive live in every tier it is in', async () => {
    const snapshot = await machine();
    const result = previewDriveReplace(request('/dev/sdb'), snapshot, snapshot.drives);
    if (!result.ok) {
      throw new Error(result.reasons.join('; '));
    }
    expect(result.value).toMatchObject({
      poolId: 'p1',
      poolUuid: EXAMPLE_POOL_UUID,
      oldDrive: '/dev/sdb',
      newDrives: [{ path: '/dev/sdd', sizeBytes: EIGHT_TB }],
    });
    expect(result.value.target.usableBytes).toBe(result.value.usableBytesBefore);
    expect(modes(snapshot, '/dev/sdb')).toEqual(['partition-drive', 'tier 1 live', 'tier 2 live']);
  });

  it('rebuilds the tier where the drive failed and copies the other live', async () => {
    const snapshot = await machine(EIGHT_TB, (mdstat) =>
      mdstat.replace(
        MD127_HEALTHY,
        'md127 : active raid5 sdc2[2] sdb2[1](F) sda2[0]\n$<blocks>[3/2] [U_U]',
      ),
    );
    expect(modes(snapshot, '/dev/sdb')).toEqual([
      'partition-drive',
      'tier 1 rebuild',
      'tier 2 live',
    ]);
  });

  it('rebuilds the drive that is no longer in its array when none is named', async () => {
    const snapshot = await machine(EIGHT_TB, (mdstat) =>
      mdstat.replace(MD127_HEALTHY, 'md127 : active raid5 sdc2[2] sdb2[1]\n$<blocks>[3/2] [_UU]'),
    );
    expect(modes(snapshot, null)).toEqual(['partition-drive', 'tier 1 rebuild']);
  });

  it('refuses a new drive that is too small or already in the pool', async () => {
    const small = await machine(FOUR_TB);
    const tooSmall = previewDriveReplace(request('/dev/sdb'), small, small.drives);
    expect(tooSmall.ok).toBe(false);
    const snapshot = await machine();
    expect(previewDriveReplace(request('/dev/sdb', '/dev/sdc'), snapshot, snapshot.drives)).toEqual(
      { ok: false, reasons: ['/dev/sdc is already in pool p1.'] },
    );
  });

  it('refuses to replace a drive that is not in the pool, or a missing one when none is', async () => {
    const snapshot = await machine();
    expect(previewDriveReplace(request('/dev/nvme0n1'), snapshot, snapshot.drives).ok).toBe(false);
    expect(previewDriveReplace(request(null), snapshot, snapshot.drives).ok).toBe(false);
  });
});

describe('recheckDriveReplace', () => {
  it('accepts what a preview built and refuses a changed plan', async () => {
    const snapshot = await machine();
    const result = previewDriveReplace(request('/dev/sdb'), snapshot, snapshot.drives);
    if (!result.ok) {
      throw new Error(result.reasons.join('; '));
    }
    expect(recheckDriveReplace(result.value, snapshot, snapshot.drives)).toEqual([]);
    expect(
      recheckDriveReplace({ ...result.value, oldDrive: '/dev/sdc' }, snapshot, snapshot.drives),
    ).not.toEqual([]);
  });
});
