import { describe, expect, it } from 'vitest';

import { fakeRunner, ok } from '../fake-system-test-helpers.ts';
import { growFilesystem, growFilesystemCommand } from './grow-filesystem.ts';

const DEVICE = '/dev/ohr-p1/data';
const BAD_MOUNT_POINT = /Mount point must be/u;

describe('growFilesystemCommand', () => {
  it('grows btrfs through its mount point', () => {
    expect(
      growFilesystemCommand({ device: DEVICE, type: 'btrfs', mountPoint: '/srv/ohr/data' }),
    ).toEqual({ command: 'btrfs', args: ['filesystem', 'resize', 'max', '/srv/ohr/data'] });
  });

  it('grows ext4 through its device', () => {
    expect(
      growFilesystemCommand({ device: DEVICE, type: 'ext4', mountPoint: '/srv/ohr/data' }),
    ).toEqual({ command: 'resize2fs', args: [DEVICE] });
  });

  it('refuses a mount point that is not a normalized absolute path', () => {
    expect(() =>
      growFilesystemCommand({ device: DEVICE, type: 'btrfs', mountPoint: 'srv/data' }),
    ).toThrow(BAD_MOUNT_POINT);
  });
});

describe('growFilesystem', () => {
  it('runs the grow command once', async () => {
    const { run, calls } = fakeRunner(new Map([['resize2fs', ok('')]]));
    await growFilesystem(run, { device: DEVICE, type: 'ext4', mountPoint: '/srv/ohr/data' });
    expect(calls).toEqual([{ command: 'resize2fs', args: [DEVICE] }]);
  });
});
