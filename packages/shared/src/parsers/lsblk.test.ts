import { describe, expect, it } from 'vitest';

import { readFixture } from './fixtures-test-helpers.ts';
import { flattenBlockDevices, parseLsblk } from './lsblk.ts';
import { ParseError } from './parse-error.ts';

/** Matches the `"partn": n,` line of a fixture, to make it look like util-linux 2.38 output. */
const PARTN_FIELD = /"partn": [^,]+,/gu;

/** One partition as Debian 12's lsblk prints it: every column the parser asks for, no PARTN. */
const DEBIAN_12_PARTITION = {
  name: 'sdb1',
  path: '/dev/sdb1',
  pkname: 'sdb',
  type: 'part',
  size: '1048576',
  model: null,
  serial: null,
  wwn: null,
  tran: null,
  rota: false,
  rm: false,
  ro: false,
  fstype: null,
  uuid: null,
  partuuid: null,
  partlabel: null,
  parttype: null,
  start: 2048,
  mountpoints: [null],
};

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
      ['sdb1', 1, 'ohr-p1-label'],
      ['sdb2', 2, 'ohr-p1-t1'],
      ['sdb3', 3, 'ohr-p1-t2'],
    ]);
    const md = sdb?.children[1]?.children[0];
    expect(md).toMatchObject({ name: 'md127', type: 'raid5', fsType: 'LVM2_member' });
    expect(md?.children[0]).toMatchObject({ type: 'lvm', mountpoints: ['/mnt/ohr/data'] });
  });

  it('reads partition numbers from device names when lsblk has no PARTN column, as on Debian 12', () => {
    const withoutPartn = readFixture('example-shr1/lsblk.json').replaceAll(PARTN_FIELD, '');
    const numbers = flattenBlockDevices(parseLsblk(withoutPartn)).map((device) => [
      device.name,
      device.partNumber,
    ]);
    expect(numbers).toContainEqual(['nvme0n1p3', 3]);
    expect(numbers).toContainEqual(['sdb3', 3]);
    expect(numbers).toContainEqual(['sda', null]);
    expect(numbers).toContainEqual(['md127', null]);
  });

  it.each([
    ['sdb', 'sdb12', 12],
    ['nvme0n1', 'nvme0n1p2', 2],
    ['loop0', 'loop0p1', 1],
    ['mmcblk0', 'mmcblk0p3', 3],
    ['sdb', 'sdc1', null],
    ['sdb', 'sdb', null],
  ])('numbers partition %s/%s as %s', (pkname, name, expected) => {
    const partition = { ...DEBIAN_12_PARTITION, name, path: `/dev/${name}`, pkname };
    const disk = {
      ...DEBIAN_12_PARTITION,
      name: pkname,
      path: `/dev/${pkname}`,
      pkname: null,
      type: 'disk',
      children: [partition],
    };
    const [parsed] = parseLsblk(JSON.stringify({ blockdevices: [disk] }));
    expect(parsed?.children[0]?.partNumber).toBe(expected);
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
