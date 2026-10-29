import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VolumeNameError } from '@ohr/shared/volume-name';

import { CommandError } from '../command-runner.ts';
import { fakeRunner, ok } from '../fake-system-test-helpers.ts';
import { defaultMountPoint, mountArgs, mountVolume, readMount, unmountVolume } from './mount.ts';

const DEVICE = '/dev/ohr-p1/data';
const BAD_MOUNT_POINT = /Mount point must be a normalized absolute directory path/u;
const NOTHING_MOUNTED = /Expected one mount in the report, got 0/u;

function findmntReport(target: string, source: string, fstype: string, options: string): string {
  return JSON.stringify({
    filesystems: [{ target, source, fstype, options, size: 1024, used: 512, avail: 512 }],
  });
}

let scratch = '';

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'ohr-mount-test-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('defaultMountPoint', () => {
  it('lives under /mnt/ohr', () => {
    expect(defaultMountPoint('data')).toBe('/mnt/ohr/data');
  });

  it('refuses an invalid volume name', () => {
    expect(() => defaultMountPoint('../etc')).toThrow(VolumeNameError);
  });
});

describe('mountArgs', () => {
  it('mounts the data subvolume of a btrfs volume', () => {
    expect(mountArgs({ device: DEVICE, type: 'btrfs', mountPoint: '/mnt/ohr/data' })).toEqual([
      '-t',
      'btrfs',
      '-o',
      'subvol=@data',
      DEVICE,
      '/mnt/ohr/data',
    ]);
  });

  it('mounts ext4 with default options', () => {
    expect(mountArgs({ device: DEVICE, type: 'ext4', mountPoint: '/srv/data' })).toEqual([
      '-t',
      'ext4',
      DEVICE,
      '/srv/data',
    ]);
  });

  it.each(['', 'mnt/ohr/data', '/', '/mnt/ohr/data/', '/mnt/ohr/../data', '/mnt//ohr'])(
    'refuses mount point %j',
    (mountPoint) => {
      expect(() => mountArgs({ device: DEVICE, type: 'ext4', mountPoint })).toThrow(
        BAD_MOUNT_POINT,
      );
    },
  );
});

describe('mountVolume', () => {
  it('creates the directory, mounts, and reports the mount', async () => {
    const mountPoint = join(scratch, 'data');
    const { run, calls } = fakeRunner(
      new Map([
        ['mount', ok('')],
        [
          'findmnt',
          ok(findmntReport(mountPoint, `${DEVICE}[/@data]`, 'btrfs', 'rw,subvol=/@data')),
        ],
      ]),
    );
    const mount = await mountVolume(run, { device: DEVICE, type: 'btrfs', mountPoint });
    expect(mount).toMatchObject({
      target: mountPoint,
      device: DEVICE,
      fsType: 'btrfs',
      options: ['rw', 'subvol=/@data'],
    });
    expect(calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['mount', mountPoint],
      ['findmnt', mountPoint],
    ]);
  });

  it('fails when mount fails', async () => {
    const mountPoint = join(scratch, 'broken');
    const { run } = fakeRunner(
      new Map([['mount', { kind: 'exited', exitCode: 32, stdout: '', stderr: 'wrong fs type' }]]),
    );
    await expect(mountVolume(run, { device: DEVICE, type: 'ext4', mountPoint })).rejects.toThrow(
      CommandError,
    );
  });
});

describe('readMount', () => {
  it('fails when nothing is mounted there', async () => {
    const { run } = fakeRunner(new Map([['findmnt', ok('{"filesystems": []}')]]));
    await expect(readMount(run, '/mnt/ohr/data')).rejects.toThrow(NOTHING_MOUNTED);
  });
});

describe('unmountVolume', () => {
  it('unmounts the mount point', async () => {
    const { run, calls } = fakeRunner(new Map([['umount', ok('')]]));
    await unmountVolume(run, '/mnt/ohr/data');
    expect(calls).toEqual([{ command: 'umount', args: ['/mnt/ohr/data'] }]);
  });
});
