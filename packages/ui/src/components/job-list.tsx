import type { ReactElement } from 'react';

import type { JobRecord } from '@ohr/shared/jobs';

import { formatTime, JOB_KIND_LABELS } from '../labels.ts';
import { StatusBadge } from './status-badge.tsx';

function currentStep(job: JobRecord): string {
  const step = job.steps.find((candidate) => candidate.status === 'running');
  if (step === undefined) {
    return '';
  }
  return `Step ${step.index + 1} of ${job.steps.length}: ${step.name}`;
}

function JobLine({ job }: { readonly job: JobRecord }): ReactElement {
  let detail = currentStep(job);
  if (job.error !== null) {
    detail = job.error;
  }
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          {JOB_KIND_LABELS[job.kind]} on {job.poolId}
        </span>
        <StatusBadge status={job.status} />
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
          {formatTime(job.createdAt)}
        </span>
      </div>
      {detail !== '' && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{detail}</p>}
    </li>
  );
}

/** Jobs, newest first. */
export function JobList({ jobs }: { readonly jobs: readonly JobRecord[] }): ReactElement {
  if (jobs.length === 0) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">No jobs yet.</p>;
  }
  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {jobs.map((job) => (
        <JobLine key={job.id} job={job} />
      ))}
    </ul>
  );
}
