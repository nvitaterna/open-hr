/**
 * A web server signed in as the admin, talking to a fake ohr-core: a real
 * RpcServer on a temporary socket with the handlers from
 * fake-core-test-helpers.ts.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { EventData, EventName } from '@ohr/rpc/contract';
import { RpcServer } from '@ohr/rpc/server';

import { CoreLink } from './core-link.ts';
import { fakeHandlers, type Received } from './fake-core-test-helpers.ts';
import { LoginLimiter } from './login-limiter.ts';
import { hashPassword } from './passwords.ts';
import { buildWebServer } from './server.ts';
import { WebStore } from './web-store.ts';

const HOST = 'nas.example:7700';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery';
const AT = '2026-10-29T12:00:00.000Z';
const KEEPALIVE_MS = 40;
const RETRY_MS = 20;

async function signIn(app: FastifyInstance, store: WebStore): Promise<string> {
  store.createAdmin({ username: 'nico', passwordHash: await hashPassword(PASSWORD) }, AT);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'nico', password: PASSWORD }),
  });
  const session = login.cookies.find((candidate) => candidate.name === 'ohr_session');
  if (session === undefined) {
    throw new Error(`sign-in failed: ${login.body}`);
  }
  return `ohr_session=${session.value}`;
}

/** Reads a response as text and resolves waitFor() once some text has arrived. */
function textReader(response: IncomingMessage): (expected: string) => Promise<string> {
  let text = '';
  const waiting = new Set<() => void>();
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    text += chunk;
    for (const check of waiting) {
      check();
    }
  });
  return (expected) =>
    new Promise((resolve) => {
      const check = (): void => {
        if (text.includes(expected)) {
          waiting.delete(check);
          resolve(text);
        }
      };
      waiting.add(check);
      check();
    });
}

interface Call {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body: unknown;
  readonly cookie: string;
}

function inject(
  app: FastifyInstance,
  { method, url, body, cookie }: Call,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: HOST, cookie };
  if (method === 'GET') {
    return app.inject({ method, url, headers });
  }
  return app.inject({
    method,
    url,
    headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
    payload: JSON.stringify(body ?? {}),
  });
}

async function openEventStream(app: FastifyInstance, cookie: string): Promise<Stream> {
  if (!app.server.listening) {
    await app.listen({ port: 0, host: '127.0.0.1' });
  }
  const { port } = app.server.address() as AddressInfo;
  const headers = { host: HOST, cookie };
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get({ port, path: '/api/v1/events', headers }, resolve).on('error', reject);
  });
  return { response, waitFor: textReader(response) };
}

/** An open event stream, read as text. */
export interface Stream {
  readonly response: IncomingMessage;
  /** Resolves with everything received once it contains `expected`. */
  readonly waitFor: (expected: string) => Promise<string>;
}

export interface Harness {
  readonly core: CoreLink;
  /** What the fake core was asked, oldest first. */
  readonly received: Received[];
  /** The session cookie. Set it to '' to act signed out. */
  cookie: string;
  /** A request as the browser sends it: changes are JSON from this server's origin. */
  call: (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<LightMyRequestResponse>;
  /** Listens on a free port, if not yet, and opens GET /api/v1/events. */
  openStream: () => Promise<Stream>;
  /** Resolves once core has handled the subscription, so published events reach streams. */
  untilSubscribed: () => Promise<void>;
  publish: <E extends EventName>(event: E, data: EventData<E>) => void;
  /** Number of connections the fake core has. */
  coreConnections: () => number;
  stopCore: () => Promise<void>;
  startCore: () => Promise<void>;
  closeServer: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'ohr-web-api-'));
  const socketPath = join(directory, 'core.sock');
  const received: Received[] = [];
  const listen = (): Promise<RpcServer> =>
    RpcServer.listen(socketPath, { handlers: fakeHandlers(received), log: () => undefined });
  let fakeCore: RpcServer | null = await listen();
  const core = new CoreLink({ socketPath, retryMs: RETRY_MS });
  const store = WebStore.open(':memory:');
  const app = await buildWebServer({
    store,
    limiter: new LoginLimiter(),
    core,
    setupTokenPath: join(directory, 'setup-token'),
    secureCookies: false,
    tls: null,
    keepaliveMs: KEEPALIVE_MS,
  });
  const stopCore = async (): Promise<void> => {
    await fakeCore?.close();
    fakeCore = null;
  };
  const harness: Harness = {
    core,
    received,
    cookie: await signIn(app, store),
    call: (method, url, body) => inject(app, { method, url, body, cookie: harness.cookie }),
    openStream: () => openEventStream(app, harness.cookie),
    untilSubscribed: async () => {
      // The stream subscribed before it answered; a call on the same connection is handled after.
      await core.call('jobs.list', {});
    },
    publish: (event, data) => fakeCore?.publish(event, data),
    coreConnections: () => fakeCore?.connectionCount ?? 0,
    stopCore,
    startCore: async () => {
      fakeCore = await listen();
    },
    closeServer: () => app.close(),
    close: async () => {
      await app.close();
      await core.close();
      await stopCore();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return harness;
}
