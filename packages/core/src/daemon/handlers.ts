/** What core answers for each RPC method (decision 0007). */

import { RpcError } from '@ohr/rpc/rpc-error';
import type { Handlers } from '@ohr/rpc/server';
import { poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import { poolExpandInputSchema } from '@ohr/shared/pool-expand-input';
import { deriveDrives, derivePools } from '@ohr/shared/pool-view';

import { type JobDeps, jobDefinition } from '../jobs/definitions.ts';
import { type JobDefinition, previewJob } from '../jobs/engine.ts';
import { previewPoolCreate, recheckPoolCreate } from '../jobs/pool-create-preview.ts';
import { previewPoolExpand, recheckPoolExpand } from '../jobs/pool-expand-preview.ts';
import type { PreviewResult } from '../jobs/preview-result.ts';
import type { JobStore } from '../jobs/store.ts';
import {
  previewVolumeCreate,
  recheckVolumeCreate,
  volumeSizeBytes,
} from '../jobs/volume-create-preview.ts';
import { SystemStateError } from '../system-state.ts';
import type { JobRunner } from './job-runner.ts';
import type { CachedState, StateCache } from './state-cache.ts';

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

/** Turns a failure to read the machine into an error the client can show. */
function reading<T>(read: Promise<T>): Promise<T> {
  return read.catch((error: unknown) => {
    if (error instanceof SystemStateError) {
      throw new RpcError('internal', `Reading the system failed: ${error.message}`);
    }
    throw error;
  });
}

function refuseIf(reasons: readonly string[]): void {
  if (reasons.length > 0) {
    throw new RpcError('rejected', REFUSED, reasons);
  }
}

/** Drives that unfinished pool-create and pool-expand jobs are about to add to a pool. */
function busyDevices(store: JobStore): Set<string> {
  const busy = new Set<string>();
  for (const job of store.unfinishedJobs()) {
    if (job.kind === 'pool-create') {
      for (const drive of poolCreateInputSchema.parse(job.input).drives) {
        busy.add(drive.path);
      }
    } else if (job.kind === 'pool-expand') {
      for (const drive of poolExpandInputSchema.parse(job.input).newDrives) {
        busy.add(drive.path);
      }
    }
  }
  return busy;
}

/** One reason per drive that another unfinished job is about to use. */
function busyReasons(store: JobStore, paths: readonly string[]): string[] {
  const busy = busyDevices(store);
  return paths
    .filter((path) => busy.has(path))
    .map((path) => `${path} is in use by another job that has not finished.`);
}

export interface HandlerContext {
  readonly store: JobStore;
  readonly state: StateCache;
  readonly jobs: JobRunner;
  readonly jobDeps: JobDeps;
  /** A fresh, uncached read that includes SMART data. */
  readonly readWithSmart: () => Promise<CachedState>;
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
    'system.state': ({ smart }) => {
      if (smart === true) {
        return reading(context.readWithSmart());
      }
      return reading(context.state.get());
    },
    'pools.list': async () => ({
      pools: derivePools((await reading(context.state.get())).snapshot),
    }),
    'pools.get': async ({ id }) => {
      const pool = derivePools((await reading(context.state.get())).snapshot).find(
        (candidate) => candidate.id === id,
      );
      if (pool === undefined) {
        throw new RpcError('not-found', `There is no pool ${id}.`);
      }
      return { pool };
    },
    'drives.list': async () => ({
      drives: deriveDrives((await reading(context.state.get())).snapshot),
    }),
    'jobs.list': () => Promise.resolve({ jobs: context.store.listJobs() }),
    'jobs.get': ({ id }) => {
      const job = context.store.getJob(id);
      if (job === null) {
        return Promise.reject(new RpcError('not-found', `There is no job ${id}.`));
      }
      return Promise.resolve({ job, log: context.store.logLines(id) });
    },
    'pools.previewCreate': async (request) => {
      const state = await reading(context.state.refresh());
      const input = unwrap(previewPoolCreate(request, state.snapshot, state.snapshot.drives));
      const definition = jobDefinition({ kind: 'pool-create', input }, context.jobDeps);
      return { input, steps: stepPreviews(definition), stateHash: state.stateHash };
    },
    'pools.previewExpand': async (request) => {
      const state = await reading(context.state.refresh());
      const input = unwrap(previewPoolExpand(request, state.snapshot, state.snapshot.drives));
      const definition = jobDefinition({ kind: 'pool-expand', input }, context.jobDeps);
      return { input, steps: stepPreviews(definition), stateHash: state.stateHash };
    },
    'volumes.previewCreate': async (request) => {
      const state = await reading(context.state.refresh());
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
        const state = await reading(context.state.refresh());
        if (state.stateHash !== submission.stateHash) {
          throw new RpcError('state-changed', STATE_CHANGED);
        }
        const { poolId } = submission.input;
        if (context.store.unfinishedJobs().some((job) => job.poolId === poolId)) {
          throw new RpcError('conflict', `Pool ${poolId} already has a job that has not finished.`);
        }
        if (submission.kind === 'pool-create') {
          refuseIf(recheckPoolCreate(submission.input, state.snapshot, state.snapshot.drives));
          refuseIf(
            busyReasons(
              context.store,
              submission.input.drives.map((drive) => drive.path),
            ),
          );
        } else if (submission.kind === 'pool-expand') {
          refuseIf(recheckPoolExpand(submission.input, state.snapshot, state.snapshot.drives));
          refuseIf(
            busyReasons(
              context.store,
              submission.input.newDrives.map((drive) => drive.path),
            ),
          );
        } else {
          refuseIf(recheckVolumeCreate(submission.input, state.snapshot));
        }
        const definition = jobDefinition(submission, context.jobDeps);
        // Submissions are serialized and the pool was checked above, so the store's own
        // one-job-per-pool index cannot refuse this one.
        return { job: context.jobs.submit(definition, state.stateHash) };
      }),
    'jobs.retry': ({ id }) =>
      serialize(() => {
        const job = context.store.getJob(id);
        if (job === null) {
          throw new RpcError('not-found', `There is no job ${id}.`);
        }
        if (job.status !== 'failed') {
          throw new RpcError('rejected', REFUSED, [`Job ${id} is ${job.status}, not failed.`]);
        }
        const pool = context.store.listJobs().filter((other) => other.poolId === job.poolId);
        if (pool.some((other) => other.status === 'pending' || other.status === 'running')) {
          throw new RpcError(
            'conflict',
            `Pool ${job.poolId} already has a job that has not finished.`,
          );
        }
        if (pool.some((other) => other.createdAt > job.createdAt)) {
          throw new RpcError('rejected', REFUSED, [
            `Pool ${job.poolId} has a newer job than ${id}. Only the latest job can be retried.`,
          ]);
        }
        return Promise.resolve({ job: context.jobs.retry(job) });
      }),
  };
}
