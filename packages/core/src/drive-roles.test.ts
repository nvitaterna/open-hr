import { describe, expect, it } from 'vitest';

import type { BlockDevice } from '@ohr/shared/parsers/lsblk';

import { driveRole, physicalDrives } from './drive-roles.ts';

function device(overrides: Partial<BlockDevice>): BlockDevice {
  return {
    name: 'sdx',
    path: '/dev/sdx',
    parentName: null,
    type: 'disk',
    sizeBytes: 4_000_000_000_000,
    model: null,
    serial: null,
    wwn: null,
    transport: 'sata',
    rotational: true,
    removable: false,
    readOnly: false,
    fsType: null,
    uuid: null,
    partUuid: null,
    partLabel: null,
    partType: null,
    partNumber: null,
    mountpoints: [],
    children: [],
    ...overrides,
  };
}

describe('driveRole', () => {
  it('calls a blank drive empty', () => {
    expect(driveRole(device({}))).toBe('empty');
  });

  it('calls a drive with a filesystem on the whole disk in use', () => {
    expect(driveRole(device({ fsType: 'ext4' }))).toBe('in-use');
  });

  it('calls a drive with foreign partitions in use', () => {
    expect(driveRole(device({ children: [device({ type: 'part', name: 'sdx1' })] }))).toBe(
      'in-use',
    );
  });

  it('recognises Open HR partitions by their label', () => {
    const part = device({ type: 'part', name: 'sdx1', partLabel: 'ohr-p1-label' });
    expect(driveRole(device({ children: [part] }))).toBe('ohr');
  });

  it('calls a drive holding swap or a system mount the system drive', () => {
    const swap = device({ type: 'part', name: 'sdx3', mountpoints: ['[SWAP]'] });
    expect(driveRole(device({ children: [swap] }))).toBe('system');
    const lv = device({ type: 'lvm', name: 'vg-root', mountpoints: ['/'] });
    const part = device({ type: 'part', name: 'sdx2', children: [lv] });
    expect(driveRole(device({ children: [part] }))).toBe('system');
  });

  it('ranks system above Open HR when both apply', () => {
    const ohr = device({ type: 'part', name: 'sdx1', partLabel: 'ohr-p1-t1' });
    const boot = device({ type: 'part', name: 'sdx2', mountpoints: ['/boot'] });
    expect(driveRole(device({ children: [ohr, boot] }))).toBe('system');
  });
});

describe('physicalDrives', () => {
  it('skips virtual, empty, and non-disk devices', () => {
    const devices = [
      device({ name: 'sda' }),
      device({ name: 'zram0' }),
      device({ name: 'loop0', type: 'loop' }),
      device({ name: 'sr0', type: 'rom' }),
      device({ name: 'sdb', sizeBytes: 0 }),
    ];
    expect(physicalDrives(devices).map((drive) => drive.name)).toEqual(['sda']);
  });
});
