/**
 * The M4 expand suite (decision 0011): pools created by the pool-create job,
 * then grown by the pool-expand job from a real preview, with a volume
 * mounted throughout. Covers a RAID1 tier that becomes RAID5 (with writes
 * running, the case that deadlocked md when the chunk changed too early), a
 * plain RAID5 grow, two drives at once, and a larger drive that builds a
 * new tier from space on a drive already in use. Each case checks every
 * array, the volume group against the plan, the new labels, that a re-run
 * skips the work, that a second expand finds nothing to do, and that a file
 * written before reads back. Needs root; run with
 * `pnpm --filter @ohr/core test:integration`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FilesystemType } from '@ohr/shared/constants';
import { lvmReportArgs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import { planPool } from '@ohr/shared/planner';
import type { PoolExpandInput } from '@ohr/shared/pool-expand-input';
import type { PoolExpandRequest } from '@ohr/shared/pool-expand-request';

import { runChecked, runCommand } from '../command-runner.ts';
import { blockDeviceIo, readLabel } from '../executors/label-partition.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { mdKernelName, waitForSync } from '../executors/md-sync.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { partitionPath } from '../executors/partition-drive.ts';
import { readTextFile } from '../file-reader.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { type JobDefinition, type JobEvent, runJob, submitJob } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';
import { buildPoolExpandJob } from './pool-expand.ts';
import { previewPoolExpand } from './pool-expand-preview.ts';
import { JobStore } from './store.ts';
import { buildVolumeCreateJob } from './volume-create.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const CHUNK_BYTES = 512 * 1024;
const VOLUME = 'data';
const POLL_MS = 200;
/** Reshapes of a few GiB on loop devices, twice for a converted tier. */
const EXPAND_TIMEOUT_MS = 900_000;
/** Steps that run again on a re-run because there is nothing to skip: they only read or are idempotent. */
const RERUN_STEPS = /^(?:wait for |resize tier |grow filesystem of )/u;

interface ExpandCase {
  readonly poolId: string;
  readonly sizesGib: readonly number[];
  readonly addGib: readonly number[];
  readonly filesystem: FilesystemType;
  /** Levels and member counts after the expand, as a check on the case itself. */
  readonly after: readonly string[];
  /** Keep writing to the volume while the job runs. */
  readonly writes: boolean;
  /** Grow the volume into the new space at the end of the job. */
  readonly growVolume: boolean;
}

const CASES: readonly ExpandCase[] = [
  {
    poolId: 'x1a',
    sizesGib: [2, 2],
    addGib: [2],
    filesystem: 'ext4',
    after: ['raid5x3'],
    writes: true,
    growVolume: false,
  },
  {
    poolId: 'x1b',
    sizesGib: [2, 2, 2],
    addGib: [2],
    filesystem: 'btrfs',
    after: ['raid5x4'],
    writes: false,
    growVolume: true,
  },
  {
    poolId: 'x1c',
    sizesGib: [2, 2],
    addGib: [2, 2],
    filesystem: 'btrfs',
    after: ['raid5x4'],
    writes: false,
    growVolume: false,
  },
  {
    poolId: 'x1d',
    sizesGib: [2, 3],
    addGib: [3],
    filesystem: 'ext4',
    after: ['raid5x3', 'raid1x2'],
    writes: false,
    growVolume: false,
  },
];

const isRoot = process.getuid?.() === 0;

type ProgressEvent = Extract<JobEvent, { readonly kind: 'progress' }>;

/** Runs the job to the end and returns "step: status" for each step. Progress events go to `progress`. */
async function runToEnd(
  store: JobStore,
  definition: JobDefinition,
  progress: ProgressEvent[] = [],
): Promise<string[]> {
  const job = submitJob(store, definition, 'hash');
  const finished = await runJob(store, definition, job.id, {
    run: runCommand,
    listener: (event) => {
      if (event.kind === 'progress') {
        progress.push(event);
      }
    },
  });
  if (finished.status !== 'done') {
    throw new Error(`${definition.kind} job ${finished.status}: ${finished.error ?? 'no error'}`);
  }
  return finished.steps.map((step) => `${step.name}: ${step.status}`);
}

async function settle(path: string): Promise<void> {
  await waitForSync({
    files: readTextFile,
    array: await mdKernelName(path),
    intervalMs: POLL_MS,
  });
}

async function preview(
  poolId: string,
  devices: readonly string[],
  growVolume: string | null = null,
): Promise<PoolExpandInput> {
  const snapshot = await readSystemState({
    run: runCommand,
    readFile: readTextFile,
    includeSmart: false,
    labelIo: blockDeviceIo,
    includeLoopDevices: true,
  });
  let request: PoolExpandRequest = { poolId, devices: [...devices], wipe: false };
  if (growVolume !== null) {
    request = { ...request, growVolume };
  }
  const result = previewPoolExpand(request, snapshot, snapshot.drives);
  if (!result.ok) {
    throw new Error(result.reasons.join(' '));
  }
  return result.value;
}

/** Writes and syncs 4 MiB at a time to a file in `dir` until stopped. */
function startWriter(dir: string): () => Promise<number> {
  let running = true;
  let written = 0;
  const loop = (async () => {
    const file = await open(join(dir, 'writer.bin'), 'w');
    try {
      while (running) {
        await file.write(randomBytes(4 * MIB), 0, 4 * MIB, 0);
        await file.sync();
        written += 1;
      }
    } finally {
      await file.close();
    }
  })();
  return async () => {
    running = false;
    await loop;
    return written;
  };
}

describe.skipIf(!isRoot).each(CASES)('$poolId: $sizesGib GiB plus $addGib GiB', (testCase) => {
  const store = JobStore.open(':memory:');
  const confDir = (): string => join(loops.dir, 'mdadm.conf.d');
  let loops: LoopDevices;
  let existing: string[] = [];
  let added: string[] = [];
  let input: PoolExpandInput | null = null;
  let tiersCreated = 0;
  let mountPoint = '';
  let mounted = false;
  const content = randomBytes(MIB);

  beforeAll(async () => {
    loops = await attachLoopDevices(
      `ohr-${testCase.poolId}`,
      [...testCase.sizesGib, ...testCase.addGib].map((size) => size * GIB),
    );
    existing = loops.paths.slice(0, testCase.sizesGib.length);
    added = loops.paths.slice(testCase.sizesGib.length);
    mountPoint = join(loops.dir, VOLUME);
  });

  afterAll(async () => {
    if (mounted) {
      await removeMountUnit(runCommand, mountPoint, 'runtime').catch(() => undefined);
    }
    await runCommand('vgremove', ['--force', `ohr-${testCase.poolId}`]);
    const tiers = Math.max(tiersCreated, input?.target.tiers.length ?? 0);
    for (let tier = 1; tier <= tiers; tier += 1) {
      await runCommand('mdadm', ['--stop', mdArrayPath(testCase.poolId, tier)]);
    }
    await loops.detach();
    store.close();
  });

  it('creates the pool and a mounted volume holding a file', async () => {
    const plan = planPool(
      existing.map((path, index) => ({
        id: path,
        sizeBytes: (testCase.sizesGib[index] ?? 0) * GIB,
      })),
      'shr1',
    );
    if (!plan.ok) {
      throw new Error(plan.error.code);
    }
    tiersCreated = plan.layout.tiers.length;
    await runToEnd(
      store,
      buildPoolCreateJob(
        {
          poolId: testCase.poolId,
          poolUuid: randomUUID(),
          redundancy: 'shr1',
          wipe: false,
          drives: existing.map((path, index) => ({
            path,
            serial: null,
            wwn: null,
            sizeBytes: (testCase.sizesGib[index] ?? 0) * GIB,
            driveUuid: randomUUID(),
          })),
          layout: plan.layout,
        },
        { mdadmConfDir: confDir() },
      ),
    );
    mounted = true;
    await runToEnd(
      store,
      buildVolumeCreateJob(
        {
          poolId: testCase.poolId,
          name: VOLUME,
          filesystem: testCase.filesystem,
          size: { kind: 'all-free' },
          mountPoint,
        },
        { unitScope: 'runtime' },
      ),
    );
    await writeFile(join(mountPoint, 'before.bin'), content);
    for (const tier of plan.layout.tiers) {
      await settle(mdArrayPath(testCase.poolId, tier.tier));
    }
    expect((await readFile(join(mountPoint, 'before.bin'))).equals(content)).toBe(true);
  });

  it(
    'grows the pool from a preview, online',
    async () => {
      let growVolume: string | null = null;
      if (testCase.growVolume) {
        growVolume = VOLUME;
      }
      input = await preview(testCase.poolId, added, growVolume);
      expect(input.target.tiers.map((tier) => `${tier.level}x${tier.members.length}`)).toEqual(
        testCase.after,
      );
      const job = buildPoolExpandJob(input, {
        mdadmConfDir: confDir(),
        pollIntervalMs: POLL_MS,
      });
      let stopWriter: () => Promise<number> = () => Promise.resolve(0);
      if (testCase.writes) {
        stopWriter = startWriter(mountPoint);
      }
      let written = 0;
      const progress: ProgressEvent[] = [];
      try {
        await runToEnd(store, job, progress);
      } finally {
        written = await stopWriter();
      }
      // The writer must have kept writing through the reshape, or the case proves nothing.
      expect(written > 0).toBe(testCase.writes);
      // The wait steps reported the kernel's reshape as it ran (decision 0011).
      const waitSteps = new Set(
        job.steps
          .map((step, index) => ({ name: step.name, index }))
          .filter((step) => step.name.startsWith('wait for'))
          .map((step) => step.index),
      );
      expect(progress.some((event) => event.operation === 'reshape')).toBe(true);
      expect(
        progress.every(
          (event) =>
            waitSteps.has(event.step) &&
            (event.fraction === null || (event.fraction >= 0 && event.fraction <= 1)),
        ),
      ).toBe(true);
    },
    EXPAND_TIMEOUT_MS,
  );

  it('has every array, chunk, and label the plan promised', async () => {
    if (input === null) {
      throw new Error('the expand did not run');
    }
    for (const tier of input.target.tiers) {
      const path = mdArrayPath(testCase.poolId, tier.tier);
      const detail = parseMdadmDetail(
        await runChecked(runCommand, 'mdadm', ['--detail', '--export', path]),
      );
      expect({ level: detail.level, raidDevices: detail.raidDevices }).toEqual({
        level: tier.level,
        raidDevices: tier.members.length,
      });
      expect(detail.members.map((member) => member.device).sort()).toEqual(
        tier.members.map((drive) => partitionPath(drive, tier.partitionNumber)).sort(),
      );
    }
    for (const tier of input.target.tiers.filter((candidate) => candidate.level === 'raid5')) {
      const kernelName = await mdKernelName(mdArrayPath(testCase.poolId, tier.tier));
      const chunk = await readTextFile(`/sys/block/${kernelName}/md/chunk_size`);
      expect(Number(chunk)).toBe(CHUNK_BYTES);
    }
    const [group] = parseVgs(
      await runChecked(runCommand, 'vgs', [...lvmReportArgs(VG_FIELDS), `ohr-${testCase.poolId}`]),
    );
    expect(group?.sizeBytes).toBe(input.target.usableBytes);
    // The volume took all the pool's space when created, so free space is left only if it was not grown.
    expect(group?.freeBytes === 0).toBe(testCase.growVolume);
    for (const drive of input.newDrives) {
      const label = await readLabel(blockDeviceIo, partitionPath(drive.path, 1));
      expect(label).toMatchObject({
        kind: 'ok',
        descriptor: { poolUuid: input.poolUuid, driveUuid: drive.driveUuid },
      });
    }
    expect((await readFile(join(mountPoint, 'before.bin'))).equals(content)).toBe(true);
  });

  it('skips the work on a re-run and finds nothing more to do', async () => {
    if (input === null) {
      throw new Error('the expand did not run');
    }
    const job = buildPoolExpandJob(input, { mdadmConfDir: confDir(), pollIntervalMs: POLL_MS });
    const steps = await runToEnd(store, job);
    const changed = steps.filter((step) => !(step.endsWith(': skipped') || RERUN_STEPS.test(step)));
    expect(changed).toEqual([]);
    await expect(preview(testCase.poolId, [])).rejects.toThrow();
  });
});
