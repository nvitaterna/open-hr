/** What core answers for each RPC method (decision 0007). */

import { RpcError } from '@ohr/rpc/rpc-error';
import type { Handlers } from '@ohr/rpc/server';

import type { JobStore } from '../jobs/store.ts';
import type { StateCache } from './state-cache.ts';

export interface HandlerContext {
  readonly store: JobStore;
  readonly state: StateCache;
}

export function createHandlers(context: HandlerContext): Handlers {
  return {
    'system.state': () => context.state.get(),
    'jobs.list': () => Promise.resolve({ jobs: context.store.listJobs() }),
    'jobs.get': ({ id }) => {
      const job = context.store.getJob(id);
      if (job === null) {
        return Promise.reject(new RpcError('not-found', `There is no job ${id}.`));
      }
      return Promise.resolve({ job, log: context.store.logLines(id) });
    },
  };
}
