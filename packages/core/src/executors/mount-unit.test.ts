import { describe, expect, it } from 'vitest';

import { escapeSystemdPath, mountUnitName, mountUnitPath, renderMountUnit } from './mount-unit.ts';

const BAD_MOUNT_POINT = /Mount point must be a normalized absolute directory path/u;

describe('escapeSystemdPath', () => {
  /** Pairs checked against `systemd-escape --path` on Debian 13. */
  it.each([
    ['/mnt/ohr/data', 'mnt-ohr-data'],
    ['/mnt/ohr/my-vol_2', 'mnt-ohr-my\\x2dvol_2'],
    ['/tmp/ohr-itest-abc/data', 'tmp-ohr\\x2ditest\\x2dabc-data'],
    ['/mnt/ohr/.hidden', 'mnt-ohr-.hidden'],
    ['/a/b.c', 'a-b.c'],
    ['/mnt/ohr/with space', 'mnt-ohr-with\\x20space'],
    ['/mnt/ohr/ünï', 'mnt-ohr-\\xc3\\xbcn\\xc3\\xaf'],
    ['/mnt/ohr/x:y', 'mnt-ohr-x:y'],
    ['/mnt/ohr/data/', 'mnt-ohr-data'],
    ['/', '-'],
    ['/.config', '\\x2econfig'],
  ])('escapes %j as %j', (path, escaped) => {
    expect(escapeSystemdPath(path)).toBe(escaped);
  });
});

describe('mountUnitName', () => {
  it('adds the mount suffix', () => {
    expect(mountUnitName('/mnt/ohr/data')).toBe('mnt-ohr-data.mount');
    expect(mountUnitPath('/mnt/ohr/data', 'persistent')).toBe(
      '/etc/systemd/system/mnt-ohr-data.mount',
    );
    expect(mountUnitPath('/mnt/ohr/data', 'runtime')).toBe(
      '/run/systemd/system/mnt-ohr-data.mount',
    );
  });

  it('refuses a mount point that is not a normalized absolute path', () => {
    expect(() => mountUnitName('mnt/ohr/data')).toThrow(BAD_MOUNT_POINT);
  });
});

describe('renderMountUnit', () => {
  it('mounts the data subvolume of a btrfs volume, wanted by multi-user.target', () => {
    expect(
      renderMountUnit({
        poolId: 'p1',
        volume: 'data',
        device: '/dev/ohr-p1/data',
        type: 'btrfs',
        mountPoint: '/mnt/ohr/data',
      }),
    ).toBe(`[Unit]
Description=Open HR volume data in pool p1
Documentation=https://github.com/nvitaterna/open-hr

[Mount]
What=/dev/ohr-p1/data
Where=/mnt/ohr/data
Type=btrfs
Options=subvol=@data

[Install]
WantedBy=multi-user.target
`);
  });

  it('mounts ext4 with default options', () => {
    const unit = renderMountUnit({
      poolId: 'p1',
      volume: 'scratch',
      device: '/dev/ohr-p1/scratch',
      type: 'ext4',
      mountPoint: '/srv/scratch',
    });
    expect(unit).toContain('Type=ext4\nOptions=defaults\n');
    expect(unit).toContain('Where=/srv/scratch\n');
  });
});
