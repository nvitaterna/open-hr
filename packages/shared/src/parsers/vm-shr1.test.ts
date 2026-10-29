/**
 * Real output from a Debian 13 VM with an SHR-1 pool built by hand on six
 * disks of 2, 4, 4, 6, 8, and 8 GiB. See fixtures/README.md.
 */

import { describe, expect, it } from 'vitest';

import { parseBlkid } from './blkid.ts';
import { parseFindmnt } from './findmnt.ts';
import { readFixture } from './fixtures-test-helpers.ts';
import { flattenBlockDevices, parseLsblk } from './lsblk.ts';
import { parseLvs, parsePvs, parseVgs } from './lvm.ts';
import { parseMdadmDetail } from './mdadm-detail.ts';
import { isDegraded, parseMdstat } from './mdstat.ts';
import { parseSmartctl } from './smartctl.ts';

const ARRAYS = ['md124', 'md125', 'md126', 'md127'];

describe('vm-shr1: real SHR-1 pool', () => {
  it('lsblk shows every tier partition with its Open HR name', () => {
    const devices = flattenBlockDevices(parseLsblk(readFixture('vm-shr1/lsblk.json')));
    const labels = devices
      .filter((device) => device.partLabel?.startsWith('ohr-dev-') === true)
      .map((device) => device.partLabel);
    // 6 label partitions and 6 + 5 + 3 + 2 tier partitions.
    expect(labels).toHaveLength(22);
    expect(labels.filter((label) => label === 'ohr-dev-label')).toHaveLength(6);
  });

  it('mdstat shows four healthy arrays once the initial sync is done', () => {
    const arrays = parseMdstat(readFixture('vm-shr1/mdstat.txt'));
    expect(arrays.map((array) => [array.name, array.level, array.members.length])).toEqual([
      ['md124', 'raid1', 2],
      ['md125', 'raid5', 3],
      ['md126', 'raid5', 5],
      ['md127', 'raid5', 6],
    ]);
    expect(arrays.every((array) => !isDegraded(array) && array.sync === null)).toBe(true);
  });

  it('mdstat during the initial build shows one recovery and three delayed resyncs', () => {
    const arrays = parseMdstat(readFixture('vm-shr1/mdstat-resync.txt'));
    expect(arrays.map((array) => [array.name, array.sync?.action, array.sync?.state])).toEqual([
      ['md124', 'resync', 'delayed'],
      ['md125', 'resync', 'delayed'],
      ['md126', 'resync', 'delayed'],
      ['md127', 'recovery', 'running'],
    ]);
  });

  it('mdadm --detail names each array after its tier', () => {
    const names = ARRAYS.map(
      (name) => parseMdadmDetail(readFixture(`vm-shr1/mdadm-detail-${name}.txt`)).devName,
    );
    expect(names).toEqual(['ohr_dev_t4', 'ohr_dev_t3', 'ohr_dev_t2', 'ohr_dev_t1']);
  });

  it('LVM shows one volume group over the four arrays', () => {
    expect(parsePvs(readFixture('vm-shr1/pvs.json'))).toHaveLength(4);
    expect(parseVgs(readFixture('vm-shr1/vgs.json'))).toMatchObject([
      { name: 'ohr-dev', physicalVolumeCount: 4, logicalVolumeCount: 1, freeBytes: 0 },
    ]);
    expect(parseLvs(readFixture('vm-shr1/lvs.json'))).toMatchObject([{ name: 'data' }]);
  });

  it('blkid and findmnt parse', () => {
    expect(parseBlkid(readFixture('vm-shr1/blkid.txt')).length).toBeGreaterThan(0);
    expect(parseFindmnt(readFixture('vm-shr1/findmnt.json'))).toContainEqual(
      expect.objectContaining({ target: '/mnt/ohr/data', fsType: 'btrfs' }),
    );
  });

  it('smartctl on a QEMU disk reports no health verdict', () => {
    const report = parseSmartctl(readFixture('vm-shr1/smartctl-sda.json'));
    expect(report.protocol).toBe('SCSI');
    expect(report.passed).toBeNull();
  });
});
