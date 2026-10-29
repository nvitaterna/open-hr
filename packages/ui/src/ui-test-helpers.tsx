/**
 * Renders the app against a stubbed API. Routes map "GET /pools" style keys
 * to a status and body, or to a function of the request body. Anything not
 * listed answers 404, so a test sees exactly which calls it expects.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';

import type { DriveView, PoolView } from '@ohr/shared/pool-view';

import { App } from './app.tsx';
import { createQueryClient } from './query-client.ts';

const API_PREFIX = '/api/v1';
const OK = 200;
const NOT_FOUND = 404;

function respond(answer: Answer): Response {
  const status = answer.status ?? OK;
  return new Response(JSON.stringify(answer.body ?? {}), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(routes: Routes): StubbedApi {
  const api: StubbedApi = { calls: [], routes };
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.slice(API_PREFIX.length)}`;
    let body: unknown;
    if (typeof init.body === 'string') {
      body = JSON.parse(init.body);
    }
    api.calls.push({ key, body });
    const route = api.routes[key];
    if (route === undefined) {
      return Promise.resolve(
        respond({ status: NOT_FOUND, body: { error: 'not-found', message: `No stub for ${key}` } }),
      );
    }
    if (typeof route === 'function') {
      return Promise.resolve(respond(route(body)));
    }
    return Promise.resolve(respond(route));
  });
  return api;
}

/** The event streams the app opened, newest last. */
const openStreams: FakeEventSource[] = [];

/** An EventSource that never connects; tests send it events with emit(). jsdom has none. */
class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  readyState = 0;
  constructor() {
    super();
    openStreams.push(this);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

export interface Answer {
  readonly status?: number;
  readonly body?: unknown;
}

export type Routes = Record<string, Answer | ((body: unknown) => Answer)>;

export interface StubbedApi {
  /** Every call made, as "METHOD /path" with its JSON body. */
  readonly calls: { key: string; body: unknown }[];
  readonly routes: Routes;
}

export const AT = '2026-10-29T12:00:00.000Z';

/** Routes for a signed-in admin with an empty machine; tests override what they need. */
export function signedInRoutes(overrides: Routes = {}): Routes {
  return {
    'GET /setup': { body: { required: false } },
    'GET /auth/me': { body: { username: 'nico' } },
    'GET /pools': { body: { pools: [] } },
    'GET /drives': { body: { drives: [] } },
    'GET /jobs': { body: { jobs: [] } },
    'GET /system': { body: { snapshot: { warnings: [] }, readAt: AT, stateHash: 'h' } },
    ...overrides,
  };
}

export const DRIVE: DriveView = {
  path: '/dev/sda',
  name: 'sda',
  model: 'WDC WD40EFRX',
  serial: 'WD-1234',
  wwn: null,
  sizeBytes: 4_000_787_030_016,
  transport: 'sata',
  rotational: true,
  role: 'ohr',
  poolId: 'tank',
  temperatureCelsius: null,
  smartPassed: null,
};

export const POOL: PoolView = {
  id: 'tank',
  uuid: '00000000-0000-4000-8000-0000000000aa',
  redundancy: 'shr1',
  health: 'degraded',
  sizeBytes: 8_000_000_000_000,
  freeBytes: 2_000_000_000_000,
  drives: [],
  tiers: [],
  volumes: [
    {
      name: 'media',
      path: '/dev/ohr-tank/media',
      sizeBytes: 6_000_000_000_000,
      filesystem: 'btrfs',
      mountPoint: '/mnt/ohr/media',
      usedBytes: 1_000_000_000_000,
      availableBytes: 5_000_000_000_000,
    },
  ],
  warnings: ['Drive /dev/sdc is missing from tier 1.'],
};

/** Renders the app at `path` with the API stubbed by `routes`. */
export function renderApp(routes: Routes, path = '/'): { api: StubbedApi; view: RenderResult } {
  const api = stubFetch(routes);
  openStreams.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { api, view };
}

/** Sends an event, as ohr-web would, to the stream the app opened. */
export function emit(event: string, data: unknown): void {
  const stream = openStreams.at(-1);
  if (stream === undefined) {
    throw new Error('The app has not opened an event stream.');
  }
  stream.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
}
