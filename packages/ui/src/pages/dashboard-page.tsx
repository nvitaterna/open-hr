import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { isFinished, type JobRecord } from '@ohr/shared/jobs';
import type { DriveView } from '@ohr/shared/pool-view';
import { DRIVE_ROLES } from '@ohr/shared/system-snapshot';

import { useDrives, useJobs, usePools, useSystem } from '../api/queries.ts';
import { JobList } from '../components/job-list.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { PoolCard } from '../components/pool-card.tsx';
import { Panel, Section } from '../components/section.tsx';
import { ROLE_LABELS } from '../labels.ts';

const LINK = 'text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400';

/** How many finished jobs the dashboard shows next to the running ones. */
const RECENT_FINISHED = 5;

function Pools(): ReactElement {
  const pools = usePools();
  if (pools.isPending) {
    return <Loading what="pools" />;
  }
  if (pools.isError) {
    return <ErrorMessage error={pools.error} />;
  }
  if (pools.data.pools.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No pools yet.{' '}
          <Link to="/pools/new" className={LINK}>
            Create a pool
          </Link>{' '}
          from the drives in this machine.
        </p>
      </Panel>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {pools.data.pools.map((pool) => (
        <PoolCard key={pool.id} pool={pool} />
      ))}
    </div>
  );
}

/** Unfinished jobs, then the most recent finished ones. */
function shownJobs(jobs: readonly JobRecord[]): JobRecord[] {
  const newestFirst = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [
    ...newestFirst.filter((job) => !isFinished(job.status)),
    ...newestFirst.filter((job) => isFinished(job.status)).slice(0, RECENT_FINISHED),
  ];
}

function Jobs(): ReactElement {
  const jobs = useJobs();
  if (jobs.isPending) {
    return <Loading what="jobs" />;
  }
  if (jobs.isError) {
    return <ErrorMessage error={jobs.error} />;
  }
  return (
    <Panel>
      <JobList jobs={shownJobs(jobs.data.jobs)} />
    </Panel>
  );
}

function roleCounts(drives: readonly DriveView[]): { role: string; count: number }[] {
  return DRIVE_ROLES.map((role) => ({
    role: ROLE_LABELS[role],
    count: drives.filter((drive) => drive.role === role).length,
  })).filter((entry) => entry.count > 0);
}

function Drives(): ReactElement {
  const drives = useDrives();
  if (drives.isPending) {
    return <Loading what="drives" />;
  }
  if (drives.isError) {
    return <ErrorMessage error={drives.error} />;
  }
  return (
    <Panel>
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        {roleCounts(drives.data.drives).map(({ role, count }) => (
          <div key={role}>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{role}</dt>
            <dd className="text-xl font-semibold">{count}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/** Problems core noticed while reading the machine. Nothing shows when there are none. */
function SystemWarnings(): ReactElement | null {
  const system = useSystem();
  const warnings = system.data?.snapshot.warnings ?? [];
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div
      className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
      role="status"
    >
      <ul className="list-disc space-y-1 pl-5">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

export function DashboardPage(): ReactElement {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <SystemWarnings />
      <Section
        title="Pools"
        aside={
          <Link to="/pools/new" className={LINK}>
            Create pool
          </Link>
        }
      >
        <Pools />
      </Section>
      <Section title="Jobs">
        <Jobs />
      </Section>
      <Section
        title="Drives"
        aside={
          <Link to="/drives" className={LINK}>
            All drives
          </Link>
        }
      >
        <Drives />
      </Section>
    </div>
  );
}
