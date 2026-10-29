/**
 * Runs the executors against real loop devices. Needs root, systemd, sgdisk,
 * mdadm, LVM, mkfs.btrfs, mkfs.ext4, wipefs, and losetup. Run with `pnpm --filter @ohr/core test:integration` as
 * root; the normal test run skips this file.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LSBLK_COLUMNS, parseLsblk } from '@ohr/shared/parsers/lsblk';
import { type MdDetail, parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import type { MdArrayDefinition } from '@ohr/shared/parsers/mdadm-scan';
import {
  type Layout,
  type PlannedPartition,
  type PlannedTier,
  planPool,
} from '@ohr/shared/planner';

import { runChecked, runCommand } from '../command-runner.ts';
import { driveRole } from '../drive-roles.ts';
import { makeFilesystem, readFilesystem } from './filesystem.ts';
import { blockDeviceIo, readLabel, writeLabel } from './label-partition.ts';
import {
  createLogicalVolume,
  createPhysicalVolume,
  createVolumeGroup,
  logicalVolumePath,
} from './lvm.ts';
import { createArray, mdArrayPath } from './md-array.ts';
import { arrayDefinition, writeMdadmConf } from './mdadm-conf.ts';
import { mountVolume, readMount, unmountVolume } from './mount.ts';
import { installMountUnit, removeMountUnit } from './mount-unit.ts';
import { partitionDrive, partitionPath } from './partition-drive.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const SIZES = [2 * GIB, 4 * GIB, 4 * GIB];
const POOL = 'itest';
const VOLUME_GROUP = `ohr-${POOL}`;
const SCRATCH_BYTES = 8 * MIB;
const DATA_SUBVOLUME = / path @data$/mu;
const SNAPSHOTS_SUBVOLUME = / path \.snapshots$/mu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface SfdiskPartition {
  readonly node: string;
  readonly start: number;
  readonly size: number;
  readonly type: string;
  readonly name: string;
}

interface SfdiskTable {
  readonly partitiontable: { readonly sectorsize: number; readonly partitions: SfdiskPartition[] };
}

const isRoot = process.getuid?.() === 0;
const loops: string[] = [];
/** Arrays created by the tests, stopped before the loop devices are detached. */
const arrays: string[] = [];
/** Set once the volume group exists, so teardown removes it before stopping the arrays. */
let volumeGroupCreated = false;
/** Mount points still mounted, unmounted first in teardown. */
const mounts: string[] = [];
/** Mount points with a runtime mount unit, removed first in teardown. */
const mountUnits: string[] = [];
let workDir = '';

async function readTable(device: string): Promise<SfdiskTable> {
  return JSON.parse(await runChecked(runCommand, 'sfdisk', ['--json', device])) as SfdiskTable;
}

function plannedLayout(): Layout {
  const plan = planPool(
    loops.map((path, index) => ({ id: path, sizeBytes: SIZES[index] ?? 0 })),
    'shr1',
  );
  if (!plan.ok) {
    throw new Error(`plan failed: ${plan.error.code}`);
  }
  return plan.layout;
}

function expectedName(partition: PlannedPartition): string {
  if (partition.tier === null) {
    return `ohr-${POOL}-label`;
  }
  return `ohr-${POOL}-t${partition.tier}`;
}

/** Sparse files attached as loop devices, one per size. Attached one at a time: losetup --find races. */
async function attachLoopDevices(): Promise<void> {
  workDir = await mkdtemp(join(tmpdir(), 'ohr-itest-'));
  for (const [index, size] of SIZES.entries()) {
    const file = join(workDir, `drive${index}.img`);
    await writeFile(file, '');
    await truncate(file, size);
    const loop = await runChecked(runCommand, 'losetup', ['--find', '--partscan', '--show', file]);
    loops.push(loop.trim());
  }
}

async function tearDown(): Promise<void> {
  for (const mountPoint of mountUnits) {
    await removeMountUnit(runCommand, mountPoint, 'runtime').catch(() => undefined);
  }
  for (const mountPoint of mounts) {
    await runCommand('umount', [mountPoint]);
  }
  if (volumeGroupCreated) {
    await runCommand('vgremove', ['--force', VOLUME_GROUP]);
  }
  for (const path of arrays) {
    await runCommand('mdadm', ['--stop', path]);
  }
  await Promise.all(loops.map((loop) => runCommand('losetup', ['--detach', loop])));
  if (workDir !== '') {
    await rm(workDir, { recursive: true, force: true });
  }
}

interface CreatedArray {
  readonly detail: MdDetail;
  readonly members: readonly string[];
  readonly sizeBytes: number;
}

/** Creates one tier's array from the planned partitions and reads it back. */
async function createTierArray(tier: PlannedTier): Promise<CreatedArray> {
  const members = tier.members.map((drive) => partitionPath(drive, tier.partitionNumber));
  const path = mdArrayPath(POOL, tier.tier);
  arrays.push(path);
  const detail = await createArray(runCommand, {
    poolId: POOL,
    tier: tier.tier,
    level: tier.level,
    members,
  });
  const size = await runChecked(runCommand, 'blockdev', ['--getsize64', path]);
  return { detail, members, sizeBytes: Number(size.trim()) };
}

/** What a reboot does to the pool: LVM down, arrays stopped, then assembled from the config file and LVM up. */
async function simulateReboot(confPath: string): Promise<void> {
  await runChecked(runCommand, 'vgchange', ['--activate', 'n', VOLUME_GROUP]);
  for (const path of arrays) {
    await runChecked(runCommand, 'mdadm', ['--stop', path]);
  }
  await runChecked(runCommand, 'udevadm', ['settle']);
  await runChecked(runCommand, 'mdadm', ['--assemble', '--scan', `--config=${confPath}`]);
  await runChecked(runCommand, 'udevadm', ['settle']);
  await runChecked(runCommand, 'vgchange', ['--activate', 'y', VOLUME_GROUP]);
  await runChecked(runCommand, 'udevadm', ['settle']);
}

describe.skipIf(!isRoot)('executors on loop devices', () => {
  beforeAll(attachLoopDevices);
  afterAll(tearDown);

  it('writes exactly the planned partitions', async () => {
    for (const drive of plannedLayout().drives) {
      await partitionDrive(runCommand, {
        devicePath: drive.id,
        poolId: POOL,
        partitions: drive.partitions,
      });
      const { sectorsize, partitions } = (await readTable(drive.id)).partitiontable;
      expect(
        partitions.map((partition) => ({
          startBytes: partition.start * sectorsize,
          sizeBytes: partition.size * sectorsize,
          name: partition.name,
        })),
      ).toEqual(
        drive.partitions.map((partition) => ({
          startBytes: partition.startBytes,
          sizeBytes: partition.sizeBytes,
          name: expectedName(partition),
        })),
      );
    }
  });

  it('marks the drives as Open HR drives', async () => {
    const lsblk = await runChecked(runCommand, 'lsblk', [
      '--json',
      '--bytes',
      '--output',
      LSBLK_COLUMNS.join(','),
      ...loops,
    ]);
    expect(parseLsblk(lsblk).map((device) => driveRole(device))).toEqual(['ohr', 'ohr', 'ohr']);
  });

  it('writes and reads back each drive label', async () => {
    for (const [index, loop] of loops.entries()) {
      const fields = {
        poolId: POOL,
        poolUuid: '6f1c2b0e-8a3d-4c5e-9f7a-1b2c3d4e5f60',
        driveUuid: `0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f7${index}`,
        redundancy: 'shr1',
        writtenAt: '2026-10-29T12:00:00.000Z',
      } as const;
      await writeLabel(blockDeviceIo, `${loop}p1`, fields);
      expect(await readLabel(blockDeviceIo, `${loop}p1`)).toMatchObject({
        kind: 'ok',
        descriptor: fields,
      });
    }
  });

  it('creates every planned tier array at the size the planner promised', async () => {
    const { tiers } = plannedLayout();
    expect(tiers.map((tier) => tier.level)).toEqual(['raid5', 'raid1']);
    for (const tier of tiers) {
      const { detail, members, sizeBytes } = await createTierArray(tier);
      expect(detail).toMatchObject({
        level: tier.level,
        raidDevices: members.length,
        metadata: '1.2',
        devName: `ohr_${POOL}_t${tier.tier}`,
        name: `any:ohr_${POOL}_t${tier.tier}`,
      });
      expect(detail.members.map((member) => member.device)).toEqual(members);
      expect(sizeBytes).toBe(tier.arrayBytes);
    }
  });

  it('puts the arrays under one volume group of the size the planner promised', async () => {
    const layout = plannedLayout();
    const devices: string[] = [];
    for (const tier of layout.tiers) {
      const path = mdArrayPath(POOL, tier.tier);
      const pv = await createPhysicalVolume(runCommand, path);
      expect(pv).toMatchObject({ device: await realpath(path), volumeGroup: null });
      expect(pv.sizeBytes).toBe(tier.arrayBytes);
      devices.push(path);
    }
    volumeGroupCreated = true;
    const vg = await createVolumeGroup(runCommand, { poolId: POOL, physicalVolumes: devices });
    expect(vg).toMatchObject({
      name: VOLUME_GROUP,
      physicalVolumeCount: devices.length,
      logicalVolumeCount: 0,
    });
    expect(vg.sizeBytes).toBe(layout.usableBytes);
    expect(vg.freeBytes).toBe(layout.usableBytes);
  });

  it('creates a volume of an exact size and one from all free space', async () => {
    const { usableBytes } = plannedLayout();
    const scratch = await createLogicalVolume(runCommand, {
      poolId: POOL,
      name: 'scratch',
      size: { kind: 'bytes', bytes: SCRATCH_BYTES },
    });
    expect(scratch).toMatchObject({
      name: 'scratch',
      volumeGroup: VOLUME_GROUP,
      sizeBytes: SCRATCH_BYTES,
      path: logicalVolumePath(POOL, 'scratch'),
      layout: 'linear',
    });
    const data = await createLogicalVolume(runCommand, {
      poolId: POOL,
      name: 'data',
      size: { kind: 'all-free' },
    });
    expect(data).toMatchObject({ name: 'data', path: logicalVolumePath(POOL, 'data') });
    expect(data.sizeBytes).toBe(usableBytes - SCRATCH_BYTES);
  });

  it('formats a btrfs volume with its subvolumes and mounts the data subvolume', async () => {
    const device = logicalVolumePath(POOL, 'data');
    const filesystem = await makeFilesystem(runCommand, { device, type: 'btrfs', name: 'data' });
    expect(filesystem).toMatchObject({ type: 'btrfs', label: 'data' });
    expect(filesystem.uuid).toMatch(UUID);
    const mountPoint = join(workDir, 'data');
    mounts.push(mountPoint);
    const mount = await mountVolume(runCommand, { device, type: 'btrfs', mountPoint });
    expect(mount).toMatchObject({ target: mountPoint, fsType: 'btrfs' });
    expect(mount.source.endsWith('[/@data]')).toBe(true);
    expect(mount.options).toContain('subvol=/@data');
    expect(await realpath(mount.device)).toBe(await realpath(device));
    const subvolumes = await runChecked(runCommand, 'btrfs', ['subvolume', 'list', mountPoint]);
    expect(subvolumes).toMatch(DATA_SUBVOLUME);
    expect(subvolumes).toMatch(SNAPSHOTS_SUBVOLUME);
    await writeFile(join(mountPoint, 'hello.txt'), 'hello');
    await unmountVolume(runCommand, mountPoint);
    mounts.pop();
    expect(await readdir(mountPoint)).toEqual([]);
    await expect(readMount(runCommand, mountPoint)).rejects.toThrow();
  });

  it('formats an ext4 volume and mounts it', async () => {
    const device = logicalVolumePath(POOL, 'scratch');
    const filesystem = await makeFilesystem(runCommand, { device, type: 'ext4', name: 'scratch' });
    expect(filesystem).toMatchObject({ type: 'ext4', label: 'scratch' });
    expect(filesystem.uuid).toMatch(UUID);
    const mountPoint = join(workDir, 'scratch');
    mounts.push(mountPoint);
    const mount = await mountVolume(runCommand, { device, type: 'ext4', mountPoint });
    expect(mount).toMatchObject({ target: mountPoint, fsType: 'ext4' });
    expect(await realpath(mount.device)).toBe(await realpath(device));
    await writeFile(join(mountPoint, 'hello.txt'), 'hello');
    await unmountVolume(runCommand, mountPoint);
    mounts.pop();
    expect(await readdir(mountPoint)).toEqual([]);
  });

  it('writes an mdadm config the pool reassembles from after a simulated reboot', async () => {
    const { tiers } = plannedLayout();
    const definitions: MdArrayDefinition[] = [];
    for (const tier of tiers) {
      definitions.push(await arrayDefinition(runCommand, mdArrayPath(POOL, tier.tier)));
    }
    expect(definitions.map((definition) => definition.device)).toEqual(arrays);
    const confPath = await writeMdadmConf(POOL, definitions, {
      confDir: join(workDir, 'mdadm.conf.d'),
    });
    await simulateReboot(confPath);
    for (const tier of tiers) {
      const detail = parseMdadmDetail(
        await runChecked(runCommand, 'mdadm', [
          '--detail',
          '--export',
          mdArrayPath(POOL, tier.tier),
        ]),
      );
      expect(detail).toMatchObject({ devName: `ohr_${POOL}_t${tier.tier}`, level: tier.level });
    }
    const data = await readFilesystem(runCommand, logicalVolumePath(POOL, 'data'));
    expect(data).toMatchObject({ type: 'btrfs', label: 'data' });
  });

  it('mounts a volume through a systemd mount unit and removes it again', async () => {
    const mountPoint = join(workDir, 'unit');
    mountUnits.push(mountPoint);
    const unit = await installMountUnit(
      runCommand,
      {
        poolId: POOL,
        volume: 'data',
        device: logicalVolumePath(POOL, 'data'),
        type: 'btrfs',
        mountPoint,
      },
      'runtime',
    );
    const escaped = await runChecked(runCommand, 'systemd-escape', [
      '-p',
      '--suffix=mount',
      mountPoint,
    ]);
    expect(unit.unitName).toBe(escaped.trim());
    expect(unit.unitPath).toBe(`/run/systemd/system/${unit.unitName}`);
    const mount = await readMount(runCommand, mountPoint);
    expect(mount).toMatchObject({ target: mountPoint, fsType: 'btrfs' });
    expect(mount.options).toContain('subvol=/@data');
    const active = await runChecked(runCommand, 'systemctl', ['is-active', unit.unitName]);
    expect(active.trim()).toBe('active');
    await removeMountUnit(runCommand, mountPoint, 'runtime');
    mountUnits.pop();
    await expect(readMount(runCommand, mountPoint)).rejects.toThrow();
    expect(existsSync(unit.unitPath)).toBe(false);
  });
});
