import { describe, expect, it } from 'vitest';

import { CommandError } from '../command-runner.ts';
import { fakeRunner, fixture, ok } from '../fake-system-test-helpers.ts';
import { createArray, mdArrayPath, mdadmCreateArgs } from './md-array.ts';

const THREE_MEMBERS = ['/dev/sda2', '/dev/sdb2', '/dev/sdc2'];
/** The members of tier 1 in the vm-shr1 fixtures. */
const VM_MEMBERS = ['/dev/sda2', '/dev/sdc2', '/dev/sdd2', '/dev/sde2', '/dev/sdf2', '/dev/sdg2'];
const TOO_FEW = /raid6 needs at least 4 members, got 3/u;
const INVALID_POOL_ID = /Invalid pool id/u;

describe('mdArrayPath', () => {
  it('is the named link under /dev/md', () => {
    expect(mdArrayPath('p1', 2)).toBe('/dev/md/ohr_p1_t2');
  });
});

describe('mdadmCreateArgs', () => {
  it('creates a RAID5 tier with the settings from the plan', () => {
    expect(
      mdadmCreateArgs({ poolId: 'p1', tier: 1, level: 'raid5', members: THREE_MEMBERS }),
    ).toEqual([
      '--create',
      '/dev/md/ohr_p1_t1',
      '--run',
      '--metadata=1.2',
      '--homehost=any',
      '--name=ohr_p1_t1',
      '--level=raid5',
      '--raid-devices=3',
      '--bitmap=internal',
      '--chunk=512',
      ...THREE_MEMBERS,
    ]);
  });

  it('gives RAID1 no chunk size, which mdadm refuses', () => {
    const args = mdadmCreateArgs({
      poolId: 'p1',
      tier: 2,
      level: 'raid1',
      members: ['/dev/sdb3', '/dev/sdc3'],
    });
    expect(args).toContain('--level=raid1');
    expect(args).toContain('--raid-devices=2');
    expect(args.some((arg) => arg.startsWith('--chunk'))).toBe(false);
    expect(args.slice(-2)).toEqual(['/dev/sdb3', '/dev/sdc3']);
  });

  it('refuses fewer members than the level needs', () => {
    expect(() =>
      mdadmCreateArgs({ poolId: 'p1', tier: 1, level: 'raid6', members: THREE_MEMBERS }),
    ).toThrow(TOO_FEW);
  });

  it('refuses an invalid pool id', () => {
    expect(() =>
      mdadmCreateArgs({ poolId: 'Pool-1', tier: 1, level: 'raid5', members: THREE_MEMBERS }),
    ).toThrow(INVALID_POOL_ID);
  });
});

describe('createArray', () => {
  it('creates the array, waits for udev, and reports what mdadm sees', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['mdadm', ok('')],
        ['udevadm', ok('')],
        ['mdadm /dev/md/ohr_dev_t1', ok(fixture('vm-shr1/mdadm-detail-md127.txt'))],
      ]),
    );
    const request = { poolId: 'dev', tier: 1, level: 'raid5', members: VM_MEMBERS } as const;
    const detail = await createArray(run, request);
    expect(detail).toMatchObject({
      level: 'raid5',
      raidDevices: 6,
      metadata: '1.2',
      devName: 'ohr_dev_t1',
      name: 'any:ohr_dev_t1',
    });
    expect(detail.members.map((member) => member.device)).toEqual(VM_MEMBERS);
    expect(calls.map((call) => call.command)).toEqual(['mdadm', 'udevadm', 'mdadm']);
    expect(calls[0]?.args).toEqual(mdadmCreateArgs(request));
    expect(calls[1]?.args).toEqual(['settle']);
    expect(calls[2]?.args).toEqual(['--detail', '--export', '/dev/md/ohr_dev_t1']);
  });

  it('stops at the first failing command', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        [
          'mdadm',
          { kind: 'exited', exitCode: 1, stdout: '', stderr: 'mdadm: cannot open /dev/sda2' },
        ],
      ]),
    );
    await expect(
      createArray(run, { poolId: 'p1', tier: 1, level: 'raid5', members: THREE_MEMBERS }),
    ).rejects.toThrow(CommandError);
    expect(calls).toHaveLength(1);
  });
});
