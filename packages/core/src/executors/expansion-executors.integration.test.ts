/**
 * Runs the expansion executors against real loop devices (decision 0011):
 * a two-drive RAID1 tier becomes RAID5, gains a third drive and then the
 * 512 KiB chunk, in the order that does not deadlock md, and a new tier
 * is built from space on drives already in use. Then both volumes grow
 * online, one member is replaced live, and one is failed and rebuilt. Needs
 * root and the same tools as executors.integration.test.ts. The normal test
 * run skips this file.
 */

import { randomBytes } from 'node:crypto';
import { readFile, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { labelPartition, usableOf } from '@ohr/shared/expansion-plan';
import { type MdstatMember, parseMdstat } from '@ohr/shared/parsers/mdstat';
import type { PlannedPartition } from '@ohr/shared/planner';
import { TIER_AREA_OFFSET_BYTES } from '@ohr/shared/tier-rules';

import { runChecked, runCommand } from '../command-runner.ts';
import { readTextFile } from '../file-reader.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';
import { makeFilesystem } from './filesystem.ts';
import { growFilesystem } from './grow-filesystem.ts';
import {
  createLogicalVolume,
  createPhysicalVolume,
  createVolumeGroup,
  extendLogicalVolume,
  extendVolumeGroup,
  logicalVolumePath,
  resizePhysicalVolume,
} from './lvm.ts';
import { createArray, mdArrayPath } from './md-array.ts';
import {
  addMembers,
  convertToRaid5,
  failMember,
  growDevices,
  removeMember,
  replaceMember,
  setChunk,
} from './md-reshape.ts';
import { mdKernelName, type SyncProgress, waitForSync } from './md-sync.ts';
import { mountVolume } from './mount.ts';
import { addPartitions, partitionDrive, partitionPath } from './partition-drive.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const POOL = 'xtest';
const VOLUME_GROUP = `ohr-${POOL}`;
const SLICE_BYTES = 512 * MIB;
const CHUNK_BYTES = 512 * 1024;
const FIRST_EXTENT_BYTES = MIB;
const POLL_MS = 200;
const TIER1 = mdArrayPath(POOL, 1);
const TIER2 = mdArrayPath(POOL, 2);
const VOLUMES = [
  { name: 'data', type: 'btrfs', bytes: 192 * MIB },
  { name: 'scratch', type: 'ext4', bytes: 128 * MIB },
] as const;

const isRoot = process.getuid?.() === 0;
let loops: LoopDevices | null = null;
const arrays: string[] = [];
const mounts: string[] = [];
let volumeGroupCreated = false;
/** What each volume held before any change, by volume name. */
const contents = new Map<string, Buffer>();
/** Tier 1's size as a two-member RAID1, the size of one member's data area. */
let memberDataBytes = 0;

function drive(index: number): string {
  const path = loops?.paths[index];
  if (path === undefined) {
    throw new Error(`no loop device ${index}`);
  }
  return path;
}

function mountPoint(name: string): string {
  return join(loops?.dir ?? '', name);
}

function tierPartition(tier: number): PlannedPartition {
  return {
    number: 1 + tier,
    role: 'tier',
    tier,
    startBytes: TIER_AREA_OFFSET_BYTES + (tier - 1) * SLICE_BYTES,
    sizeBytes: SLICE_BYTES,
  };
}

async function arrayBytes(path: string): Promise<number> {
  return Number((await runChecked(runCommand, 'blockdev', ['--getsize64', path])).trim());
}

async function filesystemBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.blocks * stats.bsize;
}

/** Waits for the array's background work, at a short interval, and returns what it reported. */
async function settle(path: string, untilInSync = false): Promise<SyncProgress[]> {
  const progress: SyncProgress[] = [];
  await waitForSync({
    files: readTextFile,
    array: await mdKernelName(path),
    intervalMs: POLL_MS,
    untilInSync,
    onProgress: (update) => progress.push(update),
  });
  return progress;
}

/**
 * The array's members as /proc/mdstat shows them. mdadm --detail --export
 * reports a failed member by its old slot number, and a replaced one as a
 * spare, so only mdstat tells them apart.
 */
async function mdstatMember(path: string, partition: string): Promise<MdstatMember | undefined> {
  const name = await mdKernelName(path);
  const array = parseMdstat((await readTextFile('/proc/mdstat')) ?? '').find(
    (entry) => entry.name === name,
  );
  return array?.members.find((member) => `/dev/${member.device}` === partition);
}

async function sysfs(path: string, file: string): Promise<string> {
  const text = await readTextFile(`/sys/block/${await mdKernelName(path)}/md/${file}`);
  return text?.trim() ?? '';
}

async function tearDown(): Promise<void> {
  for (const path of mounts) {
    await runCommand('umount', [path]);
  }
  if (volumeGroupCreated) {
    await runCommand('vgremove', ['--force', VOLUME_GROUP]);
  }
  for (const path of arrays) {
    await runCommand('mdadm', ['--stop', path]);
  }
  await loops?.detach();
}

describe.skipIf(!isRoot)('expansion executors on loop devices', () => {
  beforeAll(async () => {
    loops = await attachLoopDevices('ohr-xtest', [2 * GIB, 2 * GIB, 2 * GIB, 2 * GIB]);
  });
  afterAll(tearDown);

  it('builds a two-drive RAID1 pool with two mounted volumes', async () => {
    for (const index of [0, 1]) {
      const partitions = [labelPartition(), tierPartition(1)];
      await partitionDrive(runCommand, { devicePath: drive(index), poolId: POOL, partitions });
    }
    arrays.push(TIER1);
    await createArray(runCommand, {
      poolId: POOL,
      tier: 1,
      level: 'raid1',
      members: [partitionPath(drive(0), 2), partitionPath(drive(1), 2)],
    });
    await settle(TIER1);
    await createPhysicalVolume(runCommand, TIER1);
    volumeGroupCreated = true;
    await createVolumeGroup(runCommand, { poolId: POOL, physicalVolumes: [TIER1] });
    for (const volume of VOLUMES) {
      const size = { kind: 'bytes', bytes: volume.bytes } as const;
      await createLogicalVolume(runCommand, { poolId: POOL, name: volume.name, size });
      const device = logicalVolumePath(POOL, volume.name);
      await makeFilesystem(runCommand, { device, type: volume.type, name: volume.name });
      mounts.push(mountPoint(volume.name));
      await mountVolume(runCommand, {
        device,
        type: volume.type,
        mountPoint: mountPoint(volume.name),
      });
      const bytes = randomBytes(MIB);
      await writeFile(join(mountPoint(volume.name), 'before.bin'), bytes);
      contents.set(volume.name, bytes);
    }
    memberDataBytes = await arrayBytes(TIER1);
    expect(memberDataBytes).toBeGreaterThan(SLICE_BYTES - 4 * MIB);
  });

  it('converts the RAID1 tier to RAID5 in place', async () => {
    const converted = await convertToRaid5(runCommand, TIER1);
    expect(converted).toMatchObject({ level: 'raid5', raidDevices: 2 });
    await settle(TIER1);
  });

  it('adds a third drive, grows the tier while reporting the reshape, then sets the chunk', async () => {
    const partitions = [labelPartition(), tierPartition(1)];
    await partitionDrive(runCommand, { devicePath: drive(2), poolId: POOL, partitions });
    const added = await addMembers(runCommand, {
      array: TIER1,
      members: [partitionPath(drive(2), 2)],
    });
    expect(added.members).toContainEqual({ device: partitionPath(drive(2), 2), role: 'spare' });
    const grown = await growDevices(runCommand, { array: TIER1, raidDevices: 3 });
    expect(grown.raidDevices).toBe(3);
    const progress = await settle(TIER1);
    expect(progress.map((update) => update.operation)).toContain('reshape');
    for (const update of progress) {
      expect(update.fraction ?? 0).toBeGreaterThanOrEqual(0);
      expect(update.fraction ?? 0).toBeLessThanOrEqual(1);
    }
    // Only now, with three members: on two it deadlocks the kernel under writes (decision 0011).
    await setChunk(runCommand, TIER1);
    await settle(TIER1);
    expect(Number(await sysfs(TIER1, 'chunk_size'))).toBe(CHUNK_BYTES);
    // Data members times the member's data area, the same rule as creation (decision 0011).
    expect(await arrayBytes(TIER1)).toBe(2 * memberDataBytes);
  });

  it('resizes the physical volume and keeps its first extent', async () => {
    const pv = await resizePhysicalVolume(runCommand, TIER1);
    // After pvresize, pvs reports the extent area as the size.
    expect(pv.sizeBytes).toBe(usableOf(2 * memberDataBytes, FIRST_EXTENT_BYTES));
    expect(pv.firstExtentBytes).toBe(FIRST_EXTENT_BYTES);
  });

  it('adds a tier partition to drives in use and builds a second tier from them', async () => {
    const members: string[] = [];
    for (const index of [0, 1, 2]) {
      const request = { devicePath: drive(index), poolId: POOL, partitions: [tierPartition(2)] };
      members.push(...(await addPartitions(runCommand, request)));
    }
    expect(members).toEqual([0, 1, 2].map((index) => partitionPath(drive(index), 3)));
    arrays.push(TIER2);
    await createArray(runCommand, { poolId: POOL, tier: 2, level: 'raid5', members });
    // A new RAID5 builds its parity as a recovery onto its last member.
    const progress = await settle(TIER2);
    for (const update of progress) {
      expect(['resync', 'recovery']).toContain(update.operation);
    }
    const pv = await createPhysicalVolume(runCommand, TIER2);
    const vg = await extendVolumeGroup(runCommand, { poolId: POOL, physicalVolumes: [TIER2] });
    const tier1Usable = usableOf(2 * memberDataBytes, FIRST_EXTENT_BYTES);
    const tier2Usable = usableOf(await arrayBytes(TIER2), pv.firstExtentBytes ?? 0);
    expect(vg).toMatchObject({ physicalVolumeCount: 2, sizeBytes: tier1Usable + tier2Usable });
  });

  it('grows both volumes and their filesystems while mounted', async () => {
    const [data, scratch] = VOLUMES;
    const dataBefore = await filesystemBytes(mountPoint(data.name));
    const grownData = await extendLogicalVolume(runCommand, {
      poolId: POOL,
      name: data.name,
      size: { kind: 'bytes', bytes: 512 * MIB },
    });
    expect(grownData.sizeBytes).toBe(512 * MIB);
    const dataDevice = logicalVolumePath(POOL, data.name);
    const dataRequest = { device: dataDevice, type: data.type, mountPoint: mountPoint(data.name) };
    await growFilesystem(runCommand, dataRequest);
    await growFilesystem(runCommand, dataRequest);
    expect(await filesystemBytes(mountPoint(data.name))).toBeGreaterThan(dataBefore);

    const scratchBefore = await filesystemBytes(mountPoint(scratch.name));
    const grownScratch = await extendLogicalVolume(runCommand, {
      poolId: POOL,
      name: scratch.name,
      size: { kind: 'all-free' },
    });
    expect(grownScratch.sizeBytes).toBeGreaterThan(scratch.bytes);
    await growFilesystem(runCommand, {
      device: logicalVolumePath(POOL, scratch.name),
      type: scratch.type,
      mountPoint: mountPoint(scratch.name),
    });
    expect(await filesystemBytes(mountPoint(scratch.name))).toBeGreaterThan(scratchBefore);
  });

  it('replaces a healthy member live, then removes the old one', async () => {
    const partitions = [labelPartition(), tierPartition(1), tierPartition(2)];
    await partitionDrive(runCommand, { devicePath: drive(3), poolId: POOL, partitions });
    const oldMember = partitionPath(drive(0), 2);
    const newMember = partitionPath(drive(3), 2);
    await addMembers(runCommand, { array: TIER1, members: [newMember] });
    await replaceMember(runCommand, { array: TIER1, oldMember, newMember });
    const progress = await settle(TIER1, true);
    expect(progress.map((update) => update.operation)).toContain('recovery');
    expect(await mdstatMember(TIER1, oldMember)).toMatchObject({ faulty: true });
    expect(await mdstatMember(TIER1, newMember)).toMatchObject({ faulty: false, spare: false });
    const removed = await removeMember(runCommand, { array: TIER1, member: oldMember });
    expect(removed.members.map((member) => member.device)).not.toContain(oldMember);
    expect(await sysfs(TIER1, 'degraded')).toBe('0');
  });

  it('fails a member, removes it, and rebuilds onto a new partition', async () => {
    const failed = partitionPath(drive(1), 3);
    const replacement = partitionPath(drive(3), 3);
    await failMember(runCommand, { array: TIER2, member: failed });
    expect(await mdstatMember(TIER2, failed)).toMatchObject({ faulty: true });
    expect(await sysfs(TIER2, 'degraded')).toBe('1');
    const afterRemove = await removeMember(runCommand, { array: TIER2, member: 'failed' });
    expect(afterRemove.members.map((member) => member.device)).not.toContain(failed);
    await addMembers(runCommand, { array: TIER2, members: [replacement] });
    const progress = await settle(TIER2, true);
    expect(progress.map((update) => update.operation)).toContain('recovery');
    expect(await sysfs(TIER2, 'degraded')).toBe('0');
  });

  it('reads back every file written before the changes', async () => {
    for (const volume of VOLUMES) {
      const bytes = await readFile(join(mountPoint(volume.name), 'before.bin'));
      expect(bytes.equals(contents.get(volume.name) ?? Buffer.alloc(0))).toBe(true);
    }
  });
});
