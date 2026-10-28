import { describe, expect, it } from 'vitest';

import { readFixture } from './fixtures-test-helpers.ts';
import { flattenBlockDevices, parseLsblk } from './lsblk.ts';
import { ParseError } from './parse-error.ts';

describe('parseLsblk: current format', () => {
  it('reads real output from a VM with virtio disks', () => {
    const devices = parseLsblk(readFixture('virtio-vm/lsblk.json'));
    const vda = devices.find((device) => device.name === 'vda');
    expect(vda).toMatchObject({
      path: '/dev/vda',
      type: 'disk',
      sizeBytes: 274_877_906_944,
      transport: 'virtio',
      rotational: true,
      removable: false,
      model: null,
      mountpoints: ['/'],
      children: [],
    });
    const zram = devices.find((device) => device.name === 'zram0');
    expect(zram?.mountpoints).toEqual([]);
  });

  it('reads nested partitions, md arrays, and logical volumes', () => {
    const devices = parseLsblk(readFixture('example-shr1/lsblk.json'));
    expect(devices.map((device) => device.name)).toEqual(['nvme0n1', 'sda', 'sdb', 'sdc']);
    const sdb = devices.find((device) => device.name === 'sdb');
    expect(sdb?.children.map((child) => [child.name, child.partNumber, child.partLabel])).toEqual([
      ['sdb1', 1, 'ohr:p1:label'],
      ['sdb2', 2, 'ohr:p1:t1'],
      ['sdb3', 3, 'ohr:p1:t2'],
    ]);
    const md = sdb?.children[1]?.children[0];
    expect(md).toMatchObject({ name: 'md127', type: 'raid5', fsType: 'LVM2_member' });
    expect(md?.children[0]).toMatchObject({ type: 'lvm', mountpoints: ['/mnt/ohr/data'] });
  });

  it('flattens the tree with parents first', () => {
    const all = flattenBlockDevices(parseLsblk(readFixture('example-shr1/lsblk.json')));
    const names = all.map((device) => device.name);
    expect(names.indexOf('sda')).toBeLessThan(names.indexOf('sda2'));
    expect(names.indexOf('sda2')).toBeLessThan(names.indexOf('md127'));
    expect(names.filter((name) => name === 'md127')).toHaveLength(3);
  });
});

describe('parseLsblk: older formats and bad input', () => {
  it('accepts the "0" and "1" strings older util-linux prints for flags', () => {
    const text = JSON.stringify({
      blockdevices: [
        {
          name: 'sda',
          path: '/dev/sda',
          pkname: null,
          type: 'disk',
          size: '4000787030016',
          model: 'WDC WD40EFZX-68AWUN0   ',
          serial: '',
          wwn: null,
          tran: 'sata',
          rota: '1',
          rm: '0',
          ro: '0',
          fstype: null,
          uuid: null,
          partuuid: null,
          partlabel: null,
          parttype: null,
          partn: null,
          mountpoints: [null],
        },
      ],
    });
    expect(parseLsblk(text)[0]).toMatchObject({
      sizeBytes: 4_000_787_030_016,
      rotational: true,
      removable: false,
      model: 'WDC WD40EFZX-68AWUN0',
      serial: null,
    });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a missing device list', '{}'],
    [
      'a device without a size',
      '{"blockdevices":[{"name":"sda","path":"/dev/sda","type":"disk"}]}',
    ],
  ])('rejects %s', (_label, text) => {
    expect(() => parseLsblk(text)).toThrow(ParseError);
  });
});
