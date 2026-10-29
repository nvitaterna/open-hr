import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '@ohr/rpc/client';
import type { RpcEvent } from '@ohr/rpc/contract';
import type { RpcError } from '@ohr/rpc/rpc-error';
import type { PoolCreateRequest } from '@ohr/shared/pool-create-request';

import type { CommandResult, LineWatcher } from '../command-runner.ts';
import {
  exampleShr1Answers,
  exampleShr1Files,
  exampleShr1Labels,
  fakeRunner,
  fixture,
  ok,
} from '../fake-system-test-helpers.ts';
import { type Daemon, startDaemon } from './daemon.ts';

const REQUEST: PoolCreateRequest = {
  poolId: 'p2',
  redundancy: 'shr1',
  devices: ['/dev/sda', '/dev/sdb', '/dev/sdc'],
  wipe: true,
};

let directory: string;
let socketPath: string;
let answers: Map<string, CommandResult>;
let daemon: Daemon;
let rpc: RpcClient;
let udevLine: (line: string) => void;
/** While set, every command except the state reads waits for it, so a job stays running. */
let hold: Promise<void> | null;
let release: () => void;

const STATE_READS = new Set(['lsblk', 'findmnt', 'pvs', 'vgs', 'lvs', 'mdadm']);

function holdJobs(): void {
  hold = new Promise((resolve) => {
    release = () => {
      hold = null;
      resolve();
    };
  });
}

const fakeWatch: LineWatcher = (_command, _args, onLine) => {
  udevLine = onLine;
  return { stop: () => undefined };
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-daemon-jobs-'));
  socketPath = join(directory, 'core.sock');
  answers = exampleShr1Answers();
  udevLine = () => undefined;
  hold = null;
  release = () => undefined;
  const fake = fakeRunner(answers).run;
  daemon = await startDaemon({
    socketPath,
    databasePath: ':memory:',
    socketGroup: null,
    watch: fakeWatch,
    run: async (command, args, options) => {
      if (hold !== null && !STATE_READS.has(command)) {
        await hold;
      }
      return fake(command, args, options);
    },
    readFile: exampleShr1Files(),
    labelIo: exampleShr1Labels(),
    log: () => undefined,
  });
  rpc = await RpcClient.connect(socketPath);
});

afterEach(async () => {
  release();
  await rpc.close();
  await daemon.jobs.idle();
  await daemon.close();
  await rm(directory, { recursive: true, force: true });
});

describe('previews over RPC', () => {
  it('refuses a pool with the reasons', async () => {
    const error = (await rpc
      .call('pools.previewCreate', { ...REQUEST, wipe: false })
      .catch((caught: unknown) => caught)) as RpcError;
    expect(error.code).toBe('rejected');
    expect(error.reasons).toContain(
      '/dev/sda is not empty (an Open HR pool). It has to be wiped first.',
    );
  });

  it('plans a pool and lists every step with its commands', async () => {
    const preview = await rpc.call('pools.previewCreate', REQUEST);
    expect(preview.input.drives.map((drive) => drive.path)).toEqual(REQUEST.devices);
    expect(preview.steps[0]?.name).toBe('partition /dev/sda');
    expect(preview.steps[0]?.commands.join('\n')).toContain('sgdisk --clear');
    expect(preview.stateHash).toBe((await daemon.state.get()).stateHash);
  });

  it('refuses a volume on a full pool', async () => {
    await expect(
      rpc.call('volumes.previewCreate', {
        poolId: 'p1',
        name: 'media',
        filesystem: 'btrfs',
        size: { kind: 'all-free' },
      }),
    ).rejects.toMatchObject({ code: 'rejected', reasons: ['Pool p1 has no free space.'] });
  });
});

describe('jobs.submit', () => {
  it('starts the job in core and streams its events', async () => {
    const preview = await rpc.call('pools.previewCreate', REQUEST);
    const events: RpcEvent[] = [];
    await rpc.subscribe((event) => events.push(event));
    const { job } = await rpc.call('jobs.submit', {
      kind: 'pool-create',
      input: preview.input,
      stateHash: preview.stateHash,
    });
    expect(job.kind).toBe('pool-create');
    await daemon.jobs.idle();
    // The fake machine has no sgdisk, so the first step fails and nothing after it runs.
    const { job: finished } = await rpc.call('jobs.get', { id: job.id });
    expect(finished.status).toBe('failed');
    expect(finished.steps.slice(1).every((step) => step.status === 'pending')).toBe(true);
    await rpc.call('jobs.list', {});
    expect(
      events.filter((event) => event.event === 'job.status').map((event) => event.data),
    ).toEqual([
      { jobId: job.id, status: 'running', error: null },
      { jobId: job.id, status: 'failed', error: finished.error },
    ]);
  });

  it('refuses a submission made from an older state', async () => {
    const preview = await rpc.call('pools.previewCreate', REQUEST);
    // A different set of drives: the hash no longer matches the preview's.
    answers.set('lsblk', ok(fixture('virtio-vm/lsblk.json')));
    await expect(
      rpc.call('jobs.submit', {
        kind: 'pool-create',
        input: preview.input,
        stateHash: preview.stateHash,
      }),
    ).rejects.toMatchObject({ code: 'state-changed' });
    expect((await rpc.call('jobs.list', {})).jobs).toEqual([]);
  });

  it('refuses an input that differs from what the preview built', async () => {
    const preview = await rpc.call('pools.previewCreate', REQUEST);
    const [first, ...rest] = preview.input.layout.tiers;
    if (first === undefined) {
      throw new Error('no tiers');
    }
    await expect(
      rpc.call('jobs.submit', {
        kind: 'pool-create',
        input: {
          ...preview.input,
          layout: { ...preview.input.layout, tiers: [{ ...first, level: 'raid1' }, ...rest] },
        },
        stateHash: preview.stateHash,
      }),
    ).rejects.toMatchObject({ code: 'rejected' });
  });

  it('answers conflict while the pool has a job running', async () => {
    holdJobs();
    const preview = await rpc.call('pools.previewCreate', REQUEST);
    const submission = {
      kind: 'pool-create',
      input: preview.input,
      stateHash: preview.stateHash,
    } as const;
    const results = await Promise.allSettled([
      rpc.call('jobs.submit', submission),
      rpc.call('jobs.submit', submission),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'conflict' } });
  });

  it('refuses drives another unfinished job is about to write to', async () => {
    holdJobs();
    const preview = await rpc.call('pools.previewCreate', REQUEST);
    await rpc.call('jobs.submit', {
      kind: 'pool-create',
      input: preview.input,
      stateHash: preview.stateHash,
    });
    const other = await rpc.call('pools.previewCreate', { ...REQUEST, poolId: 'p3' });
    await expect(
      rpc.call('jobs.submit', {
        kind: 'pool-create',
        input: other.input,
        stateHash: other.stateHash,
      }),
    ).rejects.toMatchObject({
      code: 'rejected',
      reasons: [
        '/dev/sda is in use by another job that has not finished.',
        '/dev/sdb is in use by another job that has not finished.',
        '/dev/sdc is in use by another job that has not finished.',
      ],
    });
  });
});

describe('udev', () => {
  it('rereads the system once block events settle', async () => {
    const before = await daemon.state.get();
    answers.set('findmnt', ok(fixture('virtio-vm/findmnt.json')));
    udevLine('monitor will print the received events for:');
    udevLine('UDEV  [123.456] change   /devices/virtual/block/md127 (block)');
    udevLine('UDEV  [123.457] change   /devices/virtual/block/md126 (block)');
    await expect
      .poll(async () => (await daemon.state.get()).readAt, { timeout: 3000 })
      .not.toBe(before.readAt);
  });
});
