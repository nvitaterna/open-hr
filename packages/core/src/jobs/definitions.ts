/**
 * Rebuilds a stored job's definition from its kind and input (decision 0006).
 * The daemon uses it to run a job it just stored and to resume jobs after a
 * restart.
 */

import type { JobRecord } from '@ohr/shared/jobs';
import { poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import { volumeCreateInputSchema } from '@ohr/shared/volume-create-input';

import type { JobDefinition } from './engine.ts';
import { buildPoolCreateJob, type PoolCreateDeps } from './pool-create.ts';
import { buildVolumeCreateJob, type VolumeCreateDeps } from './volume-create.ts';

/** Overrides for the job builders. Tests point them at temporary directories. */
export interface JobDeps {
  readonly poolCreate?: PoolCreateDeps;
  readonly volumeCreate?: VolumeCreateDeps;
}

export function jobDefinition(
  job: Pick<JobRecord, 'kind' | 'input'>,
  deps: JobDeps = {},
): JobDefinition {
  if (job.kind === 'pool-create') {
    return buildPoolCreateJob(poolCreateInputSchema.parse(job.input), deps.poolCreate);
  }
  return buildVolumeCreateJob(volumeCreateInputSchema.parse(job.input), deps.volumeCreate);
}
