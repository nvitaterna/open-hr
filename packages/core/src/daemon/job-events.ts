/**
 * Job events as RPC events (decision 0007), including progress, which is
 * sent but never stored (decision 0011).
 */

import type { RpcServer } from '@ohr/rpc/server';

import type { JobEvent } from '../jobs/engine.ts';

/** Sends a job event to the subscribed clients under its RPC name. */
export function publishJobEvent(server: Pick<RpcServer, 'publish'>, event: JobEvent): void {
  if (event.kind === 'job') {
    server.publish('job.status', { jobId: event.jobId, status: event.status, error: event.error });
  } else if (event.kind === 'step') {
    server.publish('job.step', {
      jobId: event.jobId,
      index: event.index,
      name: event.name,
      status: event.status,
      error: event.error,
    });
  } else if (event.kind === 'log') {
    server.publish('job.log', { jobId: event.jobId, step: event.step, line: event.line });
  } else {
    server.publish('job.progress', {
      jobId: event.jobId,
      step: event.step,
      operation: event.operation,
      fraction: event.fraction,
      etaSeconds: event.etaSeconds,
    });
  }
}
