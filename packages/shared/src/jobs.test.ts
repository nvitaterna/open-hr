import { describe, expect, it } from 'vitest';

import { firstIncompleteStep, isFinished, jobRecordSchema, type StepRecord } from './jobs.ts';

function step(index: number, status: StepRecord['status']): StepRecord {
  return {
    index,
    name: `step ${index}`,
    description: '',
    commands: [],
    status,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

describe('jobs', () => {
  it('knows which statuses are final', () => {
    expect(isFinished('pending')).toBe(false);
    expect(isFinished('running')).toBe(false);
    expect(isFinished('done')).toBe(true);
    expect(isFinished('failed')).toBe(true);
  });

  it('finds the first step with work left', () => {
    expect(
      firstIncompleteStep([step(0, 'done'), step(1, 'skipped'), step(2, 'running')])?.index,
    ).toBe(2);
    expect(
      firstIncompleteStep([step(0, 'done'), step(1, 'failed'), step(2, 'pending')])?.index,
    ).toBe(1);
    expect(firstIncompleteStep([step(0, 'done'), step(1, 'skipped')])).toBeNull();
  });

  it('validates a persisted job', () => {
    const job = jobRecordSchema.parse({
      id: '6f1c2b0e-8a3d-4c5e-9f7a-1b2c3d4e5f60',
      kind: 'pool-create',
      poolId: 'p1',
      status: 'pending',
      input: { anything: true },
      stateHash: 'abc',
      createdAt: '2026-10-29T12:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      error: null,
      steps: [step(0, 'pending')],
    });
    expect(job.kind).toBe('pool-create');
    expect(() => jobRecordSchema.parse({ ...job, kind: 'teleport' })).toThrow();
  });
});
