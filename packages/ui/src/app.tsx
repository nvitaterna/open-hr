/**
 * Which screen to show (decision 0010): setup until the admin exists, then
 * sign-in until there is a session, then the pages.
 */

import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router';

import { useMe, useSetupStatus } from './api/queries.ts';
import { Layout } from './components/layout.tsx';
import { ErrorMessage, Loading } from './components/page-states.tsx';
import { DashboardPage } from './pages/dashboard-page.tsx';
import { DrivesPage } from './pages/drives-page.tsx';
import { JobPage } from './pages/job-page.tsx';
import { JobsPage } from './pages/jobs-page.tsx';
import { LoginPage } from './pages/login-page.tsx';
import { NotFoundPage } from './pages/not-found-page.tsx';
import { PoolPage } from './pages/pool-page.tsx';
import { SetupPage } from './pages/setup-page.tsx';
import { VolumesPage } from './pages/volumes-page.tsx';

function Centered({ children }: { readonly children: ReactElement }): ReactElement {
  return <main className="mx-auto max-w-md px-4 py-16">{children}</main>;
}

export function App(): ReactElement {
  const setup = useSetupStatus();
  const me = useMe(setup.data?.required === false);
  if (setup.isError) {
    return (
      <Centered>
        <ErrorMessage error={setup.error} />
      </Centered>
    );
  }
  if (setup.isPending) {
    return (
      <Centered>
        <Loading what="Open HR" />
      </Centered>
    );
  }
  if (setup.data.required) {
    return <SetupPage />;
  }
  if (me.isError) {
    return (
      <Centered>
        <ErrorMessage error={me.error} />
      </Centered>
    );
  }
  if (me.isPending) {
    return (
      <Centered>
        <Loading what="your session" />
      </Centered>
    );
  }
  if (me.data === null) {
    return <LoginPage />;
  }
  return (
    <Routes>
      <Route element={<Layout username={me.data.username} />}>
        <Route index={true} element={<DashboardPage />} />
        <Route path="drives" element={<DrivesPage />} />
        <Route path="pools/:id" element={<PoolPage />} />
        <Route path="volumes" element={<VolumesPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:id" element={<JobPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
