import { describe, expect, it } from 'vitest';

import { readFixture } from './fixtures-test-helpers.ts';
import { parseMdadmDetail } from './mdadm-detail.ts';
import { ParseError } from './parse-error.ts';

describe('parseMdadmDetail', () => {
  it('reads an array and its members', () => {
    expect(parseMdadmDetail(readFixture('example-shr1/mdadm-detail-md127.txt'))).toEqual({
      level: 'raid5',
      raidDevices: 3,
      metadata: '1.2',
      uuid: '3d8e2d4a:91b7c6f0:5a2e8d14:7c0b9e63',
      devName: 'ohr_p1_t1',
      name: 'nas:ohr_p1_t1',
      members: [
        { device: '/dev/sda2', role: 0 },
        { device: '/dev/sdb2', role: 1 },
        { device: '/dev/sdc2', role: 2 },
      ],
    });
  });

  it('reads spare and faulty members', () => {
    const text = [
      'MD_LEVEL=raid5',
      'MD_DEVICES=3',
      'MD_UUID=a:b:c:d',
      'MD_DEVICE_dev_sdd2_ROLE=spare',
      'MD_DEVICE_dev_sdd2_DEV=/dev/sdd2',
      'MD_DEVICE_dev_sda2_ROLE=faulty',
      'MD_DEVICE_dev_sda2_DEV=/dev/sda2',
    ].join('\n');
    expect(parseMdadmDetail(text).members).toEqual([
      { device: '/dev/sda2', role: 'faulty' },
      { device: '/dev/sdd2', role: 'spare' },
    ]);
  });

  it.each([
    ['a missing level', 'MD_DEVICES=2\nMD_UUID=a'],
    ['a non-numeric device count', 'MD_LEVEL=raid1\nMD_DEVICES=two\nMD_UUID=a'],
    [
      'an unknown role',
      'MD_LEVEL=raid1\nMD_DEVICES=2\nMD_UUID=a\nMD_DEVICE_x_ROLE=odd\nMD_DEVICE_x_DEV=/dev/x',
    ],
    ['a role without a device', 'MD_LEVEL=raid1\nMD_DEVICES=2\nMD_UUID=a\nMD_DEVICE_x_ROLE=0'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseMdadmDetail(text)).toThrow(ParseError);
  });
});
