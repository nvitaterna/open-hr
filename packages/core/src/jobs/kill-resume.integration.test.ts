/**
 * The M4 kill-and-resume suite (decision 0011): every expansion job is
 * stopped after each step's action and before its status is written, then
 * resumed from the database by a new store and engine, as the daemon does on
 * start. One run crashes after step 0, its resume after step 1, and so on to
 * the end, so every step is resumed from once. The crash closes the
 * database inside the action, so nothing the engine writes after it lands.
 * Each case checks every step that did work was interrupted, a resumed
 * step whose work was done is skipped, and the result: arrays, capacity, and a file written
 * before. Needs root; run with `pnpm --filter @ohr/core test:integration`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FilesystemType } from '@ohr/shared/constants';
import type { JobRecord } from '@ohr/shared/jobs';
import { LV_FIELDS, lvmReportArgs, parseLvs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import { planPool } from '@ohr/shared/planner';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import { runChecked, runCommand } from '../command-runner.ts';
import { blockDeviceIo } from '../executors/label-partition.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { mdKernelName, waitForSync } from '../executors/md-sync.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { partitionPath } from '../executors/partition-drive.ts';
import { readTextFile } from '../file-reader.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { buildDriveReplaceJob } from './drive-replace.ts';
import { previewDriveReplace } from './drive-replace-preview.ts';
import { type JobDefinition, runJob, submitJob } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';
import { buildPoolExpandJob } from './pool-expand.ts';
import { previewPoolExpand } from './pool-expand-preview.ts';
import { JobStore } from './store.ts';
import { buildVolumeCreateJob } from './volume-create.ts';
import { buildVolumeGrowJob } from './volume-grow.ts';
import { previewVolumeGrow } from './volume-grow-preview.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const VOLUME = 'data';
const POLL_MS = 200;
const JOB_TIMEOUT_MS = 900_000;
/** Steps that do their work again when resumed: they only read, or are idempotent. */
const RERUN_STEPS = /^(?:wait for |resize tier |grow filesystem of )/u;

const isRoot = process.getuid?.() === 0;

/** Where a run was stopped, and what the database said right after. */
interface Interruption {
  readonly index: number;
  readonly name: string;
  readonly storedStep: string;
  readonly storedJob: string;
}

interface CrashResult {
  readonly interruptions: readonly Interruption[];
  readonly job: JobRecord;
}

/**
 * A copy of `definition` whose first action at step `from` or later closes
 * `store` once it returns. The engine then fails to write the step's status
 * and runJob rejects, which is what a crash at that point leaves behind.
 */
function crashingAfter(
  definition: JobDefinition,
  from: number,
  store: JobStore,
): { readonly definition: JobDefinition; readonly crashed: () => number | null } {
  let crashed: number | null = null;
  const steps = definition.steps.map((step, index) => {
    if (index < from) {
      return step;
    }
    return {
      ...step,
      action: async (context: Parameters<typeof step.action>[0]) => {
        await step.action(context);
        if (crashed === null) {
          crashed = index;
          store.close();
        }
      },
    };
  });
  return { definition: { ...definition, steps }, crashed: () => crashed };
}

/**
 * Submits the job, then runs it with a crash after each step in turn,
 * resuming from the database each time, until a run finishes.
 */
async function runWithCrashes(
  databasePath: string,
  build: () => JobDefinition,
): Promise<CrashResult> {
  const first = JobStore.open(databasePath);
  const { id } = submitJob(first, build(), 'hash');
  first.close();
  const interruptions: Interruption[] = [];
  let from = 0;
  for (;;) {
    const store = JobStore.open(databasePath);
    // The daemon finds the job to resume the same way.
    const unfinished = store.unfinishedJobs().map((job) => job.id);
    if (unfinished.join() !== id) {
      throw new Error(`Expected only job ${id} unfinished, found ${unfinished.join()}`);
    }
    const crashing = crashingAfter(build(), from, store);
    try {
      const job = await runJob(store, crashing.definition, id, { run: runCommand });
      store.close();
      return { interruptions, job };
    } catch (error) {
      const index = crashing.crashed();
      if (index === null) {
        throw error;
      }
      const reopened = JobStore.open(databasePath);
      const stored = reopened.getJob(id);
      reopened.close();
      interruptions.push({
        index,
        name: crashing.definition.steps[index]?.name ?? '',
        storedStep: stored?.steps[index]?.status ?? 'missing',
        storedJob: stored?.status ?? 'missing',
      });
      from = index + 1;
    }
  }
}

/** What one crash left in the database, and how its step ended on resume. */
function resumeProblems(result: CrashResult, entry: Interruption): string[] {
  const problems: string[] = [];
  if (entry.storedStep !== 'running' || entry.storedJob !== 'running') {
    problems.push(`${entry.name}: stored as ${entry.storedStep} in a ${entry.storedJob} job`);
  }
  const status = result.job.steps[entry.index]?.status;
  if (!(status === 'skipped' || (status === 'done' && RERUN_STEPS.test(entry.name)))) {
    problems.push(`${entry.name}: ${status ?? 'missing'} on resume`);
  }
  return problems;
}

/** Checks what every crash left in the database and how each step ended. Returns the problems. */
function crashProblems(result: CrashResult): string[] {
  const problems: string[] = [];
  if (result.job.status !== 'done') {
    problems.push(`job ${result.job.status}: ${result.job.error ?? 'no error'}`);
  }
  // A step is interrupted unless its work was already there when the job reached it.
  const interrupted = new Set(result.interruptions.map((entry) => entry.index));
  for (const step of result.job.steps) {
    if (!interrupted.has(step.index) && step.status !== 'skipped') {
      problems.push(`${step.name}: never interrupted, yet ${step.status}`);
    }
  }
  if (interrupted.size === 0) {
    problems.push('no step was interrupted');
  }
  return [...problems, ...result.interruptions.flatMap((entry) => resumeProblems(result, entry))];
}

async function runToEnd(store: JobStore, definition: JobDefinition): Promise<void> {
  const job = submitJob(store, definition, 'hash');
  const finished = await runJob(store, definition, job.id, { run: runCommand });
  if (finished.status !== 'done') {
    throw new Error(`${definition.kind} job ${finished.status}: ${finished.error ?? 'no error'}`);
  }
}

function snapshot(): Promise<SystemSnapshot> {
  return readSystemState({
    run: runCommand,
    readFile: readTextFile,
    includeSmart: false,
    labelIo: blockDeviceIo,
    includeLoopDevices: true,
  });
}

async function groupSize(poolId: string): Promise<{ size: number; free: number }> {
  const [group] = parseVgs(
    await runChecked(runCommand, 'vgs', [...lvmReportArgs(VG_FIELDS), `ohr-${poolId}`]),
  );
  return { size: group?.sizeBytes ?? 0, free: group?.freeBytes ?? 0 };
}

async function volumeBytes(poolId: string, name: string): Promise<number> {
  const report = await runChecked(runCommand, 'lvs', [
    ...lvmReportArgs(LV_FIELDS),
    `ohr-${poolId}/${name}`,
  ]);
  return parseLvs(report)[0]?.sizeBytes ?? 0;
}

/** "raid5x3: loop1p2 loop2p2 loop3p2" for each array, to compare with a plan. */
async function arrays(poolId: string, tiers: number): Promise<string[]> {
  const lines: string[] = [];
  for (let tier = 1; tier <= tiers; tier += 1) {
    const detail = parseMdadmDetail(
      await runChecked(runCommand, 'mdadm', ['--detail', '--export', mdArrayPath(poolId, tier)]),
    );
    const members = detail.members
      .map((member) => member.device)
      .sort()
      .join(' ');
    lines.push(`${detail.level}x${detail.raidDevices}: ${members}`);
  }
  return lines;
}

function planned(
  tiers: readonly { level: string; partitionNumber: number; members: readonly string[] }[],
): string[] {
  return tiers.map((tier) => {
    const members = tier.members
      .map((drive) => partitionPath(drive, tier.partitionNumber))
      .sort()
      .join(' ');
    return `${tier.level}x${tier.members.length}: ${members}`;
  });
}

/** A pool on loop devices with one mounted volume holding a file, made by the real jobs. */
interface TestPool {
  readonly poolId: string;
  readonly loops: LoopDevices;
  readonly store: JobStore;
  readonly content: Buffer;
  tiers: number;
  mounted: boolean;
}

function confDir(pool: TestPool): string {
  return join(pool.loops.dir, 'mdadm.conf.d');
}

function mountPoint(pool: TestPool): string {
  return join(pool.loops.dir, VOLUME);
}

async function openPool(poolId: string, sizesGib: readonly number[]): Promise<TestPool> {
  return {
    poolId,
    loops: await attachLoopDevices(
      `ohr-${poolId}`,
      sizesGib.map((size) => Math.round(size * GIB)),
    ),
    store: JobStore.open(':memory:'),
    content: randomBytes(MIB),
    tiers: 0,
    mounted: false,
  };
}

/** Creates the pool on the first `count` drives and an all-free (or `bytes`) volume, and writes a file. */
async function createPool(
  pool: TestPool,
  count: number,
  volume: { readonly filesystem: FilesystemType; readonly bytes?: number },
): Promise<void> {
  const drives = await Promise.all(
    pool.loops.paths.slice(0, count).map(async (path) => ({
      path,
      sizeBytes: Number((await runChecked(runCommand, 'blockdev', ['--getsize64', path])).trim()),
    })),
  );
  const plan = planPool(
    drives.map((drive) => ({ id: drive.path, sizeBytes: drive.sizeBytes })),
    'shr1',
  );
  if (!plan.ok) {
    throw new Error(plan.error.code);
  }
  pool.tiers = plan.layout.tiers.length;
  await runToEnd(
    pool.store,
    buildPoolCreateJob(
      {
        poolId: pool.poolId,
        poolUuid: randomUUID(),
        redundancy: 'shr1',
        wipe: false,
        drives: drives.map((drive) => ({
          ...drive,
          serial: null,
          wwn: null,
          driveUuid: randomUUID(),
        })),
        layout: plan.layout,
      },
      { mdadmConfDir: confDir(pool) },
    ),
  );
  pool.mounted = true;
  let size: { kind: 'all-free' } | { kind: 'bytes'; bytes: number } = { kind: 'all-free' };
  if (volume.bytes !== undefined) {
    size = { kind: 'bytes', bytes: volume.bytes };
  }
  await runToEnd(
    pool.store,
    buildVolumeCreateJob(
      {
        poolId: pool.poolId,
        name: VOLUME,
        filesystem: volume.filesystem,
        size,
        mountPoint: mountPoint(pool),
      },
      { unitScope: 'runtime' },
    ),
  );
  await writeFile(join(mountPoint(pool), 'before.bin'), pool.content);
  for (let tier = 1; tier <= pool.tiers; tier += 1) {
    await waitForSync({
      files: readTextFile,
      array: await mdKernelName(mdArrayPath(pool.poolId, tier)),
      intervalMs: POLL_MS,
    });
  }
}

async function closePool(pool: TestPool, tiers: number): Promise<void> {
  if (pool.mounted) {
    await removeMountUnit(runCommand, mountPoint(pool), 'runtime').catch(() => undefined);
  }
  await runCommand('vgremove', ['--force', `ohr-${pool.poolId}`]);
  for (let tier = 1; tier <= Math.max(tiers, pool.tiers); tier += 1) {
    await runCommand('mdadm', ['--stop', mdArrayPath(pool.poolId, tier)]);
  }
  await pool.loops.detach();
  pool.store.close();
}

async function fileIntact(pool: TestPool): Promise<boolean> {
  return (await readFile(join(mountPoint(pool), 'before.bin'))).equals(pool.content);
}

describe.skipIf(!isRoot)('pool-expand killed after every step', () => {
  // A two-member RAID1 tier that converts, grows, and changes its chunk, and a
  // new RAID1 tier from space on a drive already in use, with the volume grown.
  let pool: TestPool;
  let targetTiers = 0;

  beforeAll(async () => {
    pool = await openPool('kx', [1.5, 2.75, 2.75]);
  });

  afterAll(async () => {
    await closePool(pool, targetTiers);
  });

  it('creates the pool', async () => {
    await createPool(pool, 2, { filesystem: 'ext4' });
    expect(await fileIntact(pool)).toBe(true);
  });

  it(
    'resumes from every step and grows the pool as planned',
    async () => {
      const state = await snapshot();
      const result = previewPoolExpand(
        {
          poolId: pool.poolId,
          devices: [pool.loops.paths[2] ?? ''],
          wipe: false,
          growVolume: VOLUME,
        },
        state,
        state.drives,
      );
      if (!result.ok) {
        throw new Error(result.reasons.join(' '));
      }
      const input = result.value;
      targetTiers = input.target.tiers.length;
      expect(input.target.tiers.map((tier) => `${tier.level}x${tier.members.length}`)).toEqual([
        'raid5x3',
        'raid1x2',
      ]);
      const crashes = await runWithCrashes(join(pool.loops.dir, 'jobs.db'), () =>
        buildPoolExpandJob(input, { mdadmConfDir: confDir(pool), pollIntervalMs: POLL_MS }),
      );
      expect(crashProblems(crashes)).toEqual([]);
      expect(await arrays(pool.poolId, targetTiers)).toEqual(planned(input.target.tiers));
      const group = await groupSize(pool.poolId);
      expect(group).toEqual({ size: input.target.usableBytes, free: 0 });
      expect(await volumeBytes(pool.poolId, VOLUME)).toBe(input.target.usableBytes);
      expect(await fileIntact(pool)).toBe(true);
    },
    JOB_TIMEOUT_MS,
  );
});

describe.skipIf(!isRoot)('drive-replace killed after every step', () => {
  // A healthy middle drive copied live on both tiers onto a new drive.
  let pool: TestPool;

  beforeAll(async () => {
    pool = await openPool('kr', [1.5, 2.75, 2.75, 2.75]);
  });

  afterAll(async () => {
    await closePool(pool, 0);
  });

  it('creates the pool', async () => {
    await createPool(pool, 3, { filesystem: 'ext4' });
    expect(await fileIntact(pool)).toBe(true);
  });

  it(
    'resumes from every step and swaps the drive in every tier',
    async () => {
      const sizeBefore = await groupSize(pool.poolId);
      const state = await snapshot();
      const result = previewDriveReplace(
        {
          poolId: pool.poolId,
          oldDrive: pool.loops.paths[1] ?? '',
          newDrive: pool.loops.paths[3] ?? '',
          wipe: false,
        },
        state,
        state.drives,
      );
      if (!result.ok) {
        throw new Error(result.reasons.join(' '));
      }
      const input = result.value;
      const crashes = await runWithCrashes(join(pool.loops.dir, 'jobs.db'), () =>
        buildDriveReplaceJob(input, { mdadmConfDir: confDir(pool), pollIntervalMs: POLL_MS }),
      );
      expect(crashProblems(crashes)).toEqual([]);
      expect(await arrays(pool.poolId, pool.tiers)).toEqual(planned(input.target.tiers));
      expect(await groupSize(pool.poolId)).toEqual(sizeBefore);
      expect(await fileIntact(pool)).toBe(true);
    },
    JOB_TIMEOUT_MS,
  );
});

describe.skipIf(!isRoot)('volume-grow killed after every step', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await openPool('kg', [1.5, 1.5]);
  });

  afterAll(async () => {
    await closePool(pool, 0);
  });

  it('creates the pool', async () => {
    await createPool(pool, 2, { filesystem: 'btrfs', bytes: 512 * MIB });
    expect(await fileIntact(pool)).toBe(true);
  });

  it('resumes from every step and grows the volume into all free space', async () => {
    const state = await snapshot();
    const result = previewVolumeGrow(
      { poolId: pool.poolId, name: VOLUME, size: { kind: 'all-free' } },
      state,
    );
    if (!result.ok) {
      throw new Error(result.reasons.join(' '));
    }
    const input = result.value;
    const crashes = await runWithCrashes(join(pool.loops.dir, 'jobs.db'), () =>
      buildVolumeGrowJob(input),
    );
    expect(crashProblems(crashes)).toEqual([]);
    const group = await groupSize(pool.poolId);
    expect(group.free).toBe(0);
    expect(await volumeBytes(pool.poolId, VOLUME)).toBe(group.size);
    expect(await fileIntact(pool)).toBe(true);
  });
});
