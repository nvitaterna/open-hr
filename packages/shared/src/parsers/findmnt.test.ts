import { describe, expect, it } from 'vitest';

import { parseFindmnt } from './findmnt.ts';
import { readFixture } from './fixtures-test-helpers.ts';
import { ParseError } from './parse-error.ts';

describe('parseFindmnt', () => {
  it('flattens real output from a VM', () => {
    const mounts = parseFindmnt(readFixture('virtio-vm/findmnt.json'));
    expect(mounts[0]).toMatchObject({ target: '/', device: '/dev/vda', fsType: 'ext4' });
    expect(mounts[0]?.options).toContain('relatime');
    expect(mounts.some((mount) => mount.target === '/sys/fs/cgroup/cpu')).toBe(true);
  });

  it('separates a btrfs subvolume from its device', () => {
    const mounts = parseFindmnt(readFixture('example-shr1/findmnt.json'));
    const data = mounts.find((mount) => mount.target === '/mnt/ohr/data');
    expect(data).toMatchObject({
      source: '/dev/mapper/ohr--p1-data[/@data]',
      device: '/dev/mapper/ohr--p1-data',
      fsType: 'btrfs',
    });
    expect(data?.sizeBytes).toBeGreaterThan(0);
  });

  it('rejects output without a filesystem list', () => {
    expect(() => parseFindmnt('{"mounts":[]}')).toThrow(ParseError);
  });
});
