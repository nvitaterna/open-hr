import type { ReactElement } from 'react';

import { useJobs } from '../api/queries.ts';
import { JobList } from '../components/job-list.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { Panel } from '../components/section.tsx';

/** Every job, newest first (plan section 5.6). */
export function JobsPage(): ReactElement {
  const jobs = useJobs();
  let body: ReactElement;
  if (jobs.isPending) {
    body = <Loading what="jobs" />;
  } else if (jobs.isError) {
    body = <ErrorMessage error={jobs.error} />;
  } else {
    const newestFirst = [...jobs.data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    body = (
      <Panel>
        <JobList jobs={newestFirst} />
      </Panel>
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
      {body}
    </div>
  );
}
