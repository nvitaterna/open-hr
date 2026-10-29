/** What core answers for each RPC method (decision 0007). */

import { RpcError } from '@ohr/rpc/rpc-error';
import type { Handlers } from '@ohr/rpc/server';
import { poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import { deriveDrives, derivePools } from '@ohr/shared/pool-view';

import { type JobDeps, jobDefinition } from '../jobs/definitions.ts';
import { type JobDefinition, previewJob } from '../jobs/engine.ts';
import { previewPoolCreate, recheckPoolCreate } from '../jobs/pool-create-preview.ts';
import type { PreviewResult } from '../jobs/preview-result.ts';
import type { JobStore } from '../jobs/store.ts';
import {
  previewVolumeCreate,
  recheckVolumeCreate,
  volumeSizeBytes,
} from '../jobs/volume-create-preview.ts';
import type { JobRunner } from './job-runner.ts';
import type { StateCache } from './state-cache.ts';

const REFUSED = 'Open HR refused the request.';
const STATE_CHANGED = 'The machine changed since the preview. Preview it again.';

function unwrap<T>(result: PreviewResult<T>): T {
  if (!result.ok) {
    throw new RpcError('rejected', REFUSED, result.reasons);
  }
  return result.value;
}

function stepPreviews(
  definition: JobDefinition,
): { name: string; description: string; commands: string[] }[] {
  return previewJob(definition).steps.map((step) => ({
    name: step.name,
    description: step.description,
    commands: [...step.commands],
  }));
}

function refuseIf(reasons: readonly string[]): void {
  if (reasons.length > 0) {
    throw new RpcError('rejected', REFUSED, reasons);
  }
}

/** Devices that unfinished pool-create jobs are about to write to. */
function busyDevices(store: JobStore): Set<string> {
  const busy = new Set<string>();
  for (const job of store.unfinishedJobs()) {
    if (job.kind === 'pool-create') {
      for (const drive of poolCreateInputSchema.parse(job.input).drives) {
        busy.add(drive.path);
      }
    }
  }
  return busy;
}

export interface HandlerContext {
  readonly store: JobStore;
  readonly state: StateCache;
  readonly jobs: JobRunner;
  readonly jobDeps: JobDeps;
}

export function createHandlers(context: HandlerContext): Handlers {
  // Submissions run one at a time, so two cannot both pass the checks against the same state.
  let submissions: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = submissions.then(task, task);
    submissions = result.catch(() => undefined);
    return result;
  }

  return {
    'system.state': () => context.state.get(),
    'pools.list': async () => ({ pools: derivePools((await context.state.get()).snapshot) }),
    'pools.get': async ({ id }) => {
      const pool = derivePools((await context.state.get()).snapshot).find(
        (candidate) => candidate.id === id,
      );
      if (pool === undefined) {
        throw new RpcError('not-found', `There is no pool ${id}.`);
      }
      return { pool };
    },
    'drives.list': async () => ({ drives: deriveDrives((await context.state.get()).snapshot) }),
    'jobs.list': () => Promise.resolve({ jobs: context.store.listJobs() }),
    'jobs.get': ({ id }) => {
      const job = context.store.getJob(id);
      if (job === null) {
        return Promise.reject(new RpcError('not-found', `There is no job ${id}.`));
      }
      return Promise.resolve({ job, log: context.store.logLines(id) });
    },
    'pools.previewCreate': async (request) => {
      const state = await context.state.refresh();
      const input = unwrap(previewPoolCreate(request, state.snapshot, state.snapshot.drives));
      const definition = jobDefinition({ kind: 'pool-create', input }, context.jobDeps);
      return { input, steps: stepPreviews(definition), stateHash: state.stateHash };
    },
    'volumes.previewCreate': async (request) => {
      const state = await context.state.refresh();
      const input = unwrap(previewVolumeCreate(request, state.snapshot));
      const definition = jobDefinition({ kind: 'volume-create', input }, context.jobDeps);
      return {
        input,
        sizeBytes: volumeSizeBytes(input, state.snapshot),
        steps: stepPreviews(definition),
        stateHash: state.stateHash,
      };
    },
    'jobs.submit': (submission) =>
      serialize(async () => {
        const state = await context.state.refresh();
        if (state.stateHash !== submission.stateHash) {
          throw new RpcError('state-changed', STATE_CHANGED);
        }
        const { poolId } = submission.input;
        if (context.store.unfinishedJobs().some((job) => job.poolId === poolId)) {
          throw new RpcError('conflict', `Pool ${poolId} already has a job that has not finished.`);
        }
        if (submission.kind === 'pool-create') {
          refuseIf(recheckPoolCreate(submission.input, state.snapshot, state.snapshot.drives));
          const busy = busyDevices(context.store);
          refuseIf(
            submission.input.drives
              .filter((drive) => busy.has(drive.path))
              .map((drive) => `${drive.path} is in use by another job that has not finished.`),
          );
        } else {
          refuseIf(recheckVolumeCreate(submission.input, state.snapshot));
        }
        const definition = jobDefinition(submission, context.jobDeps);
        // Submissions are serialized and the pool was checked above, so the store's own
        // one-job-per-pool index cannot refuse this one.
        return { job: context.jobs.submit(definition, state.stateHash) };
      }),
  };
}
