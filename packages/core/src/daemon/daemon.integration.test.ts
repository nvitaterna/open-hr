/**
 * ohr-core end to end on loop devices: a client previews and submits a pool
 * and then a volume over the socket, and the daemon runs both jobs with the
 * real executors and the real udev watcher. Needs root; run with
 * `pnpm --filter @ohr/core test:integration`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RpcClient } from '@ohr/rpc/client';
import type { RpcEvent } from '@ohr/rpc/contract';
import type { JobStatus } from '@ohr/shared/jobs';
import { lvmReportArgs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import { runChecked, runCommand } from '../command-runner.ts';
import { blockDeviceIo } from '../executors/label-partition.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { readMount } from '../executors/mount.ts';
import { removeMountUnit } from '../executors/mount-unit.ts';
import { readTextFile } from '../file-reader.ts';
import { attachLoopDevices, type LoopDevices } from '../loop-devices-test-helpers.ts';
import { type Daemon, startDaemon } from './daemon.ts';

const GIB = 1024 ** 3;
const POOL = 'dmn';
const VOLUME = 'data';
const CONTENT = 'written through a volume core created';
const JOB_TIMEOUT_MS = 120_000;
const POLL_MS = 100;

const isRoot = process.getuid?.() === 0;

describe.skipIf(!isRoot)('ohr-core on loop devices', () => {
  let loops: LoopDevices;
  let daemon: Daemon;
  let rpc: RpcClient;
  let input: PoolCreateInput | null = null;
  let mountPoint = '';
  let mounted = false;
  const events: RpcEvent[] = [];
  const logged: string[] = [];

  /** Jobs whose final status event has arrived, by id. */
  const finalStatus = new Map<string, JobStatus>();

  function record(event: RpcEvent): void {
    events.push(event);
    if (
      event.event === 'job.status' &&
      (event.data.status === 'done' || event.data.status === 'failed')
    ) {
      finalStatus.set(event.data.jobId, event.data.status);
    }
  }

  /** Resolves with the job's final status once its event arrives. */
  async function finished(jobId: string): Promise<JobStatus> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (!finalStatus.has(jobId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return (await rpc.call('jobs.get', { id: jobId })).job.status;
  }

  beforeAll(async () => {
    loops = await attachLoopDevices('ohr-daemon', [2 * GIB, 3 * GIB, 3 * GIB]);
    mountPoint = join(loops.dir, VOLUME);
    daemon = await startDaemon({
      socketPath: join(loops.dir, 'run', 'core.sock'),
      databasePath: join(loops.dir, 'ohr.db'),
      socketGroup: null,
      run: runCommand,
      readFile: readTextFile,
      labelIo: blockDeviceIo,
      allowLoopDevices: true,
      jobDeps: {
        poolCreate: { mdadmConfDir: join(loops.dir, 'mdadm.conf.d') },
        volumeCreate: { unitScope: 'runtime' },
      },
      log: (line) => logged.push(line),
    });
    rpc = await RpcClient.connect(join(loops.dir, 'run', 'core.sock'));
    await rpc.subscribe(record);
  });

  afterAll(async () => {
    await rpc.close();
    await daemon.jobs.idle();
    await daemon.close();
    if (mounted) {
      await removeMountUnit(runCommand, mountPoint, 'runtime').catch(() => undefined);
    }
    await runCommand('vgremove', ['--force', `ohr-${POOL}`]);
    for (const tier of input?.layout.tiers ?? []) {
      await runCommand('mdadm', ['--stop', mdArrayPath(POOL, tier.tier)]);
    }
    await loops.detach();
  });

  it('creates a pool a client previewed and submitted', async () => {
    const preview = await rpc.call('pools.previewCreate', {
      poolId: POOL,
      redundancy: 'shr1',
      devices: [...loops.paths],
      wipe: false,
    });
    ({ input } = preview);
    expect(input.layout.tiers.map((tier) => tier.level)).toEqual(['raid5', 'raid1']);
    const { job } = await rpc.call('jobs.submit', {
      kind: 'pool-create',
      input: preview.input,
      stateHash: preview.stateHash,
    });
    expect(await finished(job.id)).toBe('done');
    const [group] = parseVgs(
      await runChecked(runCommand, 'vgs', [...lvmReportArgs(VG_FIELDS), `ohr-${POOL}`]),
    );
    expect(group?.sizeBytes).toBe(input.layout.usableBytes);
    const steps = events.filter(
      (event) => event.event === 'job.step' && event.data.jobId === job.id,
    );
    expect(steps.length).toBe(2 * preview.steps.length);
  });

  it('notices the new pool in the cached state', async () => {
    await expect
      .poll(
        async () =>
          (await rpc.call('system.state', {})).snapshot.volumeGroups.map((group) => group.name),
        { timeout: 10_000 },
      )
      .toContain(`ohr-${POOL}`);
    expect(events.some((event) => event.event === 'state.changed')).toBe(true);
  });

  it('refuses to plan a second pool on the same drives without wiping', async () => {
    await expect(
      rpc.call('pools.previewCreate', {
        poolId: 'dmn2',
        redundancy: 'shr1',
        devices: [...loops.paths],
        wipe: false,
      }),
    ).rejects.toMatchObject({ code: 'rejected' });
  });

  it('creates a volume a client previewed and submitted, and mounts it', async () => {
    const preview = await rpc.call('volumes.previewCreate', {
      poolId: POOL,
      name: VOLUME,
      filesystem: 'ext4',
      size: { kind: 'all-free' },
      mountPoint,
    });
    expect(preview.sizeBytes).toBe(input?.layout.usableBytes);
    mounted = true;
    const { job } = await rpc.call('jobs.submit', {
      kind: 'volume-create',
      input: preview.input,
      stateHash: preview.stateHash,
    });
    expect(await finished(job.id)).toBe('done');
    const mount = await readMount(runCommand, mountPoint);
    expect(mount.fsType).toBe('ext4');
    await writeFile(join(mountPoint, 'check.txt'), CONTENT);
    expect(await readFile(join(mountPoint, 'check.txt'), 'utf8')).toBe(CONTENT);
  });

  it('shows the pool, its labels, tiers, and mounted volume', async () => {
    const { pool } = await rpc.call('pools.get', { id: POOL });
    expect(pool).toMatchObject({
      uuid: input?.poolUuid,
      redundancy: 'shr1',
      sizeBytes: input?.layout.usableBytes,
      freeBytes: 0,
      warnings: [],
    });
    // mdadm builds a new RAID5 by recovering onto its last member, so a fresh pool may show that.
    expect(['healthy', 'syncing', 'rebuilding']).toContain(pool.health);
    expect(pool.drives.map((drive) => [drive.path, drive.label])).toEqual(
      loops.paths.map((path) => [path, 'ok']),
    );
    expect(pool.tiers.map((tier) => tier.level)).toEqual(['raid5', 'raid1']);
    const states = pool.tiers.flatMap((tier) => tier.members.map((member) => member.state));
    expect(states).toHaveLength(5);
    expect(states.every((state) => state === 'active' || state === 'rebuilding')).toBe(true);
    expect(pool.volumes).toMatchObject([{ name: VOLUME, filesystem: 'ext4', mountPoint }]);
    const { drives } = await rpc.call('drives.list', {});
    expect(drives.filter((drive) => drive.poolId === POOL).map((drive) => drive.path)).toEqual([
      ...loops.paths,
    ]);
  });
});
