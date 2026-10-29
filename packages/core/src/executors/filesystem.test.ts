import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VolumeNameError } from '@ohr/shared/volume-name';

import { CommandError } from '../command-runner.ts';
import { fakeRunner, ok } from '../fake-system-test-helpers.ts';
import { filesystemLabel, makeFilesystem, mkfsCommand, readFilesystem } from './filesystem.ts';

const DEVICE = '/dev/ohr-p1/data';
const UUID = '43364e4c-acb5-4352-9811-eb8dea00d35b';
const BTRFS_BLKID = `DEVNAME=${DEVICE}\nLABEL=data\nUUID=${UUID}\nUUID_SUB=efddc638-f3c7-4dd4-8baa-033ac2124551\nBLOCK_SIZE=4096\nTYPE=btrfs\n`;
const EXT4_BLKID = `DEVNAME=${DEVICE}\nLABEL=data\nUUID=${UUID}\nBLOCK_SIZE=1024\nTYPE=ext4\n`;
const RAID_BLKID = `DEVNAME=${DEVICE}\nUUID=${UUID}\nTYPE=linux_raid_member\n`;
const SCRATCH_DIR = /ohr-btrfs-/u;
const NOT_OURS = /holds linux_raid_member, not an Open HR filesystem/u;
const WRONG_TYPE = /holds ext4 after making btrfs/u;

describe('filesystemLabel', () => {
  it('uses the volume name', () => {
    expect(filesystemLabel('btrfs', 'media-archive-2026')).toBe('media-archive-2026');
  });

  it('cuts the name to what ext4 can hold', () => {
    expect(filesystemLabel('ext4', 'media-archive-2026')).toBe('media-archive-20');
  });

  it('refuses an invalid name', () => {
    expect(() => filesystemLabel('btrfs', 'Media')).toThrow(VolumeNameError);
  });
});

describe('mkfsCommand', () => {
  it('formats btrfs quietly with a label', () => {
    expect(mkfsCommand({ device: DEVICE, type: 'btrfs', name: 'data' })).toEqual({
      command: 'mkfs.btrfs',
      args: ['--quiet', '--label', 'data', DEVICE],
    });
  });

  it('formats ext4 quietly with a label', () => {
    expect(mkfsCommand({ device: DEVICE, type: 'ext4', name: 'data' })).toEqual({
      command: 'mkfs.ext4',
      args: ['-q', '-L', 'data', DEVICE],
    });
  });
});

describe('readFilesystem', () => {
  it('reports the filesystem blkid finds', async () => {
    const { run } = fakeRunner(new Map([['blkid', ok(EXT4_BLKID)]]));
    expect(await readFilesystem(run, DEVICE)).toEqual({ type: 'ext4', uuid: UUID, label: 'data' });
  });

  it('refuses anything that is not btrfs or ext4', async () => {
    const { run } = fakeRunner(new Map([['blkid', ok(RAID_BLKID)]]));
    await expect(readFilesystem(run, DEVICE)).rejects.toThrow(NOT_OURS);
  });
});

describe('makeFilesystem', () => {
  it('formats btrfs, creates the subvolumes through a scratch mount, and reports it', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['mkfs.btrfs', ok('')],
        ['mount', ok('')],
        ['btrfs', ok('')],
        ['umount', ok('')],
        ['blkid', ok(BTRFS_BLKID)],
      ]),
    );
    const filesystem = await makeFilesystem(run, { device: DEVICE, type: 'btrfs', name: 'data' });
    expect(filesystem).toEqual({ type: 'btrfs', uuid: UUID, label: 'data' });
    expect(calls.map((call) => call.command)).toEqual([
      'mkfs.btrfs',
      'mount',
      'btrfs',
      'btrfs',
      'umount',
      'blkid',
    ]);
    const [, mount, data, snapshots, umount] = calls;
    const dir = mount?.args.at(-1) ?? '';
    expect(dir).toMatch(SCRATCH_DIR);
    expect(mount?.args).toEqual(['-t', 'btrfs', DEVICE, dir]);
    expect(data?.args).toEqual(['subvolume', 'create', `${dir}/@data`]);
    expect(snapshots?.args).toEqual(['subvolume', 'create', `${dir}/.snapshots`]);
    expect(umount?.args).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it('formats ext4 and reports it', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['mkfs.ext4', ok('')],
        ['blkid', ok(EXT4_BLKID)],
      ]),
    );
    const filesystem = await makeFilesystem(run, { device: DEVICE, type: 'ext4', name: 'data' });
    expect(filesystem).toEqual({ type: 'ext4', uuid: UUID, label: 'data' });
    expect(calls.map((call) => call.command)).toEqual(['mkfs.ext4', 'blkid']);
  });

  it('still unmounts the scratch mount when a subvolume cannot be created', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['mkfs.btrfs', ok('')],
        ['mount', ok('')],
        ['btrfs', { kind: 'exited', exitCode: 1, stdout: '', stderr: 'ERROR: cannot create' }],
        ['umount', ok('')],
      ]),
    );
    await expect(
      makeFilesystem(run, { device: DEVICE, type: 'btrfs', name: 'data' }),
    ).rejects.toThrow(CommandError);
    expect(calls.map((call) => call.command)).toEqual(['mkfs.btrfs', 'mount', 'btrfs', 'umount']);
    expect(existsSync(calls[1]?.args.at(-1) ?? '')).toBe(false);
  });

  it('fails when blkid sees a different filesystem than was made', async () => {
    const { run } = fakeRunner(
      new Map([
        ['mkfs.btrfs', ok('')],
        ['mount', ok('')],
        ['btrfs', ok('')],
        ['umount', ok('')],
        ['blkid', ok(EXT4_BLKID)],
      ]),
    );
    await expect(
      makeFilesystem(run, { device: DEVICE, type: 'btrfs', name: 'data' }),
    ).rejects.toThrow(WRONG_TYPE);
  });
});
