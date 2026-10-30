/**
 * The volume-grow job on loop devices (decision 0011): a two-drive pool with
 * a btrfs and an ext4 volume, both mounted, each grown from a real preview
 * while mounted: btrfs by a given size, ext4 into all free space. Checks the
 * volume sizes against the plan, that each filesystem grew, that a re-run
 * leaves the volume alone, and that the files written before read back.
 * Needs root; run with `pnpm --filter @ohr/core test:integration`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FilesystemType } from '@ohr/shared/constants';
import { LV_FIELDS, lvmReportArgs, parseLvs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { planPool } from '@ohr/shared/planner';
import type { VolumeGrowRequest } from '@ohr/shared/volume-grow-request';

import { runChecked, runCommand } from '../command-runner.ts';
import { blockDeviceIo } from '../executors/label-partition.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { readTextFile } from '../file-reader.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { type JobDefinition, runJob, submitJob } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';
import { JobStore } from './store.ts';
import { buildVolumeCreateJob } from './volume-create.ts';
import { buildVolumeGrowJob } from './volume-grow.ts';
import { previewVolumeGrow } from './volume-grow-preview.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const POOL = 'g1';
const GROUP = `ohr-${POOL}`;
const VOLUMES = [
  { name: 'data', filesystem: 'btrfs', bytes: 512 * MIB },
  { name: 'scratch', filesystem: 'ext4', bytes: 256 * MIB },
] as const satisfies readonly { name: string; filesystem: FilesystemType; bytes: number }[];

const isRoot = process.getuid?.() === 0;

async function runToEnd(store: JobStore, definition: JobDefinition): Promise<string[]> {
  const job = submitJob(store, definition, 'hash');
  const finished = await runJob(store, definition, job.id, { run: runCommand });
  if (finished.status !== 'done') {
    throw new Error(`${definition.kind} job ${finished.status}: ${finished.error ?? 'no error'}`);
  }
  return finished.steps.map((step) => `${step.name}: ${step.status}`);
}

async function volumeBytes(name: string): Promise<number> {
  const report = await runChecked(runCommand, 'lvs', [
    ...lvmReportArgs(LV_FIELDS),
    `${GROUP}/${name}`,
  ]);
  return parseLvs(report)[0]?.sizeBytes ?? 0;
}

async function filesystemBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.blocks * stats.bsize;
}

describe.skipIf(!isRoot)('volume-grow on loop devices', () => {
  const store = JobStore.open(':memory:');
  const content = randomBytes(MIB);
  let loops: LoopDevices;
  let tiers = 0;
  const mountPoint = (name: string): string => join(loops.dir, name);

  async function grow(request: VolumeGrowRequest): Promise<JobDefinition> {
    const snapshot = await readSystemState({
      run: runCommand,
      readFile: readTextFile,
      includeSmart: false,
      labelIo: blockDeviceIo,
      includeLoopDevices: true,
    });
    const result = previewVolumeGrow(request, snapshot);
    if (!result.ok) {
      throw new Error(result.reasons.join(' '));
    }
    const job = buildVolumeGrowJob(result.value);
    await runToEnd(store, job);
    return job;
  }

  beforeAll(async () => {
    loops = await attachLoopDevices('ohr-g1', [2 * GIB, 2 * GIB]);
  });

  afterAll(async () => {
    for (const volume of VOLUMES) {
      await removeMountUnit(runCommand, mountPoint(volume.name), 'runtime').catch(() => undefined);
    }
    await runCommand('vgremove', ['--force', GROUP]);
    for (let tier = 1; tier <= tiers; tier += 1) {
      await runCommand('mdadm', ['--stop', mdArrayPath(POOL, tier)]);
    }
    await loops.detach();
    store.close();
  });

  it('creates a pool with two mounted volumes holding files', async () => {
    const plan = planPool(
      loops.paths.map((path) => ({ id: path, sizeBytes: 2 * GIB })),
      'shr1',
    );
    if (!plan.ok) {
      throw new Error(plan.error.code);
    }
    tiers = plan.layout.tiers.length;
    await runToEnd(
      store,
      buildPoolCreateJob(
        {
          poolId: POOL,
          poolUuid: randomUUID(),
          redundancy: 'shr1',
          wipe: false,
          drives: loops.paths.map((path) => ({
            path,
            serial: null,
            wwn: null,
            sizeBytes: 2 * GIB,
            driveUuid: randomUUID(),
          })),
          layout: plan.layout,
        },
        { mdadmConfDir: join(loops.dir, 'mdadm.conf.d') },
      ),
    );
    for (const volume of VOLUMES) {
      await runToEnd(
        store,
        buildVolumeCreateJob(
          {
            poolId: POOL,
            name: volume.name,
            filesystem: volume.filesystem,
            size: { kind: 'bytes', bytes: volume.bytes },
            mountPoint: mountPoint(volume.name),
          },
          { unitScope: 'runtime' },
        ),
      );
      await writeFile(join(mountPoint(volume.name), 'before.bin'), content);
      expect(await volumeBytes(volume.name)).toBe(volume.bytes);
    }
  });

  it('grows the btrfs volume by a given size while mounted, once', async () => {
    const [data] = VOLUMES;
    const before = await filesystemBytes(mountPoint(data.name));
    const job = await grow({
      poolId: POOL,
      name: data.name,
      size: { kind: 'add-bytes', bytes: 256 * MIB },
    });
    expect(await volumeBytes(data.name)).toBe(data.bytes + 256 * MIB);
    expect(await filesystemBytes(mountPoint(data.name))).toBeGreaterThan(before);
    expect(await runToEnd(store, job)).toEqual([
      'extend volume data: skipped',
      'grow filesystem of data: done',
    ]);
    expect(await volumeBytes(data.name)).toBe(data.bytes + 256 * MIB);
  });

  it('grows the ext4 volume into all free space while mounted', async () => {
    const [, scratch] = VOLUMES;
    const before = await filesystemBytes(mountPoint(scratch.name));
    await grow({ poolId: POOL, name: scratch.name, size: { kind: 'all-free' } });
    const [group] = parseVgs(
      await runChecked(runCommand, 'vgs', [...lvmReportArgs(VG_FIELDS), GROUP]),
    );
    expect(group?.freeBytes).toBe(0);
    expect((await volumeBytes('data')) + (await volumeBytes(scratch.name))).toBe(group?.sizeBytes);
    expect(await filesystemBytes(mountPoint(scratch.name))).toBeGreaterThan(before);
  });

  it('keeps the files written before', async () => {
    for (const volume of VOLUMES) {
      const bytes = await readFile(join(mountPoint(volume.name), 'before.bin'));
      expect(bytes.equals(content)).toBe(true);
    }
  });
});
