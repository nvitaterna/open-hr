import { describe, expect, it } from 'vitest';

import { VolumeNameError } from '@ohr/shared/volume-name';

import { CommandError } from '../command-runner.ts';
import { fakeRunner, ok } from '../fake-system-test-helpers.ts';
import {
  createLogicalVolume,
  createPhysicalVolume,
  createVolumeGroup,
  extendLogicalVolume,
  extendVolumeGroup,
  logicalVolumePath,
  lvcreateArgs,
  lvextendArgs,
  resizePhysicalVolume,
  vgcreateArgs,
  vgextendArgs,
} from './lvm.ts';

const MIB = 1024 ** 2;
const ARRAYS = ['/dev/md/ohr_p1_t1', '/dev/md/ohr_p1_t2'];
const REPORT_ARGS = ['--reportformat', 'json', '--units', 'b', '--nosuffix', '--options'];
const NOT_WHOLE_EXTENTS = /whole number of 4194304-byte extents/u;
const NO_PHYSICAL_VOLUMES = /at least one physical volume/u;
const NOTHING_TO_ADD = /at least one physical volume to add/u;
const NOT_ONE_ROW = /Expected one volume group in the report, got 0/u;

const PV_UUID = 'Ddlhu9-3vYH-l2Fo-vGM6-pcNE-Fnq2-llSfjK';
const ARRAY_BYTES = 1_071_644_672;
const GROUP_BYTES = 1_069_547_520;

/** What pvs prints for one new physical volume on a 1 GiB RAID1 array. */
const PVS_REPORT = `{"report":[{"pv":[{"pv_name":"/dev/md127","vg_name":"","pv_uuid":"${PV_UUID}","pv_size":"${ARRAY_BYTES}","pv_free":"${ARRAY_BYTES}","pe_start":"1048576"}]}]}`;

const VGS_REPORT = `{"report":[{"vg":[{"vg_name":"ohr-p1","vg_uuid":"3loFLx-NS7h-gjet-uHOv-DAuN-pxda-TFHB0j","vg_size":"${GROUP_BYTES}","vg_free":"${GROUP_BYTES}","pv_count":"1","lv_count":"0"}]}]}`;

const EMPTY_VGS_REPORT = '{"report":[{"vg":[]}]}';

const LVS_REPORT = `{"report":[{"lv":[{"lv_name":"data","vg_name":"ohr-p1","lv_uuid":"L9iN9H-Rr0i-v2V6-sjs3-9zG0-rX0P-ahmvqR","lv_size":"${GROUP_BYTES}","lv_path":"/dev/ohr-p1/data","lv_attr":"-wi-a-----","lv_layout":"linear"}]}]}`;

describe('logicalVolumePath', () => {
  it('is the device link under the volume group', () => {
    expect(logicalVolumePath('p1', 'data')).toBe('/dev/ohr-p1/data');
  });

  it('refuses an invalid volume name', () => {
    expect(() => logicalVolumePath('p1', 'Data')).toThrow(VolumeNameError);
  });
});

describe('vgcreateArgs', () => {
  it('names the group after the pool and pins the extent size', () => {
    expect(vgcreateArgs({ poolId: 'p1', physicalVolumes: ARRAYS })).toEqual([
      '--physicalextentsize',
      '4M',
      'ohr-p1',
      ...ARRAYS,
    ]);
  });

  it('refuses an empty group', () => {
    expect(() => vgcreateArgs({ poolId: 'p1', physicalVolumes: [] })).toThrow(NO_PHYSICAL_VOLUMES);
  });
});

describe('lvcreateArgs', () => {
  it('takes all free space without asking about old signatures', () => {
    expect(lvcreateArgs({ poolId: 'p1', name: 'data', size: { kind: 'all-free' } })).toEqual([
      ...['--yes', '--wipesignatures', 'y', '--zero', 'y'],
      ...['--extents', '100%FREE', '--name', 'data', 'ohr-p1'],
    ]);
  });

  it('gives an exact size in bytes', () => {
    const args = lvcreateArgs({
      poolId: 'p1',
      name: 'media',
      size: { kind: 'bytes', bytes: 8 * MIB },
    });
    expect(args).toContain('--size');
    expect(args).toContain('8388608b');
  });

  it('refuses a size that is not whole extents', () => {
    expect(() =>
      lvcreateArgs({ poolId: 'p1', name: 'media', size: { kind: 'bytes', bytes: 5 * MIB } }),
    ).toThrow(NOT_WHOLE_EXTENTS);
  });

  it('refuses an invalid volume name', () => {
    expect(() =>
      lvcreateArgs({ poolId: 'p1', name: 'snapshot', size: { kind: 'all-free' } }),
    ).toThrow(VolumeNameError);
  });
});

describe('createPhysicalVolume', () => {
  it('wipes, creates, and reports the physical volume', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['wipefs', ok('')],
        ['pvcreate', ok('')],
        ['pvs', ok(PVS_REPORT)],
      ]),
    );
    const pv = await createPhysicalVolume(run, '/dev/md/ohr_p1_t1');
    expect(pv).toEqual({
      device: '/dev/md127',
      volumeGroup: null,
      uuid: PV_UUID,
      sizeBytes: ARRAY_BYTES,
      freeBytes: ARRAY_BYTES,
      firstExtentBytes: 1_048_576,
    });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['wipefs', '--all', '--quiet', '/dev/md/ohr_p1_t1'],
      ['pvcreate', '/dev/md/ohr_p1_t1'],
      [
        'pvs',
        ...REPORT_ARGS,
        'pv_name,vg_name,pv_uuid,pv_size,pv_free,pe_start',
        '/dev/md/ohr_p1_t1',
      ],
    ]);
  });

  it('stops at the first failing command', async () => {
    const { run, calls } = fakeRunner(
      new Map([['wipefs', { kind: 'exited', exitCode: 1, stdout: '', stderr: 'busy' }]]),
    );
    await expect(createPhysicalVolume(run, '/dev/md/ohr_p1_t1')).rejects.toThrow(CommandError);
    expect(calls).toHaveLength(1);
  });
});

describe('createVolumeGroup', () => {
  it('creates the group and reports it', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['vgcreate', ok('')],
        ['vgs', ok(VGS_REPORT)],
      ]),
    );
    const vg = await createVolumeGroup(run, { poolId: 'p1', physicalVolumes: ARRAYS });
    expect(vg).toMatchObject({ name: 'ohr-p1', sizeBytes: GROUP_BYTES, physicalVolumeCount: 1 });
    expect(calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['vgcreate', '/dev/md/ohr_p1_t2'],
      ['vgs', 'ohr-p1'],
    ]);
  });

  it('fails when the report does not show the group', async () => {
    const { run } = fakeRunner(
      new Map([
        ['vgcreate', ok('')],
        ['vgs', ok(EMPTY_VGS_REPORT)],
      ]),
    );
    await expect(createVolumeGroup(run, { poolId: 'p1', physicalVolumes: ARRAYS })).rejects.toThrow(
      NOT_ONE_ROW,
    );
  });
});

describe('createLogicalVolume', () => {
  it('creates the volume, waits for udev, and reports it', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['lvcreate', ok('')],
        ['udevadm', ok('')],
        ['lvs', ok(LVS_REPORT)],
      ]),
    );
    const lv = await createLogicalVolume(run, {
      poolId: 'p1',
      name: 'data',
      size: { kind: 'all-free' },
    });
    expect(lv).toMatchObject({
      name: 'data',
      volumeGroup: 'ohr-p1',
      sizeBytes: GROUP_BYTES,
      path: '/dev/ohr-p1/data',
      layout: 'linear',
    });
    expect(calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['lvcreate', 'ohr-p1'],
      ['udevadm', 'settle'],
      ['lvs', 'ohr-p1/data'],
    ]);
  });
});

describe('vgextendArgs', () => {
  it('adds the arrays to the pool group', () => {
    expect(vgextendArgs({ poolId: 'p1', physicalVolumes: ARRAYS })).toEqual(['ohr-p1', ...ARRAYS]);
  });

  it('refuses to add nothing', () => {
    expect(() => vgextendArgs({ poolId: 'p1', physicalVolumes: [] })).toThrow(NOTHING_TO_ADD);
  });
});

describe('lvextendArgs', () => {
  it('takes all free space', () => {
    expect(lvextendArgs({ poolId: 'p1', name: 'data', size: { kind: 'all-free' } })).toEqual([
      ...['--extents', '+100%FREE'],
      '/dev/ohr-p1/data',
    ]);
  });

  it('grows to an exact size, so a second run asks for the same size', () => {
    expect(
      lvextendArgs({ poolId: 'p1', name: 'data', size: { kind: 'bytes', bytes: 16 * MIB } }),
    ).toEqual(['--size', `${16 * MIB}b`, '/dev/ohr-p1/data']);
  });

  it('refuses a size that is not whole extents', () => {
    expect(() =>
      lvextendArgs({ poolId: 'p1', name: 'data', size: { kind: 'bytes', bytes: MIB } }),
    ).toThrow(NOT_WHOLE_EXTENTS);
  });
});

describe('resizePhysicalVolume', () => {
  it('resizes and reports the physical volume', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['pvresize', ok('')],
        ['pvs', ok(PVS_REPORT)],
      ]),
    );
    const pv = await resizePhysicalVolume(run, '/dev/md127');
    expect(pv).toMatchObject({ device: '/dev/md127', sizeBytes: ARRAY_BYTES });
    expect(calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['pvresize', '/dev/md127'],
      ['pvs', '/dev/md127'],
    ]);
  });
});

describe('extendVolumeGroup', () => {
  it('extends and reports the group', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['vgextend', ok('')],
        ['vgs', ok(VGS_REPORT)],
      ]),
    );
    const vg = await extendVolumeGroup(run, { poolId: 'p1', physicalVolumes: ARRAYS });
    expect(vg).toMatchObject({ name: 'ohr-p1', sizeBytes: GROUP_BYTES });
    expect(calls.map((call) => call.command)).toEqual(['vgextend', 'vgs']);
    expect(calls[0]?.args).toEqual(['ohr-p1', ...ARRAYS]);
  });
});

describe('extendLogicalVolume', () => {
  it('extends and reports the volume without touching its filesystem', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['lvextend', ok('')],
        ['lvs', ok(LVS_REPORT)],
      ]),
    );
    const lv = await extendLogicalVolume(run, {
      poolId: 'p1',
      name: 'data',
      size: { kind: 'all-free' },
    });
    expect(lv).toMatchObject({ name: 'data', sizeBytes: GROUP_BYTES });
    expect(calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['lvextend', '/dev/ohr-p1/data'],
      ['lvs', 'ohr-p1/data'],
    ]);
    expect(calls[0]?.args).not.toContain('--resizefs');
  });
});
