import { describe, expect, it } from 'vitest';

import { readFixture } from './fixtures-test-helpers.ts';
import { parseLvs, parsePvs, parseVgs } from './lvm.ts';
import { ParseError } from './parse-error.ts';

describe('LVM parsers', () => {
  it('reads physical volumes', () => {
    const pvs = parsePvs(readFixture('example-shr1/pvs.json'));
    expect(pvs.map((pv) => [pv.device, pv.volumeGroup])).toEqual([
      ['/dev/md126', 'ohr-p1'],
      ['/dev/md127', 'ohr-p1'],
    ]);
    expect(pvs[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('reads the real empty report LVM prints when there are no volumes', () => {
    expect(parsePvs(readFixture('virtio-vm/pvs-empty.json'))).toEqual([]);
  });

  it('reads volume groups and logical volumes', () => {
    const [vg] = parseVgs(readFixture('example-shr1/vgs.json'));
    expect(vg).toMatchObject({ name: 'ohr-p1', physicalVolumeCount: 2, logicalVolumeCount: 1 });
    const [lv] = parseLvs(readFixture('example-shr1/lvs.json'));
    expect(lv).toMatchObject({
      name: 'data',
      volumeGroup: 'ohr-p1',
      path: '/dev/ohr-p1/data',
      layout: 'linear',
      sizeBytes: vg?.sizeBytes,
    });
  });

  it('treats an empty volume group name as none', () => {
    const text = JSON.stringify({
      report: [
        { pv: [{ pv_name: '/dev/sdz', vg_name: '', pv_uuid: 'x', pv_size: '10', pv_free: '10' }] },
      ],
    });
    expect(parsePvs(text)[0]?.volumeGroup).toBeNull();
  });

  it('rejects sizes that still carry a unit suffix', () => {
    const text = JSON.stringify({
      report: [
        { pv: [{ pv_name: '/dev/sdz', vg_name: '', pv_uuid: 'x', pv_size: '10B', pv_free: '0' }] },
      ],
    });
    expect(() => parsePvs(text)).toThrow(ParseError);
  });
});
