/**
 * ohr-core killed during a reshape (decision 0011). A client submits a
 * pool-expand that grows a RAID5 tier onto a new drive. The daemon is killed
 * with SIGKILL while md reshapes, twice: the first time it is started again
 * at once and its wait step attaches to the reshape the kernel kept
 * running; the second time the arrays are stopped and assembled again first,
 * as at boot, so the tier comes back auto-read-only with its reshape
 * pending, and the wait step must set it read-write. The job then finishes
 * with the planned arrays and capacity, and a file written before reads
 * back. The daemon runs as its own process from the build (`pnpm build`
 * first). Needs root; run with `pnpm --filter @ohr/core test:integration`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RpcClient } from '@ohr/rpc/client';
import type { RpcEvent } from '@ohr/rpc/contract';
import type { JobRecord } from '@ohr/shared/jobs';
import { lvmReportArgs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import { planPool } from '@ohr/shared/planner';
import type { PoolExpandInput } from '@ohr/shared/pool-expand-input';

import { runChecked, runCommand } from '../command-runner.ts';
import { logicalVolumePath } from '../executors/lvm.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { mdKernelName, readSyncState, waitForSync } from '../executors/md-sync.ts';
import { mountVolume, unmountVolume } from '../executors/mount.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { partitionPath } from '../executors/partition-drive.ts';
import { readTextFile } from '../file-reader.ts';
import { runJob, submitJob } from '../jobs/engine.ts';
import { buildPoolCreateJob } from '../jobs/pool-create.ts';
import { JobStore } from '../jobs/store.ts';
import { buildVolumeCreateJob } from '../jobs/volume-create.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const POOL = 'dk';
const VOLUME = 'data';
const DRIVE_BYTES = 1.5 * GIB;
const POLL_MS = 200;
const WAIT_MS = 120_000;
const TEST_TIMEOUT_MS = 600_000;
/** KiB/s. Slow enough that the reshape is still running at each kill. */
const SLOW_RESHAPE = '2000';
const WAIT_STEP = 'wait for tier 1 reshape';
const GROW_STEP = 'grow tier 1 to 4 members';
const DONE_OR_SKIPPED = /^(?:done|skipped)$/u;
const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

/** Starts the daemon from the build with the test's paths, as `ohr-core --allow-loop` would. */
const DAEMON_SCRIPT = `
import process from 'node:process';
const [, dist, socketPath, databasePath, mdadmConfDir] = process.argv;
const { startDaemon } = await import(dist + 'daemon/daemon.js');
const { runCommand } = await import(dist + 'command-runner.js');
const { blockDeviceIo } = await import(dist + 'executors/label-partition.js');
const { readTextFile } = await import(dist + 'file-reader.js');
await startDaemon({
  socketPath,
  databasePath,
  socketGroup: null,
  run: runCommand,
  readFile: readTextFile,
  labelIo: blockDeviceIo,
  allowLoopDevices: true,
  jobDeps: { poolExpand: { mdadmConfDir, pollIntervalMs: ${POLL_MS} } },
  log: (line) => process.stderr.write(line + '\\n'),
});
`;

const isRoot = process.getuid?.() === 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns true, or throws `what` after WAIT_MS. */
async function until(what: string, check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting until ${what}`);
    }
    await delay(POLL_MS);
  }
}

async function sysfs(path: string, file: string): Promise<string> {
  const text = await readTextFile(`/sys/block/${await mdKernelName(path)}/md/${file}`);
  return text?.trim() ?? '';
}

async function reshaping(path: string): Promise<boolean> {
  const state = await readSyncState(readTextFile, await mdKernelName(path));
  return state.kind === 'busy' && state.progress.operation === 'reshape';
}

describe.skipIf(!isRoot)('ohr-core killed during a reshape', () => {
  const tier1 = mdArrayPath(POOL, 1);
  const content = randomBytes(MIB);
  const events: RpcEvent[] = [];
  let loops: LoopDevices;
  let daemon: ChildProcess | null = null;
  let rpc: RpcClient | null = null;
  let mountedBy: 'unit' | 'mount' | null = null;
  let input: PoolExpandInput | null = null;
  let jobId = '';
  const dir = (name: string): string => join(loops.dir, name);
  const socket = (): string => dir('core.sock');
  const mountPoint = (): string => dir(VOLUME);

  async function start(): Promise<RpcClient> {
    const log = await open(dir('core.log'), 'a');
    const child = spawn(
      process.execPath,
      [
        ...['--input-type=module', '-e', DAEMON_SCRIPT, '--'],
        ...[DIST, socket(), dir('ohr.db'), dir('mdadm.conf.d')],
      ],
      { stdio: ['ignore', log.fd, log.fd] },
    );
    daemon = child;
    await log.close();
    await until('ohr-core listens', async () => {
      if (child.exitCode !== null) {
        throw new Error(`ohr-core exited with ${child.exitCode}; see ${dir('core.log')}`);
      }
      try {
        rpc = await RpcClient.connect(socket());
        return true;
      } catch {
        return false;
      }
    });
    if (rpc === null) {
      throw new Error('no client');
    }
    await rpc.subscribe((event) => events.push(event));
    return rpc;
  }

  async function kill(): Promise<void> {
    const child = daemon;
    daemon = null;
    await rpc?.close().catch(() => undefined);
    rpc = null;
    if (child === null || child.exitCode !== null) {
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }

  async function job(): Promise<{ job: JobRecord; log: { line: string }[] }> {
    if (rpc === null) {
      throw new Error('ohr-core is not running');
    }
    return await rpc.call('jobs.get', { id: jobId });
  }

  /** Every step's status, read from the database. */
  function storedSteps(): string[] {
    const store = JobStore.open(dir('ohr.db'));
    try {
      return (store.getJob(jobId)?.steps ?? []).map((step) => `${step.name}: ${step.status}`);
    } finally {
      store.close();
    }
  }

  /** What mdadm's grow --continue service logged, on systems that start it at assembly. */
  async function journal(): Promise<string[]> {
    const result = await runCommand('journalctl', [
      ...['--no-pager', '-n', '15', '-o', 'cat'],
      ...['-u', 'mdadm-grow-continue@*'],
    ]);
    if (result.kind !== 'exited') {
      return [result.kind];
    }
    return result.stdout.split('\n');
  }

  /** The job's last log lines, read from the database rather than over the socket. */
  function storedLog(): string[] {
    const store = JobStore.open(dir('ohr.db'));
    try {
      return store
        .logLines(jobId)
        .map((line) => line.line)
        .slice(-12);
    } finally {
      store.close();
    }
  }

  async function stepStatus(name: string): Promise<string> {
    return (await job()).job.steps.find((step) => step.name === name)?.status ?? 'missing';
  }

  beforeAll(async () => {
    if (!existsSync(join(DIST, 'daemon', 'daemon.js'))) {
      throw new Error(`No build in ${DIST}. Run pnpm build first.`);
    }
    loops = await attachLoopDevices(
      'ohr-dk',
      [1, 2, 3, 4].map(() => DRIVE_BYTES),
    );
  });

  afterAll(async () => {
    await kill();
    if (mountedBy === 'unit') {
      await removeMountUnit(runCommand, mountPoint(), 'runtime').catch(() => undefined);
    } else if (mountedBy === 'mount') {
      await unmountVolume(runCommand, mountPoint()).catch(() => undefined);
    }
    await runCommand('vgremove', ['--force', `ohr-${POOL}`]);
    await runCommand('mdadm', ['--stop', tier1]);
    await loops.detach();
  });

  it('creates a RAID5 pool on three drives with a volume holding a file', async () => {
    const existing = loops.paths.slice(0, 3);
    const plan = planPool(
      existing.map((path) => ({ id: path, sizeBytes: DRIVE_BYTES })),
      'shr1',
    );
    if (!plan.ok) {
      throw new Error(plan.error.code);
    }
    expect(plan.layout.tiers.map((tier) => tier.level)).toEqual(['raid5']);
    const store = JobStore.open(':memory:');
    const create = buildPoolCreateJob(
      {
        poolId: POOL,
        poolUuid: randomUUID(),
        redundancy: 'shr1',
        wipe: false,
        drives: existing.map((path) => ({
          path,
          serial: null,
          wwn: null,
          sizeBytes: DRIVE_BYTES,
          driveUuid: randomUUID(),
        })),
        layout: plan.layout,
      },
      { mdadmConfDir: dir('mdadm.conf.d') },
    );
    mountedBy = 'unit';
    const volume = buildVolumeCreateJob(
      {
        poolId: POOL,
        name: VOLUME,
        filesystem: 'ext4',
        size: { kind: 'all-free' },
        mountPoint: mountPoint(),
      },
      { unitScope: 'runtime' },
    );
    for (const definition of [create, volume]) {
      const record = submitJob(store, definition, 'hash');
      expect((await runJob(store, definition, record.id, { run: runCommand })).status).toBe('done');
    }
    store.close();
    await writeFile(join(mountPoint(), 'before.bin'), content);
    await waitForSync({
      files: readTextFile,
      array: await mdKernelName(tier1),
      intervalMs: POLL_MS,
    });
    expect((await readFile(join(mountPoint(), 'before.bin'))).equals(content)).toBe(true);
  });

  it(
    'resumes a pool-expand after being killed mid-reshape, twice, the second time as after a reboot',
    async () => {
      // Slow the reshape before it starts, so each kill lands while it runs.
      await writeFile(`/sys/block/${await mdKernelName(tier1)}/md/sync_speed_max`, SLOW_RESHAPE);
      let client = await start();
      const preview = await client.call('pools.previewExpand', {
        poolId: POOL,
        devices: [loops.paths[3] ?? ''],
        wipe: false,
      });
      ({ input } = preview);
      expect(input.target.tiers.map((entry) => `${entry.level}x${entry.members.length}`)).toEqual([
        'raid5x4',
      ]);
      ({
        job: { id: jobId },
      } = await client.call('jobs.submit', {
        kind: 'pool-expand',
        input: preview.input,
        stateHash: preview.stateHash,
      }));

      // Kill 1: the kernel keeps reshaping while no daemon runs.
      await until('the wait step runs', async () => (await stepStatus(WAIT_STEP)) === 'running');
      expect(await reshaping(tier1)).toBe(true);
      await kill();
      expect(await reshaping(tier1)).toBe(true);
      events.length = 0;
      client = await start();
      // The resumed wait step reads the kernel's running reshape and reports it.
      await until('the resumed job reports the reshape', () =>
        events.some(
          (event) =>
            event.event === 'job.progress' &&
            event.data.jobId === jobId &&
            event.data.operation === 'reshape' &&
            (event.data.fraction ?? 0) > 0,
        ),
      );
      expect(await stepStatus(GROW_STEP)).toMatch(DONE_OR_SKIPPED);
      expect(await stepStatus(WAIT_STEP)).toBe('running');

      // Kill 2, then stop and assemble the pool again, as a reboot does.
      await kill();
      await removeMountUnit(runCommand, mountPoint(), 'runtime');
      mountedBy = null;
      await runChecked(runCommand, 'vgchange', ['--activate', 'n', `ohr-${POOL}`]);
      await runChecked(runCommand, 'mdadm', ['--stop', tier1]);
      const [tier] = input.target.tiers;
      await runChecked(runCommand, 'mdadm', [
        ...['--assemble', tier1],
        ...(tier?.members ?? []).map((drive) => partitionPath(drive, tier?.partitionNumber ?? 0)),
      ]);
      if ((await sysfs(tier1, 'array_state')) !== 'read-auto') {
        // Some mdadm builds start an assembled array read-write. Boot-time assembly does not.
        await writeFile(`/sys/block/${await mdKernelName(tier1)}/md/array_state`, 'read-auto');
      }
      await runChecked(runCommand, 'vgchange', ['--activate', 'y', `ohr-${POOL}`]);
      await runChecked(runCommand, 'udevadm', ['settle']);
      // The reshape is stuck until something writes: idle, with its position recorded.
      expect({
        state: await sysfs(tier1, 'array_state'),
        action: await sysfs(tier1, 'sync_action'),
      }).toEqual({ state: 'read-auto', action: 'idle' });
      expect(await sysfs(tier1, 'reshape_position')).not.toBe('none');

      client = await start();
      await until('the job finishes', async () => (await job()).job.status !== 'running');
      const { job: finished, log } = await job();
      expect({ status: finished.status, error: finished.error }).toEqual({
        status: 'done',
        error: null,
      });
      expect(log.map((line) => line.line)).toContain(
        `${tier1} is auto-read-only; setting it read-write so its work continues`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it('has the planned array and capacity, and the file', async () => {
    if (input === null) {
      throw new Error('the expand did not run');
    }
    const [tier] = input.target.tiers;
    const detail = parseMdadmDetail(
      await runChecked(runCommand, 'mdadm', ['--detail', '--export', tier1]),
    );
    expect(detail.members.map((member) => member.device).sort()).toEqual(
      (tier?.members ?? []).map((drive) => partitionPath(drive, tier?.partitionNumber ?? 0)).sort(),
    );
    expect(detail.raidDevices).toBe(4);
    const [group] = parseVgs(
      await runChecked(runCommand, 'vgs', [...lvmReportArgs(VG_FIELDS), `ohr-${POOL}`]),
    );
    // On a mismatch, show what md, LVM, and the job saw.
    const sizes = {
      group: group?.sizeBytes,
      array: Number((await runChecked(runCommand, 'blockdev', ['--getsize64', tier1])).trim()),
      volume: await runChecked(runCommand, 'pvs', ['--units', 'b', '-o', 'pv_name,pv_size', tier1]),
      log: storedLog(),
      steps: storedSteps(),
      md: await Promise.all(
        ['array_state', 'sync_action', 'reshape_position', 'sync_max', 'raid_disks'].map(
          async (file) => `${file}=${await sysfs(tier1, file)}`,
        ),
      ),
      core: ((await readTextFile(dir('core.log'))) ?? '').split('\n').slice(-15),
      journal: await journal(),
    };
    expect(sizes).toEqual({ ...sizes, group: input.target.usableBytes });
    await mountVolume(runCommand, {
      device: logicalVolumePath(POOL, VOLUME),
      type: 'ext4',
      mountPoint: mountPoint(),
    });
    mountedBy = 'mount';
    expect((await readFile(join(mountPoint(), 'before.bin'))).equals(content)).toBe(true);
  });
});
