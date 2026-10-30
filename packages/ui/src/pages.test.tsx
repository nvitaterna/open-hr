import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { JobRecord, LogLine } from '@ohr/shared/jobs';
import type { PoolView } from '@ohr/shared/pool-view';

import { AT, emit, POOL, renderApp, signedInRoutes } from './ui-test-helpers.tsx';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const TB = 1_000_000_000_000;
const RETRY_FROM = /from step 2, make the filesystem/u;

const LAID_OUT: PoolView = {
  ...POOL,
  drives: [
    {
      path: '/dev/sda',
      model: 'A',
      serial: 'S1',
      sizeBytes: 4 * TB,
      driveUuid: null,
      label: 'ok',
      membership: 'member',
    },
    {
      path: '/dev/sdb',
      model: 'B',
      serial: 'S2',
      sizeBytes: 4 * TB,
      driveUuid: null,
      label: 'ok',
      membership: 'member',
    },
  ],
  tiers: [
    {
      tier: 1,
      arrayPath: '/dev/md/ohr_tank_t1',
      kernelName: 'md127',
      level: 'raid1',
      sizeBytes: 4 * TB,
      expectedMembers: 2,
      health: 'rebuilding',
      sync: {
        action: 'recovery',
        state: 'running',
        percent: 42.5,
        finishMinutes: 90,
        speedKibPerSecond: 100_000,
      },
      members: [
        { drive: '/dev/sda', partition: '/dev/sda2', state: 'active' },
        { drive: '/dev/sdb', partition: '/dev/sdb2', state: 'rebuilding' },
      ],
    },
  ],
};

const FAILED_JOB: JobRecord = {
  id: JOB_ID,
  kind: 'volume-create',
  poolId: 'tank',
  status: 'failed',
  input: {},
  stateHash: 'h',
  createdAt: AT,
  startedAt: AT,
  finishedAt: AT,
  error: 'mkfs.btrfs exited with 1',
  steps: [
    {
      index: 0,
      name: 'create the logical volume',
      description: 'Make the volume in the pool.',
      commands: ['lvcreate -n media ohr-tank'],
      status: 'done',
      startedAt: AT,
      finishedAt: AT,
      error: null,
    },
    {
      index: 1,
      name: 'make the filesystem',
      description: 'Format the volume.',
      commands: ['mkfs.btrfs /dev/ohr-tank/media'],
      status: 'failed',
      startedAt: AT,
      finishedAt: AT,
      error: 'mkfs.btrfs exited with 1',
    },
  ],
};

const RUNNING_JOB: JobRecord = {
  ...FAILED_JOB,
  kind: 'pool-expand',
  status: 'running',
  finishedAt: null,
  error: null,
  steps: [
    {
      index: 0,
      name: 'grow tier 1',
      description: 'Add the new member to tier 1.',
      commands: ['mdadm --grow /dev/md/ohr_tank_t1 --raid-devices=3'],
      status: 'done',
      startedAt: AT,
      finishedAt: AT,
      error: null,
    },
    {
      index: 1,
      name: 'wait for tier 1 reshape',
      description: 'Wait until /dev/md/ohr_tank_t1 has finished its reshape',
      commands: [],
      status: 'running',
      startedAt: AT,
      finishedAt: null,
      error: null,
    },
  ],
};

const LOG: LogLine[] = [{ step: 1, at: AT, line: 'ERROR: device is busy' }];

describe('pool page', () => {
  it('draws the tiers on the drives and lists tiers, volumes, and drives', async () => {
    renderApp(signedInRoutes({ 'GET /pools/tank': { body: { pool: LAID_OUT } } }), '/pools/tank');
    expect(await screen.findByRole('heading', { name: 'Pool tank' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Pool tank: 2 drives, 1 tiers' })).toBeDefined();
    expect(screen.getByText('/dev/sdb2: tier 1, rebuilding')).toBeDefined();
    const tierRow = screen.getByRole('rowheader', { name: 'Tier 1' }).closest('tr');
    expect(tierRow?.textContent).toContain('1 of 2 active');
    expect(tierRow?.textContent).toContain('recovery, 42.5%, about 90 min left');
    expect(screen.getByRole('rowheader', { name: 'media' })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: '/dev/sdb' })).toBeDefined();
  });

  it('says so when there is no such pool', async () => {
    renderApp(signedInRoutes(), '/pools/nope');
    expect((await screen.findByRole('alert')).textContent).toBe('There is no pool named nope.');
  });
});

describe('volumes page', () => {
  it('lists every volume with its pool and usage', async () => {
    renderApp(signedInRoutes({ 'GET /pools': { body: { pools: [POOL] } } }), '/volumes');
    const row = (await screen.findByRole('rowheader', { name: 'media' })).closest('tr');
    expect(within(row as HTMLElement).getByRole('link', { name: 'tank' })).toBeDefined();
    expect(row?.textContent).toContain('/mnt/ohr/media');
    expect(row?.textContent).toContain('1.00 TB of 6.00 TB (17%)');
  });
});

describe('job page', () => {
  it('shows each step with its commands and log, and adds live log lines', async () => {
    renderApp(
      signedInRoutes({ [`GET /jobs/${JOB_ID}`]: { body: { job: FAILED_JOB, log: LOG } } }),
      `/jobs/${JOB_ID}`,
    );
    expect(await screen.findByRole('heading', { name: 'Create volume on tank' })).toBeDefined();
    expect(screen.getByText('2. make the filesystem')).toBeDefined();
    expect(screen.getByText('mkfs.btrfs /dev/ohr-tank/media')).toBeDefined();
    expect(screen.getByText('ERROR: device is busy')).toBeDefined();
    emit('job.log', { jobId: JOB_ID, step: 1, line: 'retrying the device' });
    expect(await screen.findByText('retrying the device')).toBeDefined();
  });

  it('draws the running step progress and clears it when the step ends', async () => {
    renderApp(
      signedInRoutes({ [`GET /jobs/${JOB_ID}`]: { body: { job: RUNNING_JOB, log: [] } } }),
      `/jobs/${JOB_ID}`,
    );
    expect(await screen.findByText('2. wait for tier 1 reshape')).toBeDefined();
    emit('job.progress', {
      jobId: JOB_ID,
      step: 1,
      operation: 'reshape',
      fraction: 0.4217,
      etaSeconds: 5400,
    });
    const text = 'reshape, 42.1%, about 1 h 30 min left';
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.getByRole('meter', { name: 'reshape progress' }).getAttribute('value')).toBe(
      '42.1',
    );
    emit('job.step', {
      jobId: JOB_ID,
      index: 1,
      name: 'wait for tier 1 reshape',
      status: 'done',
      error: null,
    });
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
  });

  it('retries a failed job only after a second click', async () => {
    const { api } = renderApp(
      signedInRoutes({
        [`GET /jobs/${JOB_ID}`]: { body: { job: FAILED_JOB, log: [] } },
        [`POST /jobs/${JOB_ID}/retry`]: {
          status: 202,
          body: { job: { ...FAILED_JOB, status: 'running' } },
        },
      }),
      `/jobs/${JOB_ID}`,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(api.calls.some((call) => call.key.endsWith('/retry'))).toBe(false);
    expect(screen.getByText(RETRY_FROM)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Retry from step 2' }));
    await expect.poll(() => api.calls.some((call) => call.key.endsWith('/retry'))).toBe(true);
  });
});

describe('jobs page', () => {
  it('links each job to its page', async () => {
    renderApp(signedInRoutes({ 'GET /jobs': { body: { jobs: [FAILED_JOB] } } }), '/jobs');
    const link = await screen.findByRole('link', { name: 'Create volume on tank' });
    expect(link.getAttribute('href')).toBe(`/jobs/${JOB_ID}`);
  });
});
