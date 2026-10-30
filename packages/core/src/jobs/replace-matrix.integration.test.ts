/**
 * The M4 replace suite (decision 0011): an SHR-1 pool on 2, 3, and 3 GiB
 * drives (tier 1 RAID5 on all three, tier 2 RAID1 on the two larger ones)
 * gets its middle drive replaced by the drive-replace job from a real
 * preview, with a volume mounted throughout:
 *
 * - healthy: both tiers are copied live with mdadm --replace;
 * - failed: the drive is failed in tier 1 only, so tier 1 is rebuilt and
 *   tier 2 is still copied live;
 * - missing: the pool is stopped, the drive detached, and the pool started
 *   degraded, as after a drive died during a power-off; both tiers rebuild.
 *
 * Each case checks every array has exactly the planned members and no
 * empty slot, the capacity is unchanged, the new drive's label, that the
 * old drive is not erased and shows as no longer in the pool, that a re-run
 * skips the work, and that a file written before reads back. Needs root;
 * run with `pnpm --filter @ohr/core test:integration`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DriveReplaceInput } from '@ohr/shared/drive-replace-input';
import { lvmReportArgs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { parseMdstat } from '@ohr/shared/parsers/mdstat';
import { planPool } from '@ohr/shared/planner';
import { derivePools } from '@ohr/shared/pool-view';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import { runChecked, runCommand } from '../command-runner.ts';
import { blockDeviceIo, readLabel } from '../executors/label-partition.ts';
import { logicalVolumePath } from '../executors/lvm.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { mdKernelName, waitForSync } from '../executors/md-sync.ts';
import { mdadmConfPath } from '../executors/mdadm-conf.ts';
import { mountVolume, unmountVolume } from '../executors/mount.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { partitionPath } from '../executors/partition-drive.ts';
import { readTextFile } from '../file-reader.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { buildDriveReplaceJob } from './drive-replace.ts';
import { previewDriveReplace } from './drive-replace-preview.ts';
import { type JobDefinition, runJob, submitJob } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';
import { JobStore } from './store.ts';
import { buildVolumeCreateJob } from './volume-create.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const SIZES_GIB = [2, 3, 3, 3];
/** The drive that is replaced, and the new drive, by index in SIZES_GIB. */
const OLD = 1;
const NEW = 3;
const VOLUME = 'data';
const POLL_MS = 200;
const REPLACE_TIMEOUT_MS = 900_000;
/** Steps that run again on a re-run because they only read. */
const RERUN_STEPS = /^wait for /u;

type Damage = 'none' | 'failed' | 'missing';

interface ReplaceCase {
  readonly poolId: string;
  readonly damage: Damage;
  readonly modes: readonly string[];
}

const CASES: readonly ReplaceCase[] = [
  { poolId: 'r1a', damage: 'none', modes: ['live', 'live'] },
  { poolId: 'r1b', damage: 'failed', modes: ['rebuild', 'live'] },
  { poolId: 'r1c', damage: 'missing', modes: ['rebuild', 'rebuild'] },
];

const isRoot = process.getuid?.() === 0;

async function runToEnd(store: JobStore, definition: JobDefinition): Promise<string[]> {
  const job = submitJob(store, definition, 'hash');
  const finished = await runJob(store, definition, job.id, { run: runCommand });
  if (finished.status !== 'done') {
    throw new Error(`${definition.kind} job ${finished.status}: ${finished.error ?? 'no error'}`);
  }
  return finished.steps.map((step) => `${step.name}: ${step.status}`);
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

async function settle(path: string): Promise<void> {
  await waitForSync({ files: readTextFile, array: await mdKernelName(path), intervalMs: POLL_MS });
}

async function groupBytes(poolId: string): Promise<number> {
  const [group] = parseVgs(
    await runChecked(runCommand, 'vgs', [...lvmReportArgs(VG_FIELDS), `ohr-${poolId}`]),
  );
  return group?.sizeBytes ?? 0;
}

describe.skipIf(!isRoot).each(CASES)('$poolId: replace a drive that is $damage', (testCase) => {
  const store = JobStore.open(':memory:');
  let loops: LoopDevices;
  let input: DriveReplaceInput | null = null;
  let tiers = 0;
  let mountPoint = '';
  let mountedBy: 'unit' | 'mount' | null = null;
  let sizeBefore = 0;
  const content = randomBytes(MIB);
  const confDir = (): string => join(loops.dir, 'mdadm.conf.d');
  const drive = (index: number): string => loops.paths[index] ?? '';

  async function damage(): Promise<void> {
    if (testCase.damage === 'failed') {
      await runChecked(runCommand, 'mdadm', [
        ...['--manage', mdArrayPath(testCase.poolId, 1)],
        ...['--fail', partitionPath(drive(OLD), 2)],
      ]);
      return;
    }
    if (testCase.damage !== 'missing') {
      return;
    }
    await removeMountUnit(runCommand, mountPoint, 'runtime');
    mountedBy = null;
    await runChecked(runCommand, 'vgchange', ['--activate', 'n', `ohr-${testCase.poolId}`]);
    for (let tier = 1; tier <= tiers; tier += 1) {
      await runChecked(runCommand, 'mdadm', ['--stop', mdArrayPath(testCase.poolId, tier)]);
    }
    await runChecked(runCommand, 'losetup', ['--detach', drive(OLD)]);
    await runChecked(runCommand, 'udevadm', ['settle']);
    await runChecked(runCommand, 'mdadm', [
      ...['--assemble', '--scan', '--run'],
      `--config=${mdadmConfPath(testCase.poolId, { confDir: confDir() })}`,
    ]);
    await runChecked(runCommand, 'udevadm', ['settle']);
    await runChecked(runCommand, 'vgchange', ['--activate', 'y', `ohr-${testCase.poolId}`]);
    await runChecked(runCommand, 'udevadm', ['settle']);
    await mountVolume(runCommand, {
      device: logicalVolumePath(testCase.poolId, VOLUME),
      type: 'ext4',
      mountPoint,
    });
    mountedBy = 'mount';
  }

  beforeAll(async () => {
    loops = await attachLoopDevices(
      `ohr-${testCase.poolId}`,
      SIZES_GIB.map((size) => size * GIB),
    );
    mountPoint = join(loops.dir, VOLUME);
  });

  afterAll(async () => {
    if (mountedBy === 'unit') {
      await removeMountUnit(runCommand, mountPoint, 'runtime').catch(() => undefined);
    } else if (mountedBy === 'mount') {
      await unmountVolume(runCommand, mountPoint).catch(() => undefined);
    }
    await runCommand('vgremove', ['--force', `ohr-${testCase.poolId}`]);
    for (let tier = 1; tier <= tiers; tier += 1) {
      await runCommand('mdadm', ['--stop', mdArrayPath(testCase.poolId, tier)]);
    }
    await loops.detach();
    store.close();
  });

  it('creates the pool, a mounted volume holding a file, and the damage', async () => {
    const existing = loops.paths.slice(0, NEW);
    const plan = planPool(
      existing.map((path, index) => ({ id: path, sizeBytes: (SIZES_GIB[index] ?? 0) * GIB })),
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
          poolId: testCase.poolId,
          poolUuid: randomUUID(),
          redundancy: 'shr1',
          wipe: false,
          drives: existing.map((path, index) => ({
            path,
            serial: null,
            wwn: null,
            sizeBytes: (SIZES_GIB[index] ?? 0) * GIB,
            driveUuid: randomUUID(),
          })),
          layout: plan.layout,
        },
        { mdadmConfDir: confDir() },
      ),
    );
    mountedBy = 'unit';
    await runToEnd(
      store,
      buildVolumeCreateJob(
        {
          poolId: testCase.poolId,
          name: VOLUME,
          filesystem: 'ext4',
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
    sizeBefore = await groupBytes(testCase.poolId);
    await damage();
    expect((await readFile(join(mountPoint, 'before.bin'))).equals(content)).toBe(true);
  });

  it(
    'replaces the drive from a preview, online',
    async () => {
      let oldDrive: string | null = drive(OLD);
      if (testCase.damage === 'missing') {
        oldDrive = null;
      }
      const state = await snapshot();
      const result = previewDriveReplace(
        { poolId: testCase.poolId, oldDrive, newDrive: drive(NEW), wipe: false },
        state,
        state.drives,
      );
      if (!result.ok) {
        throw new Error(result.reasons.join(' '));
      }
      input = result.value;
      expect(
        input.actions.flatMap((action) => {
          if (action.kind === 'replace-member') {
            return [action.mode];
          }
          return [];
        }),
      ).toEqual(testCase.modes);
      const job = buildDriveReplaceJob(input, { mdadmConfDir: confDir(), pollIntervalMs: POLL_MS });
      await runToEnd(store, job);
    },
    REPLACE_TIMEOUT_MS,
  );

  it('has exactly the planned members, the same capacity, and the new label', async () => {
    if (input === null) {
      throw new Error('the replace did not run');
    }
    const mdstat = parseMdstat((await readTextFile('/proc/mdstat')) ?? '');
    for (const tier of input.target.tiers) {
      const name = await mdKernelName(mdArrayPath(testCase.poolId, tier.tier));
      const array = mdstat.find((entry) => entry.name === name);
      expect(array?.members.map((member) => `/dev/${member.device}`).sort()).toEqual(
        tier.members.map((path) => partitionPath(path, tier.partitionNumber)).sort(),
      );
      expect(array?.members.some((member) => member.faulty || member.spare)).toBe(false);
      expect(array?.health?.workingDevices).toBe(tier.members.length);
    }
    expect(await groupBytes(testCase.poolId)).toBe(sizeBefore);
    const [added] = input.newDrives;
    expect(await readLabel(blockDeviceIo, partitionPath(drive(NEW), 1))).toMatchObject({
      kind: 'ok',
      descriptor: { poolUuid: input.poolUuid, driveUuid: added?.driveUuid },
    });
    expect((await readFile(join(mountPoint, 'before.bin'))).equals(content)).toBe(true);
  });

  it('leaves the old drive as it was, no longer in the pool', async ({ skip }) => {
    // A detached drive is gone from the machine, so there is nothing to look at.
    skip(testCase.damage === 'missing');
    expect(await readLabel(blockDeviceIo, partitionPath(drive(OLD), 1))).toMatchObject({
      kind: 'ok',
      descriptor: { poolId: testCase.poolId },
    });
    const pool = derivePools(await snapshot()).find(
      (candidate) => candidate.id === testCase.poolId,
    );
    expect(pool?.drives.find((candidate) => candidate.path === drive(OLD))?.membership).toBe(
      'removed',
    );
    expect(pool?.health).toBe('healthy');
  });

  it('skips the work on a re-run', async () => {
    if (input === null) {
      throw new Error('the replace did not run');
    }
    const job = buildDriveReplaceJob(input, { mdadmConfDir: confDir(), pollIntervalMs: POLL_MS });
    const steps = await runToEnd(store, job);
    expect(steps.filter((step) => !(step.endsWith(': skipped') || RERUN_STEPS.test(step)))).toEqual(
      [],
    );
  });
});
