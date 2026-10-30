import { describe, expect, it } from 'vitest';

import { CommandError } from '../command-runner.ts';
import { fakeRunner, fixture, ok } from '../fake-system-test-helpers.ts';
import {
  addMembers,
  convertToRaid5,
  failMember,
  growDevices,
  mdadmAddArgs,
  mdadmChunkArgs,
  mdadmConvertToRaid5Args,
  mdadmFailArgs,
  mdadmGrowDevicesArgs,
  mdadmRemoveArgs,
  mdadmReplaceArgs,
  removeMember,
  replaceMember,
  setChunk,
} from './md-reshape.ts';

const ARRAY = '/dev/md/ohr_dev_t4';
const NOT_A_DEVICE = /must be a device path/u;
const NO_MEMBERS = /at least one member/u;
const TOO_FEW = /at least 2 members, got 1/u;
const SELF_REPLACE = /cannot replace itself/u;

/** A runner where every mdadm change succeeds and the detail is the vm-shr1 RAID1 tier. */
function detailRunner(): ReturnType<typeof fakeRunner> {
  return fakeRunner(
    new Map([
      ['mdadm', ok('')],
      [`mdadm ${ARRAY}`, ok(fixture('vm-shr1/mdadm-detail-md124.txt'))],
    ]),
  );
}

describe('mdadm argument builders', () => {
  it('adds partitions in manage mode', () => {
    expect(mdadmAddArgs(ARRAY, ['/dev/sdh5', '/dev/sdi5'])).toEqual([
      ...['--manage', ARRAY, '--add'],
      ...['/dev/sdh5', '/dev/sdi5'],
    ]);
  });

  it('grows the member count without a backup file', () => {
    expect(mdadmGrowDevicesArgs(ARRAY, 4)).toEqual(['--grow', ARRAY, '--raid-devices=4']);
  });

  it('changes the level and the chunk in two separate commands', () => {
    expect(mdadmConvertToRaid5Args(ARRAY)).toEqual(['--grow', ARRAY, '--level=5']);
    expect(mdadmChunkArgs(ARRAY)).toEqual(['--grow', ARRAY, '--chunk=512']);
  });

  it('replaces a member with a spare', () => {
    expect(
      mdadmReplaceArgs({ array: ARRAY, oldMember: '/dev/sdf5', newMember: '/dev/sdh5' }),
    ).toEqual(['--manage', ARRAY, '--replace', '/dev/sdf5', '--with', '/dev/sdh5']);
  });

  it('fails and removes a member', () => {
    expect(mdadmFailArgs(ARRAY, '/dev/sdf5')).toEqual(['--manage', ARRAY, '--fail', '/dev/sdf5']);
    expect(mdadmRemoveArgs(ARRAY, '/dev/sdf5')).toEqual([
      ...['--manage', ARRAY, '--remove'],
      '/dev/sdf5',
    ]);
  });

  it.each(['failed', 'detached'] as const)('removes every %s member by keyword', (keyword) => {
    expect(mdadmRemoveArgs(ARRAY, keyword)).toEqual(['--manage', ARRAY, '--remove', keyword]);
  });

  it('refuses anything that is not a device path', () => {
    expect(() => mdadmAddArgs('md0', ['/dev/sdh5'])).toThrow(NOT_A_DEVICE);
    expect(() => mdadmAddArgs(ARRAY, ['--force'])).toThrow(NOT_A_DEVICE);
    expect(() => mdadmFailArgs(ARRAY, 'failed')).toThrow(NOT_A_DEVICE);
    expect(() => mdadmRemoveArgs(ARRAY, 'all')).toThrow(NOT_A_DEVICE);
    expect(() => mdadmChunkArgs('/dev/md 0')).toThrow(NOT_A_DEVICE);
  });

  it('refuses an empty add, a one-member grow, and a member replacing itself', () => {
    expect(() => mdadmAddArgs(ARRAY, [])).toThrow(NO_MEMBERS);
    expect(() => mdadmGrowDevicesArgs(ARRAY, 1)).toThrow(TOO_FEW);
    expect(() =>
      mdadmReplaceArgs({ array: ARRAY, oldMember: '/dev/sdf5', newMember: '/dev/sdf5' }),
    ).toThrow(SELF_REPLACE);
  });
});

describe('mdadm changes', () => {
  it.each([
    [
      'add',
      (run) => addMembers(run, { array: ARRAY, members: ['/dev/sdh5'] }),
      mdadmAddArgs(ARRAY, ['/dev/sdh5']),
    ],
    [
      'grow',
      (run) => growDevices(run, { array: ARRAY, raidDevices: 3 }),
      mdadmGrowDevicesArgs(ARRAY, 3),
    ],
    ['convert', (run) => convertToRaid5(run, ARRAY), mdadmConvertToRaid5Args(ARRAY)],
    ['chunk', (run) => setChunk(run, ARRAY), mdadmChunkArgs(ARRAY)],
    [
      'replace',
      (run) => replaceMember(run, { array: ARRAY, oldMember: '/dev/sdf5', newMember: '/dev/sdh5' }),
      mdadmReplaceArgs({ array: ARRAY, oldMember: '/dev/sdf5', newMember: '/dev/sdh5' }),
    ],
    [
      'fail',
      (run) => failMember(run, { array: ARRAY, member: '/dev/sdf5' }),
      mdadmFailArgs(ARRAY, '/dev/sdf5'),
    ],
    [
      'remove',
      (run) => removeMember(run, { array: ARRAY, member: 'failed' }),
      mdadmRemoveArgs(ARRAY, 'failed'),
    ],
  ] satisfies [
    string,
    (run: ReturnType<typeof fakeRunner>['run']) => Promise<unknown>,
    string[],
  ][])('%s runs mdadm, then reports the array', async (_name, change, args) => {
    const { run, calls } = detailRunner();
    await expect(change(run)).resolves.toMatchObject({ level: 'raid1', devName: 'ohr_dev_t4' });
    expect(calls).toEqual([
      { command: 'mdadm', args },
      { command: 'mdadm', args: ['--detail', '--export', ARRAY] },
    ]);
  });

  it('stops when mdadm refuses', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['mdadm', { kind: 'exited', exitCode: 1, stdout: '', stderr: 'mdadm: Need a backup file' }],
      ]),
    );
    await expect(growDevices(run, { array: ARRAY, raidDevices: 3 })).rejects.toThrow(CommandError);
    expect(calls).toHaveLength(1);
  });
});
