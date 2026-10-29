import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoreLink } from './core-link.ts';
import { LoginLimiter } from './login-limiter.ts';
import { buildWebServer } from './server.ts';
import { writeSetupToken } from './setup-token.ts';
import { WebStore } from './web-store.ts';

const HOST = 'nas.example:7700';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery';
const DAY_MS = 86_400_000;
const ARGON2_HASH = /^\$argon2id\$/u;

let directory: string;
let tokenPath: string;
let token: string;
let store: WebStore;
let app: FastifyInstance;
let clock: Date;
let core: CoreLink;

interface Call {
  readonly method?: 'GET' | 'POST';
  readonly url: string;
  readonly body?: unknown;
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
}

function call({
  method = 'GET',
  url,
  body,
  cookie,
  headers = {},
}: Call): Promise<LightMyRequestResponse> {
  const base: Record<string, string> = { host: HOST };
  if (method === 'POST') {
    base['content-type'] = 'application/json';
    base.origin = ORIGIN;
  }
  if (cookie !== undefined) {
    base.cookie = cookie;
  }
  if (method === 'GET') {
    return app.inject({ method, url, headers: { ...base, ...headers } });
  }
  return app.inject({
    method,
    url,
    headers: { ...base, ...headers },
    payload: JSON.stringify(body ?? {}),
  });
}

/** The session cookie a response set, as a Cookie header value. */
function sessionCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((candidate) => candidate.name === 'ohr_session');
  if (cookie === undefined) {
    throw new Error('no session cookie');
  }
  return `ohr_session=${cookie.value}`;
}

async function setUp(): Promise<string> {
  const response = await call({
    method: 'POST',
    url: '/api/v1/setup',
    body: { token, username: 'nico', password: PASSWORD },
  });
  if (response.statusCode !== 201) {
    throw new Error(`setup failed: ${response.body}`);
  }
  return sessionCookie(response);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-web-'));
  tokenPath = join(directory, 'setup-token');
  token = await writeSetupToken(tokenPath);
  store = WebStore.open(':memory:');
  clock = new Date('2026-10-29T12:00:00.000Z');
  // Nothing listens there: these tests never reach core.
  core = new CoreLink({ socketPath: join(directory, 'core.sock') });
  app = await buildWebServer({
    store,
    core,
    limiter: new LoginLimiter(() => clock.getTime()),
    setupTokenPath: tokenPath,
    secureCookies: true,
    tls: null,
    now: () => clock,
  });
});

afterEach(async () => {
  await app.close();
  await core.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
});

describe('setup', () => {
  it('asks for setup and refuses everything else until the admin exists', async () => {
    expect((await call({ url: '/api/v1/setup' })).json()).toEqual({ required: true });
    const me = await call({ url: '/api/v1/auth/me' });
    expect(me.statusCode).toBe(409);
    expect(me.json()).toEqual({
      error: 'setup-required',
      message: 'Create the admin account first.',
    });
  });

  it('creates the admin with the token, signs them in, and removes the token', async () => {
    const cookie = await setUp();
    expect((await call({ url: '/api/v1/setup' })).json()).toEqual({ required: false });
    expect((await call({ url: '/api/v1/auth/me', cookie })).json()).toEqual({ username: 'nico' });
    expect(store.admin()?.passwordHash).toMatch(ARGON2_HASH);
    const again = await call({
      method: 'POST',
      url: '/api/v1/setup',
      body: { token, username: 'eve', password: PASSWORD },
    });
    expect(again.statusCode).toBe(409);
  });

  it('sets a strict, HTTP-only, secure session cookie', async () => {
    const response = await call({
      method: 'POST',
      url: '/api/v1/setup',
      body: { token, username: 'nico', password: PASSWORD },
    });
    expect(response.cookies).toEqual([
      expect.objectContaining({
        name: 'ohr_session',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/',
      }),
    ]);
  });

  it('refuses a wrong token, a short password, and a bad username', async () => {
    const wrong = await call({
      method: 'POST',
      url: '/api/v1/setup',
      body: { token: 'guess', username: 'nico', password: PASSWORD },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: 'invalid-token' });
    const short = await call({
      method: 'POST',
      url: '/api/v1/setup',
      body: { token, username: 'nico', password: 'short' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ error: 'invalid-request' });
    const name = await call({
      method: 'POST',
      url: '/api/v1/setup',
      body: { token, username: 'Nico Admin', password: PASSWORD },
    });
    expect(name.statusCode).toBe(400);
    expect(store.admin()).toBeNull();
  });
});

describe('sign in and out', () => {
  it('signs in with the right password and out again', async () => {
    await setUp();
    const login = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { username: 'nico', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = sessionCookie(login);
    expect((await call({ url: '/api/v1/auth/me', cookie })).statusCode).toBe(200);
    const logout = await call({ method: 'POST', url: '/api/v1/auth/logout', cookie });
    expect(logout.statusCode).toBe(204);
    expect((await call({ url: '/api/v1/auth/me', cookie })).statusCode).toBe(401);
  });

  it('gives the same answer for a wrong username and a wrong password', async () => {
    await setUp();
    const user = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { username: 'eve', password: PASSWORD },
    });
    const password = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { username: 'nico', password: 'wrong password!' },
    });
    expect(user.statusCode).toBe(401);
    expect(user.json()).toEqual(password.json());
  });

  it('makes an address wait after 5 failures', async () => {
    await setUp();
    const attempt = (): Promise<LightMyRequestResponse> =>
      call({
        method: 'POST',
        url: '/api/v1/auth/login',
        body: { username: 'nico', password: 'wrong password!' },
      });
    const failures = await Promise.all(Array.from({ length: 5 }, attempt));
    expect(failures.map((response) => response.statusCode)).toEqual([401, 401, 401, 401, 401]);
    const blocked = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { username: 'nico', password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('ends a session after a week without use', async () => {
    const cookie = await setUp();
    clock = new Date(clock.getTime() + 6 * DAY_MS);
    expect((await call({ url: '/api/v1/auth/me', cookie })).statusCode).toBe(200);
    clock = new Date(clock.getTime() + 8 * DAY_MS);
    expect((await call({ url: '/api/v1/auth/me', cookie })).statusCode).toBe(401);
  });

  it('refuses a made-up session', async () => {
    await setUp();
    const response = await call({ url: '/api/v1/auth/me', cookie: 'ohr_session=forged' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'not-signed-in' });
  });
});

describe('request safety', () => {
  it('refuses a change from another origin, or with no origin', async () => {
    await setUp();
    const refused = await Promise.all(
      ['https://evil.example', 'null'].map((origin) =>
        call({
          method: 'POST',
          url: '/api/v1/auth/login',
          body: { username: 'nico', password: PASSWORD },
          headers: { origin },
        }),
      ),
    );
    for (const response of refused) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'cross-origin' });
    }
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'nico', password: PASSWORD }),
    });
    expect(missing.statusCode).toBe(403);
  });

  it('refuses a change that is not JSON, as an HTML form would send', async () => {
    await setUp();
    const response = await call({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: 'json-required' });
  });

  it('hides unknown API paths from strangers and answers JSON 404 to the admin', async () => {
    const cookie = await setUp();
    expect((await call({ url: '/api/v1/nothing' })).statusCode).toBe(401);
    const known = await call({ url: '/api/v1/nothing', cookie });
    expect(known.statusCode).toBe(404);
    expect(known.json()).toMatchObject({ error: 'not-found' });
  });
});
