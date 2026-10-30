/** What core answers for each RPC method (decision 0007). */

import type { ParsedParams } from '@ohr/rpc/contract';
import { RpcError } from '@ohr/rpc/rpc-error';
import type { Handlers } from '@ohr/rpc/server';
import { driveReplaceInputSchema } from '@ohr/shared/drive-replace-input';
import type { JobRecord } from '@ohr/shared/jobs';
import { poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import { poolExpandInputSchema } from '@ohr/shared/pool-expand-input';
import { deriveDrives, derivePools } from '@ohr/shared/pool-view';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import { type JobDeps, jobDefinition } from '../jobs/definitions.ts';
import { previewDriveReplace, recheckDriveReplace } from '../jobs/drive-replace-preview.ts';
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

type JobSubmission = ParsedParams<'jobs.submit'>;
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

/** The drives a job is about to add to a pool. */
function newDrivePaths(job: Pick<JobRecord, 'kind' | 'input'>): string[] {
  switch (job.kind) {
    case 'pool-create':
      return poolCreateInputSchema.parse(job.input).drives.map((drive) => drive.path);
    case 'pool-expand':
      return poolExpandInputSchema.parse(job.input).newDrives.map((drive) => drive.path);
    case 'drive-replace':
      return driveReplaceInputSchema.parse(job.input).newDrives.map((drive) => drive.path);
    case 'volume-create':
      return [];
    default:
      throw new Error(`Unhandled job kind: ${String(job.kind satisfies never)}`);
  }
}

/** One reason per new drive of `job` that another unfinished job is about to use. */
function busyReasons(store: JobStore, job: Pick<JobRecord, 'kind' | 'input'>): string[] {
  const busy = new Set(store.unfinishedJobs().flatMap(newDrivePaths));
  return newDrivePaths(job)
    .filter((path) => busy.has(path))
    .map((path) => `${path} is in use by another job that has not finished.`);
}

/** The checks a submitted input must pass against the machine as it is now. */
function recheck(submission: JobSubmission, snapshot: SystemSnapshot): string[] {
  switch (submission.kind) {
    case 'pool-create':
      return recheckPoolCreate(submission.input, snapshot, snapshot.drives);
    case 'pool-expand':
      return recheckPoolExpand(submission.input, snapshot, snapshot.drives);
    case 'drive-replace':
      return recheckDriveReplace(submission.input, snapshot, snapshot.drives);
    case 'volume-create':
      return recheckVolumeCreate(submission.input, snapshot);
    default:
      throw new Error(`Unhandled job kind: ${String(submission satisfies never)}`);
  }
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
    'drives.previewReplace': async (request) => {
      const state = await reading(context.state.refresh());
      const input = unwrap(previewDriveReplace(request, state.snapshot, state.snapshot.drives));
      const definition = jobDefinition({ kind: 'drive-replace', input }, context.jobDeps);
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
        refuseIf(recheck(submission, state.snapshot));
        refuseIf(busyReasons(context.store, submission));
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
