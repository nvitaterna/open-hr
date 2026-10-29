/**
 * Creates a pool and two volumes on loop devices through the job engine,
 * and proves the jobs are idempotent and resumable. Needs root; see executors.integration.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lvmReportArgs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { planPool } from '@ohr/shared/planner';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';
import type { VolumeCreateInput } from '@ohr/shared/volume-create-input';

import { runChecked, runCommand } from '../command-runner.ts';
import { logicalVolumePath } from '../executors/lvm.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { readMount } from '../executors/mount.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { type JobDefinition, runJob, submitJob } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';
import { JobStore } from './store.ts';
import { buildVolumeCreateJob } from './volume-create.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const SCRATCH_BYTES = 8 * MIB;
const SIZES = [2 * GIB, 4 * GIB, 4 * GIB];
const POOL = 'jtest';
const VOLUME_GROUP = `ohr-${POOL}`;

const isRoot = process.getuid?.() === 0;
const loops: string[] = [];
let workDir = '';
let input: PoolCreateInput;
let definition: JobDefinition;
const store = JobStore.open(':memory:');
/** Mount points with a runtime unit, removed first in teardown. */
const mountUnits: string[] = [];

async function attachLoopDevices(): Promise<void> {
  workDir = await mkdtemp(join(tmpdir(), 'ohr-jtest-'));
  for (const [index, size] of SIZES.entries()) {
    const file = join(workDir, `drive${index}.img`);
    await writeFile(file, '');
    await truncate(file, size);
    const loop = await runChecked(runCommand, 'losetup', ['--find', '--partscan', '--show', file]);
    loops.push(loop.trim());
  }
  const plan = planPool(
    loops.map((path, index) => ({ id: path, sizeBytes: SIZES[index] ?? 0 })),
    'shr1',
  );
  if (!plan.ok) {
    throw new Error(`plan failed: ${plan.error.code}`);
  }
  input = {
    poolId: POOL,
    poolUuid: randomUUID(),
    redundancy: 'shr1',
    wipe: false,
    drives: loops.map((path, index) => ({
      path,
      serial: null,
      wwn: null,
      sizeBytes: SIZES[index] ?? 0,
      driveUuid: randomUUID(),
    })),
    layout: plan.layout,
  };
  definition = buildPoolCreateJob(input, { mdadmConfDir: join(workDir, 'mdadm.conf.d') });
}

async function tearDown(): Promise<void> {
  for (const mountPoint of mountUnits) {
    await removeMountUnit(runCommand, mountPoint, 'runtime').catch(() => undefined);
  }
  await runCommand('vgremove', ['--force', VOLUME_GROUP]);
  for (const tier of input.layout.tiers) {
    await runCommand('mdadm', ['--stop', mdArrayPath(POOL, tier.tier)]);
  }
  await Promise.all(loops.map((loop) => runCommand('losetup', ['--detach', loop])));
  store.close();
  if (workDir !== '') {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The definition with one step's action replaced by a crash. */
function crashingAt(stepName: string): JobDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (step.name !== stepName) {
        return step;
      }
      return { ...step, action: () => Promise.reject(new Error('simulated crash')) };
    }),
  };
}

function volumeInput(
  name: string,
  filesystem: 'btrfs' | 'ext4',
  size: VolumeCreateInput['size'],
): VolumeCreateInput {
  return { poolId: POOL, name, filesystem, size, mountPoint: join(workDir, name) };
}

describe.skipIf(!isRoot)('pool-create job on loop devices', () => {
  beforeAll(attachLoopDevices);
  afterAll(tearDown);

  it('fails at a crashing step and leaves later steps pending', async () => {
    const crashStep = 'create tier 2 array';
    const job = submitJob(store, definition, 'hash');
    const failed = await runJob(store, crashingAt(crashStep), job.id, { run: runCommand });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe(`${crashStep}: simulated crash`);
    const statuses = new Map(failed.steps.map((step) => [step.name, step.status]));
    expect(statuses.get('create tier 1 array')).toBe('done');
    expect(statuses.get(crashStep)).toBe('failed');
    expect(statuses.get('create volume group')).toBe('pending');
  });

  it('resumes from the failed step, skipping work that is already there', async () => {
    const job = submitJob(store, definition, 'hash');
    const log: string[] = [];
    const done = await runJob(store, definition, job.id, {
      run: runCommand,
      listener: (event) => {
        if (event.kind === 'log') {
          log.push(event.line);
        }
      },
    });
    expect(done.status).toBe('done');
    const statuses = done.steps.map((step) => step.status);
    expect(statuses.filter((status) => status === 'skipped')).toHaveLength(
      input.drives.length * 2 + 1,
    );
    expect(statuses.filter((status) => status === 'done')).toHaveLength(
      done.steps.length - input.drives.length * 2 - 1,
    );
    expect(log.some((line) => line.includes('already has the planned partitions'))).toBe(true);
    expect(log.some((line) => line.includes('already exists with the planned members'))).toBe(true);
  });

  it('leaves a volume group of the planned size and a config file', async () => {
    const report = await runChecked(runCommand, 'vgs', [...lvmReportArgs(VG_FIELDS), VOLUME_GROUP]);
    expect(parseVgs(report)).toMatchObject([
      { name: VOLUME_GROUP, sizeBytes: input.layout.usableBytes, physicalVolumeCount: 2 },
    ]);
    const conf = await readFile(join(workDir, 'mdadm.conf.d', `ohr-${POOL}.conf`), 'utf8');
    expect(conf).toContain(`ARRAY /dev/md/ohr_${POOL}_t1 metadata=1.2 UUID=`);
    expect(conf).toContain(`ARRAY /dev/md/ohr_${POOL}_t2 metadata=1.2 UUID=`);
  });

  it('runs again with every step skipped', async () => {
    const job = submitJob(store, definition, 'hash');
    const again = await runJob(store, definition, job.id, { run: runCommand });
    expect(again.status).toBe('done');
    expect(again.steps.every((step) => step.status === 'skipped')).toBe(true);
  });

  it('creates an ext4 volume of an exact size and a btrfs volume from the rest', async () => {
    for (const volume of [
      volumeInput('scratch', 'ext4', { kind: 'bytes', bytes: SCRATCH_BYTES }),
      volumeInput('data', 'btrfs', { kind: 'all-free' }),
    ]) {
      mountUnits.push(volume.mountPoint);
      const volumeJob = buildVolumeCreateJob(volume, { unitScope: 'runtime' });
      const job = submitJob(store, volumeJob, 'hash');
      const done = await runJob(store, volumeJob, job.id, { run: runCommand });
      expect(done.status).toBe('done');
      expect(done.steps.map((step) => step.status)).toEqual(['done', 'done', 'done']);
      const mount = await readMount(runCommand, volume.mountPoint);
      expect(mount.fsType).toBe(volume.filesystem);
      await writeFile(join(volume.mountPoint, 'hello.txt'), 'hello');
    }
    const data = await readMount(runCommand, join(workDir, 'data'));
    expect(data.options).toContain('subvol=/@data');
    expect(data.sizeBytes).toBeGreaterThan(input.layout.usableBytes - SCRATCH_BYTES - 64 * MIB);
    expect(await readFile(join(workDir, 'data', 'hello.txt'), 'utf8')).toBe('hello');
    const lv = logicalVolumePath(POOL, 'data');
    expect(data.device.length).toBeGreaterThan(0);
    expect(lv).toBe(`/dev/${VOLUME_GROUP}/data`);
  });

  it('runs a volume job again with every step skipped', async () => {
    const volumeJob = buildVolumeCreateJob(volumeInput('data', 'btrfs', { kind: 'all-free' }), {
      unitScope: 'runtime',
    });
    const job = submitJob(store, volumeJob, 'hash');
    const again = await runJob(store, volumeJob, job.id, { run: runCommand });
    expect(again.status).toBe('done');
    expect(again.steps.map((step) => step.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });
});
