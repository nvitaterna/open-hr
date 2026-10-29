/**
 * Runs the executors against real loop devices. Needs root, sgdisk, mdadm,
 * wipefs, and losetup. Run with `pnpm --filter @ohr/core test:integration` as
 * root; the normal test run skips this file.
 */

import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LSBLK_COLUMNS, parseLsblk } from '@ohr/shared/parsers/lsblk';
import type { MdDetail } from '@ohr/shared/parsers/mdadm-detail';
import {
  type Layout,
  type PlannedPartition,
  type PlannedTier,
  planPool,
} from '@ohr/shared/planner';

import { runChecked, runCommand } from '../command-runner.ts';
import { driveRole } from '../drive-roles.ts';
import { blockDeviceIo, readLabel, writeLabel } from './label-partition.ts';
import { createArray, mdArrayPath } from './md-array.ts';
import { partitionDrive, partitionPath } from './partition-drive.ts';

const GIB = 1024 ** 3;
const SIZES = [2 * GIB, 4 * GIB, 4 * GIB];
const POOL = 'itest';

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
});
