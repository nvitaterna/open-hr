import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { Result } from '@ohr/rpc/contract';
import type { JobRecord } from '@ohr/shared/jobs';
import type { DriveView } from '@ohr/shared/pool-view';

import { AT, DRIVE, POOL, renderApp, signedInRoutes } from './ui-test-helpers.tsx';

const GB = 1_000_000_000;
const JOB_ID = '00000000-0000-4000-8000-000000000009';
const POOL_UUID = '00000000-0000-4000-8000-0000000000bb';
const DRIVE_UUID = '00000000-0000-4000-8000-0000000000cc';
const SDA = /^\/dev\/sda/u;
const SDB = /^\/dev\/sdb/u;
const SDC = /^\/dev\/sdc/u;
const SDD = /^\/dev\/sdd/u;
const TYPE_POOL = /Type the pool name/u;
const ERASE_THEM = /Erase them/u;
const TYPE_VOLUME = /Type the volume name/u;
const ERASE = /This erases everything on \/dev\/sdb, \/dev\/sdc/u;

function drive(name: string, role: DriveView['role'], sizeBytes: number): DriveView {
  return { ...DRIVE, path: `/dev/${name}`, name, role, poolId: null, sizeBytes, serial: name };
}

const DRIVES = [
  drive('sda', 'system', 32 * GB),
  drive('sdb', 'empty', 4 * GB),
  drive('sdc', 'empty', 4 * GB),
  drive('sdd', 'in-use', 8 * GB),
];

const JOB: JobRecord = {
  id: JOB_ID,
  kind: 'pool-create',
  poolId: 'p2',
  status: 'running',
  input: {},
  stateHash: 'h1',
  createdAt: AT,
  startedAt: AT,
  finishedAt: null,
  error: null,
  steps: [],
};

function planned(
  device: string,
): Result<'pools.previewCreate'>['input']['layout']['drives'][number] {
  return {
    id: device,
    sizeBytes: 4 * GB,
    unusedBytes: 0,
    partitions: [
      { number: 1, role: 'label', tier: null, startBytes: 1_048_576, sizeBytes: 1_048_576 },
      { number: 2, role: 'tier', tier: 1, startBytes: 2_097_152, sizeBytes: 3 * GB },
    ],
  };
}

const POOL_PREVIEW: Result<'pools.previewCreate'> = {
  input: {
    poolId: 'p2',
    poolUuid: POOL_UUID,
    redundancy: 'shr1',
    wipe: false,
    drives: ['/dev/sdb', '/dev/sdc'].map((path) => ({
      path,
      serial: null,
      wwn: null,
      sizeBytes: 4 * GB,
      driveUuid: DRIVE_UUID,
    })),
    layout: {
      redundancy: 'shr1',
      drives: [planned('/dev/sdb'), planned('/dev/sdc')],
      tiers: [
        {
          tier: 1,
          partitionNumber: 2,
          level: 'raid1',
          members: ['/dev/sdb', '/dev/sdc'],
          sliceBytes: 3 * GB,
          arrayBytes: 3 * GB,
          usableBytes: 3 * GB,
        },
      ],
      rawBytes: 8 * GB,
      usableBytes: 3 * GB,
    },
  },
  steps: [
    {
      name: 'partition /dev/sdb',
      description: 'Write the partition table.',
      commands: ['sgdisk --clear /dev/sdb'],
    },
  ],
  stateHash: 'h1',
};

function poolRoutes(extra = {}): ReturnType<typeof signedInRoutes> {
  return signedInRoutes({
    'GET /drives': { body: { drives: DRIVES } },
    'POST /pools/preview': { body: POOL_PREVIEW },
    'POST /pools': { status: 202, body: { job: JOB } },
    [`GET /jobs/${JOB_ID}`]: { body: { job: JOB, log: [] } },
    ...extra,
  });
}

async function choosePool(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('Pool name'), 'p2');
  await user.click(screen.getByLabelText(SDB));
  await user.click(screen.getByLabelText(SDC));
  await user.click(screen.getByRole('button', { name: 'Preview' }));
}

describe('create pool', () => {
  it('previews the plan, then creates the pool once its name is typed', async () => {
    const { api } = renderApp(poolRoutes(), '/pools/new');
    const user = userEvent.setup();
    expect((await screen.findByLabelText(SDA)).hasAttribute('disabled')).toBe(true);
    await choosePool(user);
    expect(await screen.findByText(ERASE)).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/preview')?.body).toEqual({
      poolId: 'p2',
      redundancy: 'shr1',
      devices: ['/dev/sdb', '/dev/sdc'],
      wipe: false,
    });
    expect(screen.getByText('sgdisk --clear /dev/sdb')).toBeDefined();
    expect(screen.getByRole('img', { name: 'Planned pool p2: 2 drives, 1 tiers' })).toBeDefined();
    const create = screen.getByRole('button', { name: 'Create pool' });
    expect(create.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText(TYPE_POOL), 'p2');
    await user.click(create);
    expect(await screen.findByRole('heading', { name: 'Create pool on p2' })).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools')?.body).toEqual({
      input: POOL_PREVIEW.input,
      stateHash: 'h1',
    });
  });

  it('asks to wipe only when a chosen drive holds something, and shows refusals', async () => {
    renderApp(
      poolRoutes({
        'POST /pools/preview': {
          status: 422,
          body: {
            error: 'rejected',
            message: 'Open HR refused the request.',
            reasons: ['/dev/sdd is not empty (partitions). It has to be wiped first.'],
          },
        },
      }),
      '/pools/new',
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Pool name'), 'p2');
    await user.click(screen.getByLabelText(SDB));
    expect(screen.queryByText(ERASE_THEM)).toBeNull();
    await user.click(screen.getByLabelText(SDD));
    expect(screen.getByText(ERASE_THEM)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      '/dev/sdd is not empty (partitions). It has to be wiped first.',
    );
  });
});

describe('create pool when things change', () => {
  it('keeps the choices when going back, and previews again after the drives changed', async () => {
    const { api } = renderApp(
      poolRoutes({
        'POST /pools': {
          status: 409,
          body: { error: 'state-changed', message: 'The machine changed. Preview again.' },
        },
      }),
      '/pools/new',
    );
    const user = userEvent.setup();
    await choosePool(user);
    await user.type(await screen.findByLabelText(TYPE_POOL), 'p2');
    await user.click(screen.getByRole('button', { name: 'Create pool' }));
    await user.click(await screen.findByRole('button', { name: 'Preview again' }));
    await expect
      .poll(() => api.calls.filter((call) => call.key === 'POST /pools/preview').length)
      .toBe(2);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect((await screen.findByLabelText('Pool name')).getAttribute('value')).toBe('p2');
    expect((screen.getByLabelText(SDC) as HTMLInputElement).checked).toBe(true);
  });
});

const VOLUME_PREVIEW: Result<'volumes.previewCreate'> = {
  input: {
    poolId: 'tank',
    name: 'photos',
    filesystem: 'btrfs',
    size: { kind: 'bytes', bytes: 500 * GB },
    mountPoint: '/mnt/ohr/photos',
  },
  sizeBytes: 500 * GB,
  steps: [
    {
      name: 'create the logical volume',
      description: 'Make the volume.',
      commands: ['lvcreate --name photos ohr-tank'],
    },
  ],
  stateHash: 'h2',
};

describe('create volume', () => {
  it('previews the volume, then creates it once its name is typed', async () => {
    const { api } = renderApp(
      signedInRoutes({
        'GET /pools/tank': { body: { pool: POOL } },
        'POST /pools/tank/volumes/preview': { body: VOLUME_PREVIEW },
        'POST /pools/tank/volumes': {
          status: 202,
          body: { job: { ...JOB, kind: 'volume-create', poolId: 'tank' } },
        },
        [`GET /jobs/${JOB_ID}`]: {
          body: { job: { ...JOB, kind: 'volume-create', poolId: 'tank' }, log: [] },
        },
      }),
      '/pools/tank/volumes/new',
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Volume name'), 'photos');
    await user.type(screen.getByLabelText('Size'), '500 GB');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('lvcreate --name photos ohr-tank')).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/volumes/preview')?.body).toEqual(
      {
        name: 'photos',
        filesystem: 'btrfs',
        size: { kind: 'bytes', bytes: 500 * GB },
      },
    );
    await user.type(screen.getByLabelText(TYPE_VOLUME), 'photos');
    await user.click(screen.getByRole('button', { name: 'Create volume' }));
    expect(await screen.findByRole('heading', { name: 'Create volume on tank' })).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/volumes')?.body).toEqual({
      input: VOLUME_PREVIEW.input,
      stateHash: 'h2',
    });
  });

  it('says what is wrong with a size it cannot read, without asking core', async () => {
    const { api } = renderApp(
      signedInRoutes({ 'GET /pools/tank': { body: { pool: POOL } } }),
      '/pools/tank/volumes/new',
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Volume name'), 'photos');
    await user.type(screen.getByLabelText('Size'), 'lots');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(api.calls.some((call) => call.key.includes('/volumes/preview'))).toBe(false);
  });
});
