import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  EXPAND_PREVIEW,
  GB,
  GROW_PREVIEW,
  JOB_ID,
  REPLACE_PREVIEW,
  tankJob,
  tankRoutes,
} from './expansion-test-helpers.ts';
import { renderApp } from './ui-test-helpers.tsx';

const REPLACE_SDA = `/pools/tank/replace?drive=${encodeURIComponent('/dev/sda')}`;
const SDA = /^\/dev\/sda/u;
const SDB = /^\/dev\/sdb/u;
const SDD = /^\/dev\/sdd/u;
const TYPE_POOL = /Type the pool name/u;
const TYPE_VOLUME = /Type the volume name/u;
const ERASE_THEM = /Erase them/u;
const ERASE_SDB = /This erases everything on \/dev\/sdb/u;
const RESHAPING = /Reshaping keeps the pool/u;
const THEN_GROWS = /Volume media then grows into all the new space/u;
const COPIED_LIVE = /Tier 1: copied while the old drive keeps working/u;
const NOT_ERASED = /\/dev\/sda is not erased/u;
const ALL_FREE = /all the pool's free space/u;

describe('pool page actions', () => {
  it('links every expansion wizard', async () => {
    renderApp(tankRoutes(), '/pools/tank');
    expect((await screen.findByRole('link', { name: 'Add drives' })).getAttribute('href')).toBe(
      '/pools/tank/add-drives',
    );
    expect(screen.getByRole('link', { name: 'Use free space' }).getAttribute('href')).toBe(
      '/pools/tank/expand',
    );
    expect(
      screen.getByRole('link', { name: 'Replace the missing drive' }).getAttribute('href'),
    ).toBe('/pools/tank/replace');
    expect(screen.getByRole('link', { name: 'Replace /dev/sda' }).getAttribute('href')).toBe(
      REPLACE_SDA,
    );
    expect(screen.queryByRole('link', { name: 'Replace /dev/sde' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Grow media' }).getAttribute('href')).toBe(
      '/pools/tank/volumes/media/grow',
    );
  });
});

describe('add drives', () => {
  it('previews the new layout, then grows the pool once its name is typed', async () => {
    const { api } = renderApp(
      tankRoutes({
        'POST /pools/tank/expand/preview': { body: EXPAND_PREVIEW },
        'POST /pools/tank/expand': { status: 202, body: { job: tankJob('pool-expand') } },
        [`GET /jobs/${JOB_ID}`]: { body: { job: tankJob('pool-expand'), log: [] } },
      }),
      '/pools/tank/add-drives',
    );
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(SDB));
    expect(screen.queryByLabelText(SDA)).toBeNull();
    await user.selectOptions(screen.getByLabelText('Then grow a volume'), 'media');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(ERASE_SDB)).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/expand/preview')?.body).toEqual({
      devices: ['/dev/sdb'],
      wipe: false,
      growVolume: 'media',
    });
    expect(screen.getByText(RESHAPING)).toBeDefined();
    expect(screen.getByText(THEN_GROWS)).toBeDefined();
    expect(screen.getByText('mdadm --grow /dev/md/ohr_tank_t1 --raid-devices=3')).toBeDefined();
    expect(screen.getByRole('img', { name: 'Pool tank after: 2 drives, 1 tiers' })).toBeDefined();
    await user.type(screen.getByLabelText(TYPE_POOL), 'tank');
    await user.click(screen.getByRole('button', { name: 'Add drives' }));
    expect(await screen.findByRole('heading', { name: 'Grow pool on tank' })).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/expand')?.body).toEqual({
      input: EXPAND_PREVIEW.input,
      stateHash: 'h3',
    });
  });

  it('asks to wipe a drive that holds something, and keeps the choices when going back', async () => {
    const { api } = renderApp(
      tankRoutes({ 'POST /pools/tank/expand/preview': { body: EXPAND_PREVIEW } }),
      '/pools/tank/add-drives',
    );
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(SDD));
    await user.click(screen.getByLabelText(ERASE_THEM));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(((await screen.findByLabelText(SDD)) as HTMLInputElement).checked).toBe(true);
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/expand/preview')?.body).toEqual({
      devices: ['/dev/sdd'],
      wipe: true,
    });
  });
});

describe('use free space', () => {
  it('previews without drives, and previews again after the pool changed', async () => {
    const preview = { ...EXPAND_PREVIEW, input: { ...EXPAND_PREVIEW.input, newDrives: [] } };
    const { api } = renderApp(
      tankRoutes({
        'POST /pools/tank/expand/preview': { body: preview },
        'POST /pools/tank/expand': {
          status: 409,
          body: { error: 'state-changed', message: 'The machine changed. Preview again.' },
        },
      }),
      '/pools/tank/expand',
    );
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Use free space in tank' })).toBeDefined();
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(RESHAPING)).toBeDefined();
    expect(screen.queryByText(ERASE_SDB)).toBeNull();
    await user.type(screen.getByLabelText(TYPE_POOL), 'tank');
    await user.click(screen.getByRole('button', { name: 'Use free space' }));
    await user.click(await screen.findByRole('button', { name: 'Preview again' }));
    const previews = (): unknown[] =>
      api.calls
        .filter((call) => call.key === 'POST /pools/tank/expand/preview')
        .map((call) => call.body);
    await expect.poll(() => previews().length).toBe(2);
    expect(previews()).toEqual([
      { devices: [], wipe: false },
      { devices: [], wipe: false },
    ]);
  });
});

describe('replace drive', () => {
  it('previews how each tier moves, then replaces the drive once the pool name is typed', async () => {
    const { api } = renderApp(
      tankRoutes({
        'POST /pools/tank/replace/preview': { body: REPLACE_PREVIEW },
        'POST /pools/tank/replace': { status: 202, body: { job: tankJob('drive-replace') } },
        [`GET /jobs/${JOB_ID}`]: { body: { job: tankJob('drive-replace'), log: [] } },
      }),
      REPLACE_SDA,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(SDB));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(COPIED_LIVE)).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/replace/preview')?.body).toEqual(
      { oldDrive: '/dev/sda', newDrive: '/dev/sdb', wipe: false },
    );
    expect(screen.getByText(NOT_ERASED)).toBeDefined();
    expect(screen.getByText(ERASE_SDB)).toBeDefined();
    await user.type(screen.getByLabelText(TYPE_POOL), 'tank');
    await user.click(screen.getByRole('button', { name: 'Replace drive' }));
    expect(await screen.findByRole('heading', { name: 'Replace drive on tank' })).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/replace')?.body).toEqual({
      input: REPLACE_PREVIEW.input,
      stateHash: 'h4',
    });
  });

  it('replaces the missing drive without a path, and shows refusals', async () => {
    const { api } = renderApp(
      tankRoutes({
        'POST /pools/tank/replace/preview': {
          status: 422,
          body: {
            error: 'rejected',
            message: 'The drive cannot be replaced.',
            reasons: ['/dev/sdb is smaller than the tiers it would hold.'],
          },
        },
      }),
      '/pools/tank/replace',
    );
    const user = userEvent.setup();
    expect(await screen.findByText('the missing drive')).toBeDefined();
    await user.click(await screen.findByLabelText(SDB));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('/dev/sdb is smaller than the tiers it would hold.'),
    ).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /pools/tank/replace/preview')?.body).toEqual(
      { oldDrive: null, newDrive: '/dev/sdb', wipe: false },
    );
  });
});

describe('grow volume', () => {
  it('previews the new size, then grows the volume once its name is typed', async () => {
    const { api } = renderApp(
      tankRoutes({
        'POST /pools/tank/volumes/media/grow/preview': { body: GROW_PREVIEW },
        'POST /pools/tank/volumes/media/grow': {
          status: 202,
          body: { job: tankJob('volume-grow') },
        },
        [`GET /jobs/${JOB_ID}`]: { body: { job: tankJob('volume-grow'), log: [] } },
      }),
      '/pools/tank/volumes/media/grow',
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(ALL_FREE)).toBeDefined();
    expect(screen.getByText('lvextend --resizefs -l +100%FREE ohr-tank/media')).toBeDefined();
    await user.type(screen.getByLabelText(TYPE_VOLUME), 'media');
    await user.click(screen.getByRole('button', { name: 'Grow volume' }));
    expect(await screen.findByRole('heading', { name: 'Grow volume on tank' })).toBeDefined();
    expect(
      api.calls.find((call) => call.key === 'POST /pools/tank/volumes/media/grow')?.body,
    ).toEqual({ input: GROW_PREVIEW.input, stateHash: 'h5' });
  });

  it('asks for a given amount, and says what is wrong with one it cannot read', async () => {
    const { api } = renderApp(
      tankRoutes({ 'POST /pools/tank/volumes/media/grow/preview': { body: GROW_PREVIEW } }),
      '/pools/tank/volumes/media/grow',
    );
    const user = userEvent.setup();
    const amount = await screen.findByLabelText('How much to add');
    await user.type(amount, 'lots');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(api.calls.some((call) => call.key.includes('/grow/preview'))).toBe(false);
    await user.clear(amount);
    await user.type(amount, '100 GB');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText(ALL_FREE);
    expect(
      api.calls.find((call) => call.key === 'POST /pools/tank/volumes/media/grow/preview')?.body,
    ).toEqual({ size: { kind: 'add-bytes', bytes: 100 * GB } });
  });
});
