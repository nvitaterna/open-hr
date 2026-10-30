/**
 * Rebuilds a stored job's definition from its kind and input (decision 0006).
 * The daemon uses it to run a job it just stored and to resume jobs after a
 * restart.
 */

import type { JobRecord } from '@ohr/shared/jobs';
import { poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import { poolExpandInputSchema } from '@ohr/shared/pool-expand-input';
import { volumeCreateInputSchema } from '@ohr/shared/volume-create-input';

import type { JobDefinition } from './engine.ts';
import { buildPoolCreateJob, type PoolCreateDeps } from './pool-create.ts';
import { buildPoolExpandJob, type PoolExpandDeps } from './pool-expand.ts';
import { buildVolumeCreateJob, type VolumeCreateDeps } from './volume-create.ts';

/** Overrides for the job builders. Tests point them at temporary directories. */
export interface JobDeps {
  readonly poolCreate?: PoolCreateDeps;
  readonly volumeCreate?: VolumeCreateDeps;
  readonly poolExpand?: PoolExpandDeps;
}

export function jobDefinition(
  job: Pick<JobRecord, 'kind' | 'input'>,
  deps: JobDeps = {},
): JobDefinition {
  switch (job.kind) {
    case 'pool-create':
      return buildPoolCreateJob(poolCreateInputSchema.parse(job.input), deps.poolCreate);
    case 'volume-create':
      return buildVolumeCreateJob(volumeCreateInputSchema.parse(job.input), deps.volumeCreate);
    case 'pool-expand':
      return buildPoolExpandJob(poolExpandInputSchema.parse(job.input), deps.poolExpand);
    default:
      throw new Error(`Unhandled job kind: ${String(job.kind satisfies never)}`);
  }
}
