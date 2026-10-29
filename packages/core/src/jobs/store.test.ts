import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobConflictError } from './job-conflict-error.ts';
import { JobStore, type NewJob } from './store.ts';

const STEPS = [
  { name: 'partition /dev/sda', description: 'Partition /dev/sda', commands: ['sgdisk --clear'] },
  { name: 'create tier 1', description: 'Create the tier 1 array', commands: ['mdadm --create'] },
];

function newJob(poolId = 'p1'): NewJob {
  return {
    kind: 'pool-create',
    poolId,
    input: { drives: ['/dev/sda'] },
    stateHash: 'h1',
    steps: STEPS,
  };
}

/** A clock that ticks one second per call, so timestamps are predictable. */
function fakeClock(): () => string {
  let seconds = 0;
  return () => {
    seconds += 1;
    return new Date(Date.UTC(2026, 9, 29, 12, 0, seconds)).toISOString();
  };
}

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ohr-store-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('JobStore', () => {
  it('stores a job with pending steps and reads it back', () => {
    const store = JobStore.open(':memory:', fakeClock());
    const job = store.createJob(newJob());
    expect(job).toMatchObject({
      kind: 'pool-create',
      poolId: 'p1',
      status: 'pending',
      input: { drives: ['/dev/sda'] },
      stateHash: 'h1',
      createdAt: '2026-10-29T12:00:01.000Z',
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    expect(job.steps).toEqual([
      { index: 0, ...STEPS[0], status: 'pending', startedAt: null, finishedAt: null, error: null },
      { index: 1, ...STEPS[1], status: 'pending', startedAt: null, finishedAt: null, error: null },
    ]);
    expect(store.getJob(job.id)).toEqual(job);
    expect(store.getJob('6f1c2b0e-8a3d-4c5e-9f7a-1b2c3d4e5f60')).toBeNull();
    store.close();
  });

  it('allows one unfinished job per pool', () => {
    const store = JobStore.open(':memory:');
    const first = store.createJob(newJob());
    expect(() => store.createJob(newJob())).toThrow(JobConflictError);
    expect(store.createJob(newJob('p2')).poolId).toBe('p2');
    store.setJobStatus(first.id, 'running');
    expect(() => store.createJob(newJob())).toThrow(JobConflictError);
    store.setJobStatus(first.id, 'failed', 'boom');
    expect(store.createJob(newJob()).status).toBe('pending');
    store.close();
  });

  it('stamps start and finish times and keeps the first start', () => {
    const store = JobStore.open(':memory:', fakeClock());
    const { id } = store.createJob(newJob());
    const running = store.setJobStatus(id, 'running');
    expect(running.startedAt).toBe('2026-10-29T12:00:02.000Z');
    expect(store.setJobStatus(id, 'running').startedAt).toBe('2026-10-29T12:00:02.000Z');
    const done = store.setJobStatus(id, 'done');
    expect(done).toMatchObject({
      status: 'done',
      finishedAt: '2026-10-29T12:00:04.000Z',
      error: null,
    });
    store.close();
  });

  it('records step status, errors, and log lines', () => {
    const store = JobStore.open(':memory:', fakeClock());
    const { id } = store.createJob(newJob());
    store.setStepStatus(id, 0, 'running');
    store.appendLog(id, 0, 'sgdisk ran');
    store.setStepStatus(id, 0, 'done');
    store.setStepStatus(id, 1, 'running');
    store.setStepStatus(id, 1, 'failed', 'mdadm exited with code 1');
    store.appendLog(id, null, 'job failed');
    const job = store.getJob(id);
    expect(job?.steps.map((step) => [step.status, step.error])).toEqual([
      ['done', null],
      ['failed', 'mdadm exited with code 1'],
    ]);
    expect(job?.steps[0]).toMatchObject({
      startedAt: '2026-10-29T12:00:02.000Z',
      finishedAt: '2026-10-29T12:00:04.000Z',
    });
    expect(store.logLines(id)).toEqual([
      { step: 0, at: '2026-10-29T12:00:03.000Z', line: 'sgdisk ran' },
      { step: null, at: '2026-10-29T12:00:07.000Z', line: 'job failed' },
    ]);
    store.close();
  });

  it('lists unfinished jobs oldest first and all jobs newest first', () => {
    const store = JobStore.open(':memory:', fakeClock());
    const a = store.createJob(newJob('a'));
    const b = store.createJob(newJob('b'));
    const c = store.createJob(newJob('c'));
    store.setJobStatus(b.id, 'done');
    expect(store.unfinishedJobs().map((job) => job.poolId)).toEqual(['a', 'c']);
    expect(store.listJobs().map((job) => job.poolId)).toEqual(['c', 'b', 'a']);
    expect(a.id).not.toBe(c.id);
    store.close();
  });

  it('keeps jobs across reopening the file', () => {
    const path = join(workDir, 'ohr.db');
    const first = JobStore.open(path);
    const { id } = first.createJob(newJob());
    first.setStepStatus(id, 0, 'done');
    first.close();
    const second = JobStore.open(path);
    expect(second.getJob(id)?.steps[0]?.status).toBe('done');
    expect(second.unfinishedJobs()).toHaveLength(1);
    second.close();
  });
});
