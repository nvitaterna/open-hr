import { type ReactElement, useCallback, useState } from 'react';
import { useParams } from 'react-router';

import { firstIncompleteStep, type JobRecord } from '@ohr/shared/jobs';

import { isNotFound, useJob, useRetryJob } from '../api/queries.ts';
import { JobSteps, LogBox } from '../components/job-steps.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { Panel, Section } from '../components/section.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { formatTime, JOB_KIND_LABELS } from '../labels.ts';

const BUTTON =
  'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2';
const PRIMARY = `${BUTTON} bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:outline-emerald-700`;
const SECONDARY = `${BUTTON} border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900`;

/** Retrying asks once more, because it runs commands on the drives again. */
function Retry({ job }: { readonly job: JobRecord }): ReactElement {
  const [asking, setAsking] = useState(false);
  const retry = useRetryJob();
  const { mutate } = retry;
  const ask = useCallback(() => setAsking(true), []);
  const cancel = useCallback(() => setAsking(false), []);
  const confirm = useCallback(
    () => mutate(job.id, { onSuccess: () => setAsking(false) }),
    [mutate, job.id],
  );
  const from = firstIncompleteStep(job.steps);
  let fromText = 'the start';
  let fromShort = 'the start';
  if (from !== null) {
    fromShort = `step ${from.index + 1}`;
    fromText = `${fromShort}, ${from.name}`;
  }
  let failure: ReactElement | null = null;
  if (retry.isError) {
    failure = <ErrorMessage error={retry.error} />;
  }
  if (!asking) {
    return (
      <div className="space-y-3">
        <button type="button" className={PRIMARY} onClick={ask}>
          Retry
        </button>
        {failure}
      </div>
    );
  }
  return (
    <Panel>
      <p className="text-sm">
        Run this job again from {fromText}? Steps whose work is already done are skipped. Fix
        whatever made it fail first.
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" className={PRIMARY} disabled={retry.isPending} onClick={confirm}>
          Retry from {fromShort}
        </button>
        <button type="button" className={SECONDARY} onClick={cancel}>
          Cancel
        </button>
      </div>
      <div className="mt-3">{failure}</div>
    </Panel>
  );
}

function Times({ job }: { readonly job: JobRecord }): ReactElement {
  const rows: [string, string | null][] = [
    ['Created', job.createdAt],
    ['Started', job.startedAt],
    ['Finished', job.finishedAt],
  ];
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      {rows
        .filter(([, at]) => at !== null)
        .map(([label, at]) => (
          <div key={label}>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
            <dd>{formatTime(at ?? '')}</dd>
          </div>
        ))}
    </dl>
  );
}

/** One job: its steps with their commands, live log, and a retry when it failed. */
export function JobPage(): ReactElement {
  const { id = '' } = useParams();
  const query = useJob(id);
  if (query.isPending) {
    return <Loading what="the job" />;
  }
  if (query.isError) {
    if (isNotFound(query.error)) {
      return <ErrorMessage error={new Error('There is no such job.')} />;
    }
    return <ErrorMessage error={query.error} />;
  }
  const { job, log } = query.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {JOB_KIND_LABELS[job.kind]} on {job.poolId}
        </h1>
        <StatusBadge status={job.status} />
      </div>
      <Times job={job} />
      {job.error !== null && <ErrorMessage error={new Error(job.error)} />}
      {job.status === 'failed' && <Retry job={job} />}
      <LogBox lines={log.filter((line) => line.step === null)} />
      <Section title="Steps">
        <Panel>
          <JobSteps steps={job.steps} log={log} />
        </Panel>
      </Section>
    </div>
  );
}
