import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DRIVE, POOL, renderApp, signedInRoutes } from './ui-test-helpers.tsx';

const PASSWORD = 'correct horse battery';
const NO_POOLS = /No pools yet/u;

describe('setup', () => {
  it('creates the admin with the token and goes to the dashboard', async () => {
    let done = false;
    const routes = signedInRoutes({
      'GET /setup': () => ({ body: { required: !done } }),
      'POST /setup': () => {
        done = true;
        return { status: 201, body: { username: 'nico' } };
      },
    });
    const { api } = renderApp(routes);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Setup token'), ' abc123 ');
    await user.type(screen.getByLabelText('Username'), 'nico');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeDefined();
    expect(api.calls.find((call) => call.key === 'POST /setup')?.body).toEqual({
      token: 'abc123',
      username: 'nico',
      password: PASSWORD,
    });
  });

  it('stops when the passwords differ', async () => {
    const { api } = renderApp(signedInRoutes({ 'GET /setup': { body: { required: true } } }));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Setup token'), 'abc123');
    await user.type(screen.getByLabelText('Username'), 'nico');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), `${PASSWORD}!`);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('alert').textContent).toBe('The passwords do not match.');
    expect(api.calls.some((call) => call.key === 'POST /setup')).toBe(false);
  });
});

describe('signing in', () => {
  it('shows the sign-in page without a session, and the API message on failure', async () => {
    renderApp(
      signedInRoutes({
        'GET /auth/me': {
          status: 401,
          body: { error: 'not-signed-in', message: 'Sign in first.' },
        },
        'POST /auth/login': {
          status: 401,
          body: { error: 'invalid-credentials', message: 'The username or password is wrong.' },
        },
      }),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'nico');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The username or password is wrong.',
    );
  });

  it('goes back to sign-in when a page finds the session gone', async () => {
    renderApp(
      signedInRoutes({
        'GET /pools': { status: 401, body: { error: 'not-signed-in', message: 'Sign in first.' } },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeDefined();
  });
});

describe('dashboard', () => {
  it('shows each pool with health, capacity, volumes, and warnings', async () => {
    renderApp(signedInRoutes({ 'GET /pools': { body: { pools: [POOL] } } }));
    const pool = (await screen.findByRole('heading', { name: 'tank' })).parentElement;
    if (pool === null) {
      throw new Error('no pool card');
    }
    expect(within(pool).getByText('degraded')).toBeDefined();
    const card = pool.parentElement as HTMLElement;
    expect(card.querySelector('meter')?.getAttribute('value')).toBe('75');
    expect(within(card).getByText('6.00 TB of 8.00 TB given to volumes')).toBeDefined();
    expect(within(card).getByText('media')).toBeDefined();
    expect(within(card).getByText(POOL.warnings[0] ?? '')).toBeDefined();
  });

  it('says how to make a pool when there is none, and passes core errors on', async () => {
    renderApp(
      signedInRoutes({
        'GET /jobs': {
          status: 503,
          body: { error: 'core-unavailable', message: 'ohr-core is not running.' },
        },
      }),
    );
    expect(await screen.findByText(NO_POOLS)).toBeDefined();
    expect((await screen.findByRole('alert')).textContent).toBe('ohr-core is not running.');
  });
});

describe('drives', () => {
  it('lists every drive and reads SMART on request', async () => {
    const smartDrive = {
      device: {
        name: 'sda',
        path: '/dev/sda',
        sizeBytes: DRIVE.sizeBytes,
        model: DRIVE.model,
        serial: DRIVE.serial,
        wwn: null,
        transport: 'sata',
        rotational: true,
        children: [],
      },
      role: 'ohr',
      smart: { passed: true, temperatureCelsius: 34 },
    };
    const { api } = renderApp(
      signedInRoutes({
        'GET /drives': { body: { drives: [DRIVE] } },
        'GET /system?smart=true': {
          body: { snapshot: { drives: [smartDrive] }, readAt: '2026-10-29T12:00:00.000Z' },
        },
      }),
      '/drives',
    );
    const row = (await screen.findByRole('rowheader', { name: '/dev/sda' })).closest('tr');
    expect(row?.textContent).toContain('WDC WD40EFRX');
    expect(row?.textContent).toContain('4.00 TB');
    expect(row?.textContent).toContain('Pool member (tank)');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read SMART data' }));
    expect(await screen.findByText('Passed')).toBeDefined();
    expect(screen.getByText('34 °C')).toBeDefined();
    expect(api.calls.map((call) => call.key)).toContain('GET /system?smart=true');
  });
});
