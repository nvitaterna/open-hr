/**
 * Creates a pool on loop devices through the job engine, then proves the
 * job is idempotent and resumable. Needs root; see executors.integration.test.ts.
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

import { runChecked, runCommand } from '../command-runner.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { type JobDefinition, runJob, submitJob } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';
import { JobStore } from './store.ts';

const GIB = 1024 ** 3;
const SIZES = [2 * GIB, 4 * GIB, 4 * GIB];
const POOL = 'jtest';
const VOLUME_GROUP = `ohr-${POOL}`;

const isRoot = process.getuid?.() === 0;
const loops: string[] = [];
let workDir = '';
let input: PoolCreateInput;
let definition: JobDefinition;
const store = JobStore.open(':memory:');

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
});
