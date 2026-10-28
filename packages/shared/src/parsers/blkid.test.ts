import { describe, expect, it } from 'vitest';

import { parseBlkid } from './blkid.ts';
import { readFixture } from './fixtures-test-helpers.ts';
import { ParseError } from './parse-error.ts';

describe('parseBlkid', () => {
  const entries = parseBlkid(readFixture('example-shr1/blkid.txt'));

  it('reads one entry per device', () => {
    expect(entries.map((entry) => [entry.device, entry.type])).toEqual([
      ['/dev/nvme0n1p1', 'vfat'],
      ['/dev/nvme0n1p2', 'ext4'],
      ['/dev/sda2', 'linux_raid_member'],
      ['/dev/sdb3', 'linux_raid_member'],
      ['/dev/md127', 'LVM2_member'],
      ['/dev/mapper/ohr--p1-data', 'btrfs'],
    ]);
  });

  it('removes backslash escapes from values', () => {
    expect(entries[0]?.partLabel).toBe('EFI system partition');
  });

  it('reads Open HR partition labels', () => {
    expect(entries[2]).toMatchObject({ partLabel: 'ohr:p1:t1', label: 'nas:ohr_p1_t1' });
  });

  it('returns nothing for empty output', () => {
    expect(parseBlkid('')).toEqual([]);
  });

  it('rejects a block without a device name', () => {
    expect(() => parseBlkid(['TYPE=ext4', 'UUID=abc'].join('\n'))).toThrow(ParseError);
  });
});
