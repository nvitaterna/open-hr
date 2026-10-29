/** What core answers for each RPC method (decision 0007). */

import { RpcError } from '@ohr/rpc/rpc-error';
import type { Handlers } from '@ohr/rpc/server';
import { poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import type { DriveState } from '@ohr/shared/system-snapshot';

import type { CommandRunner } from '../command-runner.ts';
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
import { readLoopDrives } from '../system-state.ts';
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
  readonly run: CommandRunner;
  /** Offer loop devices as drives. Only for tests on loop devices. */
  readonly allowLoopDevices: boolean;
  readonly jobDeps: JobDeps;
}

export function createHandlers(context: HandlerContext): Handlers {
  async function candidates(state: CachedState): Promise<DriveState[]> {
    const drives = [...state.snapshot.drives];
    if (context.allowLoopDevices) {
      drives.push(...(await readLoopDrives(context.run)));
    }
    return drives;
  }

  // Submissions run one at a time, so two cannot both pass the checks against the same state.
  let submissions: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = submissions.then(task, task);
    submissions = result.catch(() => undefined);
    return result;
  }

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
    'pools.previewCreate': async (request) => {
      const state = await context.state.refresh();
      const input = unwrap(previewPoolCreate(request, state.snapshot, await candidates(state)));
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
          refuseIf(recheckPoolCreate(submission.input, state.snapshot, await candidates(state)));
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
