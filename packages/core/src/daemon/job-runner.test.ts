import { describe, expect, it } from 'vitest';

import type { JobRecord } from '@ohr/shared/jobs';

import type { JobDefinition, JobEvent, StepDefinition } from '../jobs/engine.ts';
import { JobConflictError } from '../jobs/job-conflict-error.ts';
import { JobStore } from '../jobs/store.ts';
import { JobRunner } from './job-runner.ts';

function step(name: string, done: string[]): StepDefinition {
  return {
    name,
    description: name,
    commands: [],
    precondition: () => Promise.resolve({ kind: 'ready' }),
    action: (context) => {
      context.log(`ran ${name}`);
      done.push(name);
      return Promise.resolve();
    },
    postcondition: () => Promise.resolve(),
  };
}

function definition(poolId: string, done: string[]): JobDefinition {
  return {
    kind: 'pool-create',
    poolId,
    input: { poolId },
    steps: [step('first', done), step('second', done)],
  };
}

function runner(
  store: JobStore,
  done: string[],
  events: JobEvent[] = [],
  logged: string[] = [],
): JobRunner {
  return new JobRunner({
    store,
    run: () => Promise.resolve({ kind: 'not-found' }),
    definitionFor: (job: JobRecord) => definition(job.poolId, done),
    onEvent: (event) => events.push(event),
    log: (line) => logged.push(line),
  });
}

describe('JobRunner', () => {
  it('stores a job and runs it in the background, reporting every event', async () => {
    const store = JobStore.open(':memory:');
    const done: string[] = [];
    const events: JobEvent[] = [];
    const jobs = runner(store, done, events);
    const job = jobs.submit(definition('p1', done), 'hash');
    expect(job.status).toBe('pending');
    await jobs.idle();
    expect(done).toEqual(['first', 'second']);
    expect(store.getJob(job.id)?.status).toBe('done');
    expect(events.map((event) => event.kind)).toEqual([
      'job',
      'step',
      'log',
      'step',
      'step',
      'log',
      'step',
      'job',
    ]);
    expect(jobs.runningJobIds).toEqual([]);
    store.close();
  });

  it('refuses a second job on a pool that has one unfinished', () => {
    const store = JobStore.open(':memory:');
    const done: string[] = [];
    const jobs = runner(store, done);
    jobs.submit(definition('p1', done), 'hash');
    expect(() => jobs.submit(definition('p1', done), 'hash')).toThrow(JobConflictError);
    return jobs.idle().then(() => store.close());
  });

  it('resumes unfinished jobs from their first incomplete step', async () => {
    const store = JobStore.open(':memory:');
    const done: string[] = [];
    const stored = store.createJob({
      kind: 'pool-create',
      poolId: 'p1',
      input: { poolId: 'p1' },
      stateHash: 'hash',
      steps: definition('p1', done).steps,
    });
    store.setJobStatus(stored.id, 'running');
    store.setStepStatus(stored.id, 0, 'done');
    const logged: string[] = [];
    const jobs = runner(store, done, [], logged);
    expect(jobs.resumeUnfinished()).toBe(1);
    await jobs.idle();
    expect(done).toEqual(['second']);
    expect(store.getJob(stored.id)?.status).toBe('done');
    expect(logged[0]).toBe(`Resuming job ${stored.id} (pool-create on pool p1).`);
    store.close();
  });

  it('fails a job it cannot rebuild instead of leaving it pending', () => {
    const store = JobStore.open(':memory:');
    const stored = store.createJob({
      kind: 'pool-create',
      poolId: 'p1',
      input: {},
      stateHash: 'hash',
      steps: [],
    });
    const jobs = new JobRunner({
      store,
      run: () => Promise.resolve({ kind: 'not-found' }),
      definitionFor: () => {
        throw new Error('bad input');
      },
      onEvent: () => undefined,
      log: () => undefined,
    });
    jobs.resumeUnfinished();
    expect(store.getJob(stored.id)).toMatchObject({
      status: 'failed',
      error: 'Could not resume: bad input',
    });
    store.close();
  });
});
