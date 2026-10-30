import { describe, expect, it } from 'vitest';

import { fakeRunner } from '../fake-system-test-helpers.ts';
import {
  formatCommand,
  type JobDefinition,
  type JobEvent,
  type Precondition,
  previewJob,
  runJob,
  type StepDefinition,
  submitJob,
} from './engine.ts';
import { JobMismatchError } from './job-mismatch-error.ts';
import { JobStore } from './store.ts';

const MACHINE_CHANGED = /machine changed/u;

interface Hooks {
  readonly precondition?: () => Promise<Precondition>;
  readonly action?: () => Promise<void>;
  readonly postcondition?: () => Promise<void>;
}

/** A step that records which of its parts ran, in `calls`. */
function fakeStep(name: string, calls: string[], hooks: Hooks = {}): StepDefinition {
  return {
    name,
    description: `Do ${name}`,
    commands: [`${name}-command`],
    precondition: () => {
      calls.push(`${name}:precondition`);
      return hooks.precondition?.() ?? Promise.resolve({ kind: 'ready' });
    },
    action: () => {
      calls.push(`${name}:action`);
      return hooks.action?.() ?? Promise.resolve();
    },
    postcondition: () => {
      calls.push(`${name}:postcondition`);
      return hooks.postcondition?.() ?? Promise.resolve();
    },
  };
}

/** "kind:status" for status events, "log:line" for log lines, "progress:fraction" for progress. */
function describeEvent(event: JobEvent): string {
  if (event.kind === 'log') {
    return `log:${event.line}`;
  }
  if (event.kind === 'progress') {
    return `progress:${event.fraction}`;
  }
  return `${event.kind}:${event.status}`;
}

function definition(steps: readonly StepDefinition[]): JobDefinition {
  return { kind: 'pool-create', poolId: 'p1', input: { x: 1 }, steps };
}

function setUp(steps: readonly StepDefinition[]): {
  store: JobStore;
  def: JobDefinition;
  jobId: string;
  events: JobEvent[];
  run: typeof runJob;
} {
  const store = JobStore.open(':memory:');
  const def = definition(steps);
  const jobId = submitJob(store, def, 'hash-1').id;
  const events: JobEvent[] = [];
  const run: typeof runJob = (s, d, id, options) =>
    runJob(s, d, id, { listener: (event) => events.push(event), ...options });
  return { store, def, jobId, events, run };
}

describe('formatCommand', () => {
  it('quotes only what a shell would need', () => {
    expect(formatCommand('mdadm', ['--create', '/dev/md/ohr_p1_t1', '--level=raid5'])).toBe(
      'mdadm --create /dev/md/ohr_p1_t1 --level=raid5',
    );
    expect(formatCommand('sgdisk', ['--change-name', "1:it's", 'a b', ''])).toBe(
      String.raw`sgdisk --change-name '1:it'\''s' 'a b' ''`,
    );
  });
});

describe('previewJob', () => {
  it('lists the steps and their commands', () => {
    const def = definition([fakeStep('one', []), fakeStep('two', [])]);
    expect(previewJob(def)).toEqual({
      kind: 'pool-create',
      poolId: 'p1',
      steps: [
        { name: 'one', description: 'Do one', commands: ['one-command'] },
        { name: 'two', description: 'Do two', commands: ['two-command'] },
      ],
    });
  });
});

describe('runJob', () => {
  it('runs every step in order and finishes the job', async () => {
    const calls: string[] = [];
    const { store, def, jobId, events, run } = setUp([
      fakeStep('one', calls),
      fakeStep('two', calls),
    ]);
    const job = await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(calls).toEqual([
      'one:precondition',
      'one:action',
      'one:postcondition',
      'two:precondition',
      'two:action',
      'two:postcondition',
    ]);
    expect(job.status).toBe('done');
    expect(job.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(events.map(describeEvent)).toEqual([
      'job:running',
      'step:running',
      'step:done',
      'step:running',
      'step:done',
      'job:done',
    ]);
  });

  it('sends progress to the listener without storing it', async () => {
    const step: StepDefinition = {
      ...fakeStep('wait', []),
      action: ({ progress }) => {
        progress({ operation: 'reshape', fraction: 0.25, etaSeconds: 600 });
        return Promise.resolve();
      },
    };
    const { store, def, jobId, events, run } = setUp([fakeStep('one', []), step]);
    await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(events.find((event) => event.kind === 'progress')).toEqual({
      kind: 'progress',
      jobId,
      step: 1,
      operation: 'reshape',
      fraction: 0.25,
      etaSeconds: 600,
    });
    expect(store.logLines(jobId)).toEqual([]);
  });

  it('skips a step whose work is already there', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([
      fakeStep('one', calls, {
        precondition: () => Promise.resolve({ kind: 'already-done', detail: 'table present' }),
      }),
      fakeStep('two', calls),
    ]);
    const job = await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(calls).toEqual([
      'one:precondition',
      'two:precondition',
      'two:action',
      'two:postcondition',
    ]);
    expect(job.steps.map((step) => step.status)).toEqual(['skipped', 'done']);
    expect(store.logLines(jobId)).toMatchObject([{ step: 0, line: 'Already done: table present' }]);
  });

  it('fails at a blocked step and leaves later steps pending', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([
      fakeStep('one', calls),
      fakeStep('two', calls, {
        precondition: () => Promise.resolve({ kind: 'blocked', reason: 'array is degraded' }),
      }),
      fakeStep('three', calls),
    ]);
    const job = await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(job).toMatchObject({ status: 'failed', error: 'two: array is degraded' });
    expect(job.steps.map((step) => [step.status, step.error])).toEqual([
      ['done', null],
      ['failed', 'array is degraded'],
      ['pending', null],
    ]);
    expect(calls).not.toContain('three:precondition');
  });

  it('fails when an action throws, without running its postcondition', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([
      fakeStep('one', calls, {
        action: () => Promise.reject(new Error('sgdisk exited with code 4')),
      }),
      fakeStep('two', calls),
    ]);
    const job = await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(job).toMatchObject({ status: 'failed', error: 'one: sgdisk exited with code 4' });
    expect(calls).toEqual(['one:precondition', 'one:action']);
  });

  it('fails when a postcondition throws', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([
      fakeStep('one', calls, { postcondition: () => Promise.reject(new Error('size differs')) }),
    ]);
    const job = await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(job).toMatchObject({ status: 'failed', error: 'one: size differs' });
    expect(job.steps[0]).toMatchObject({ status: 'failed', error: 'size differs' });
  });

  it('resumes after a crash from the first incomplete step', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([
      fakeStep('one', calls),
      fakeStep('two', calls, {
        precondition: () => Promise.resolve({ kind: 'already-done', detail: 'array exists' }),
      }),
      fakeStep('three', calls),
    ]);
    // The daemon died after step two's action finished but before its status was written.
    store.setJobStatus(jobId, 'running');
    store.setStepStatus(jobId, 0, 'done');
    store.setStepStatus(jobId, 1, 'running');
    const job = await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(calls).toEqual([
      'two:precondition',
      'three:precondition',
      'three:action',
      'three:postcondition',
    ]);
    expect(job.status).toBe('done');
    expect(job.steps.map((step) => step.status)).toEqual(['done', 'skipped', 'done']);
  });

  it('refuses to run when the machine changed since the preview', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([fakeStep('one', calls)]);
    const job = await run(store, def, jobId, {
      run: fakeRunner(new Map()).run,
      stateHash: 'hash-2',
    });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(MACHINE_CHANGED);
    expect(calls).toEqual([]);
    expect(job.steps[0]?.status).toBe('pending');
  });

  it('runs when the state hash still matches', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([fakeStep('one', calls)]);
    const job = await run(store, def, jobId, {
      run: fakeRunner(new Map()).run,
      stateHash: 'hash-1',
    });
    expect(job.status).toBe('done');
  });

  it('returns a finished job without running anything', async () => {
    const calls: string[] = [];
    const { store, def, jobId, run } = setUp([fakeStep('one', calls)]);
    store.setJobStatus(jobId, 'failed', 'earlier');
    const job = await run(store, def, jobId, { run: fakeRunner(new Map()).run });
    expect(job).toMatchObject({ status: 'failed', error: 'earlier' });
    expect(calls).toEqual([]);
  });

  it('rejects a definition that does not match the stored job', async () => {
    const { store, jobId, run } = setUp([fakeStep('one', [])]);
    const other = definition([fakeStep('different', [])]);
    await expect(run(store, other, jobId, { run: fakeRunner(new Map()).run })).rejects.toThrow(
      JobMismatchError,
    );
    await expect(
      run(store, other, '6f1c2b0e-8a3d-4c5e-9f7a-1b2c3d4e5f60', { run: fakeRunner(new Map()).run }),
    ).rejects.toThrow(JobMismatchError);
  });
});
