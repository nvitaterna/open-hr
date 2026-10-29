/**
 * The M2 create suite: the pool-create and volume-create jobs across drive
 * counts from 2 to 6, mixed sizes, SHR-1 and SHR-2, both filesystems. Each
 * case checks every array, the volume group's size against the planner,
 * the labels, idempotent re-runs, and a file written through the mount.
 * Needs root; run with `pnpm --filter @ohr/core test:integration`.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FilesystemType, Redundancy } from '@ohr/shared/constants';
import { lvmReportArgs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import { type Layout, planPool } from '@ohr/shared/planner';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import { runChecked, runCommand } from '../command-runner.ts';
import { blockDeviceIo, readLabel } from '../executors/label-partition.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { readMount } from '../executors/mount.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { partitionPath } from '../executors/partition-drive.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';
import { type JobDefinition, runJob, submitJob } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';
import { JobStore } from './store.ts';
import { buildVolumeCreateJob } from './volume-create.ts';

const GIB = 1024 ** 3;
const VOLUME = 'data';
const CONTENT = 'written through the mount';

interface MatrixCase {
  readonly poolId: string;
  readonly redundancy: Redundancy;
  readonly sizesGib: readonly number[];
  readonly filesystem: FilesystemType;
  /** The tier levels the planner must choose, as a check on the case itself. */
  readonly levels: readonly string[];
}

/** Sizes are small so resync traffic stays low; tiers still span 1 GiB steps. */
const CASES: readonly MatrixCase[] = [
  { poolId: 'm1a', redundancy: 'shr1', sizesGib: [2, 2], filesystem: 'btrfs', levels: ['raid1'] },
  { poolId: 'm1b', redundancy: 'shr1', sizesGib: [2, 3], filesystem: 'ext4', levels: ['raid1'] },
  {
    poolId: 'm1c',
    redundancy: 'shr1',
    sizesGib: [2, 3, 3],
    filesystem: 'btrfs',
    levels: ['raid5', 'raid1'],
  },
  {
    poolId: 'm1d',
    redundancy: 'shr1',
    sizesGib: [2, 2, 3, 4],
    filesystem: 'ext4',
    levels: ['raid5', 'raid1'],
  },
  {
    poolId: 'm1e',
    redundancy: 'shr1',
    sizesGib: [2, 3, 3, 4, 5],
    filesystem: 'btrfs',
    levels: ['raid5', 'raid5', 'raid1'],
  },
  {
    poolId: 'm1f',
    redundancy: 'shr1',
    sizesGib: [2, 2, 3, 3, 4, 4],
    filesystem: 'ext4',
    levels: ['raid5', 'raid5', 'raid1'],
  },
  {
    poolId: 'm2a',
    redundancy: 'shr2',
    sizesGib: [2, 2, 2, 2],
    filesystem: 'btrfs',
    levels: ['raid6'],
  },
  {
    poolId: 'm2b',
    redundancy: 'shr2',
    sizesGib: [2, 3, 3, 4],
    filesystem: 'ext4',
    levels: ['raid6', 'raid1'],
  },
  {
    poolId: 'm2c',
    redundancy: 'shr2',
    sizesGib: [2, 2, 3, 3, 3],
    filesystem: 'btrfs',
    levels: ['raid6', 'raid1'],
  },
  {
    poolId: 'm2d',
    redundancy: 'shr2',
    sizesGib: [2, 3, 3, 4, 4, 5],
    filesystem: 'ext4',
    levels: ['raid6', 'raid6', 'raid1'],
  },
];

const isRoot = process.getuid?.() === 0;

function planFor(testCase: MatrixCase, paths: readonly string[]): Layout {
  const plan = planPool(
    paths.map((path, index) => ({ id: path, sizeBytes: (testCase.sizesGib[index] ?? 0) * GIB })),
    testCase.redundancy,
  );
  if (!plan.ok) {
    throw new Error(`plan failed: ${plan.error.code}`);
  }
  return plan.layout;
}

/** Runs a job to the end and returns each step's status. Throws with the job's error if it fails. */
async function runToEnd(store: JobStore, definition: JobDefinition): Promise<string[]> {
  const job = submitJob(store, definition, 'hash');
  const finished = await runJob(store, definition, job.id, { run: runCommand });
  if (finished.status !== 'done') {
    throw new Error(`${definition.kind} job ${finished.status}: ${finished.error ?? 'no error'}`);
  }
  return finished.steps.map((step) => step.status);
}

async function arraySize(path: string): Promise<number> {
  return Number((await runChecked(runCommand, 'blockdev', ['--getsize64', path])).trim());
}

describe.skipIf(!isRoot).each(CASES)(
  '$redundancy on $sizesGib GiB with $filesystem',
  (testCase) => {
    const store = JobStore.open(':memory:');
    let loops: LoopDevices;
    let input: PoolCreateInput;
    let poolJob: JobDefinition;
    let mountPoint = '';
    let mounted = false;

    beforeAll(async () => {
      loops = await attachLoopDevices(
        'ohr-matrix',
        testCase.sizesGib.map((size) => size * GIB),
      );
      const layout = planFor(testCase, loops.paths);
      input = {
        poolId: testCase.poolId,
        poolUuid: randomUUID(),
        redundancy: testCase.redundancy,
        wipe: false,
        drives: loops.paths.map((path, index) => ({
          path,
          serial: null,
          wwn: null,
          sizeBytes: (testCase.sizesGib[index] ?? 0) * GIB,
          driveUuid: randomUUID(),
        })),
        layout,
      };
      poolJob = buildPoolCreateJob(input, { mdadmConfDir: join(loops.dir, 'mdadm.conf.d') });
      mountPoint = join(loops.dir, VOLUME);
    });

    afterAll(async () => {
      if (mounted) {
        await removeMountUnit(runCommand, mountPoint, 'runtime').catch(() => undefined);
      }
      await runCommand('vgremove', ['--force', `ohr-${testCase.poolId}`]);
      for (const tier of input.layout.tiers) {
        await runCommand('mdadm', ['--stop', mdArrayPath(testCase.poolId, tier.tier)]);
      }
      await loops.detach();
      store.close();
    });

    it('plans the expected tiers', () => {
      expect(input.layout.tiers.map((tier) => tier.level)).toEqual(testCase.levels);
    });

    it('creates the pool: every array, the labels, and the planned capacity', async () => {
      const statuses = await runToEnd(store, poolJob);
      expect(statuses.every((status) => status === 'done')).toBe(true);
      for (const tier of input.layout.tiers) {
        const path = mdArrayPath(testCase.poolId, tier.tier);
        const detail = parseMdadmDetail(
          await runChecked(runCommand, 'mdadm', ['--detail', '--export', path]),
        );
        expect(detail.level).toBe(tier.level);
        expect(detail.members.map((member) => member.device).sort()).toEqual(
          tier.members
            .map((drive) => partitionPath(drive, tier.partitionNumber))
            .sort((a, b) => a.localeCompare(b)),
        );
        expect(await arraySize(path)).toBe(tier.arrayBytes);
      }
      const [group] = parseVgs(
        await runChecked(runCommand, 'vgs', [
          ...lvmReportArgs(VG_FIELDS),
          `ohr-${testCase.poolId}`,
        ]),
      );
      expect(group?.sizeBytes).toBe(input.layout.usableBytes);
      for (const drive of input.drives) {
        const label = await readLabel(blockDeviceIo, partitionPath(drive.path, 1));
        expect(label).toMatchObject({
          kind: 'ok',
          descriptor: { poolUuid: input.poolUuid, driveUuid: drive.driveUuid },
        });
      }
    });

    it('re-runs the pool job with every step skipped', async () => {
      const statuses = await runToEnd(store, poolJob);
      expect(statuses.every((status) => status === 'skipped')).toBe(true);
    });

    it('creates a volume from all free space and keeps a file written to it', async () => {
      const volumeJob = buildVolumeCreateJob(
        {
          poolId: testCase.poolId,
          name: VOLUME,
          filesystem: testCase.filesystem,
          size: { kind: 'all-free' },
          mountPoint,
        },
        { unitScope: 'runtime' },
      );
      mounted = true;
      const statuses = await runToEnd(store, volumeJob);
      expect(statuses).toEqual(['done', 'done', 'done']);
      const mount = await readMount(runCommand, mountPoint);
      expect(mount.fsType).toBe(testCase.filesystem);
      expect(mount.options.includes('subvol=/@data')).toBe(testCase.filesystem === 'btrfs');
      await writeFile(join(mountPoint, 'check.txt'), CONTENT);
      expect(await readFile(join(mountPoint, 'check.txt'), 'utf8')).toBe(CONTENT);
      expect(await runToEnd(store, volumeJob)).toEqual(['skipped', 'skipped', 'skipped']);
    });
  },
);
