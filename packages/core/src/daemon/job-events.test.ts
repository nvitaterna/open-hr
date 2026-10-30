import { describe, expect, it } from 'vitest';

import { publishJobEvent } from './job-events.ts';

const JOB_ID = '00000000-0000-4000-8000-000000000001';

describe('publishJobEvent', () => {
  it('sends each job event under its RPC name', () => {
    const sent: [string, unknown][] = [];
    const server = {
      publish: (event: string, data: unknown) => {
        sent.push([event, data]);
      },
    };
    publishJobEvent(server, { kind: 'job', jobId: JOB_ID, status: 'running', error: null });
    publishJobEvent(server, {
      kind: 'step',
      jobId: JOB_ID,
      index: 1,
      name: 'wait for tier 1 reshape',
      status: 'running',
      error: null,
    });
    publishJobEvent(server, { kind: 'log', jobId: JOB_ID, step: 1, line: 'reshape 10% done' });
    publishJobEvent(server, {
      kind: 'progress',
      jobId: JOB_ID,
      step: 1,
      operation: 'reshape',
      fraction: 0.12,
      etaSeconds: 900,
    });
    expect(sent.map(([event]) => event)).toEqual([
      'job.status',
      'job.step',
      'job.log',
      'job.progress',
    ]);
    expect(sent[3]?.[1]).toEqual({
      jobId: JOB_ID,
      step: 1,
      operation: 'reshape',
      fraction: 0.12,
      etaSeconds: 900,
    });
  });
});
