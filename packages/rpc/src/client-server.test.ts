import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JobRecord } from '@ohr/shared/jobs';

import { RpcClient } from './client.ts';
import { ConnectionClosedError } from './connection-closed-error.ts';
import type { RpcEvent } from './contract.ts';
import { CoreUnavailableError } from './core-unavailable-error.ts';
import { MAX_LINE_BYTES } from './framing.ts';
import { ProtocolError } from './protocol-error.ts';
import { RpcError } from './rpc-error.ts';
import { type Handlers, RpcServer } from './server.ts';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_JOB_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-10-29T12:00:00.000Z';

const JOB: JobRecord = {
  id: JOB_ID,
  kind: 'pool-create',
  poolId: 'p1',
  status: 'done',
  input: { poolId: 'p1' },
  stateHash: 'abc',
  createdAt: AT,
  startedAt: AT,
  finishedAt: AT,
  error: null,
  steps: [],
};

const EMPTY_SNAPSHOT = {
  drives: [],
  mdArrays: [],
  physicalVolumes: [],
  volumeGroups: [],
  logicalVolumes: [],
  mounts: [],
  labels: [],
  warnings: [],
};

let directory: string;
let socketPath: string;
let server: RpcServer;
let logged: string[];
let handlers: Handlers;

function defaultHandlers(): Handlers {
  return {
    'system.state': () =>
      Promise.resolve({ snapshot: EMPTY_SNAPSHOT, readAt: AT, stateHash: 'abc' }),
    'jobs.list': () => Promise.resolve({ jobs: [JOB] }),
    'jobs.get': ({ id }) => {
      if (id === JOB_ID) {
        return Promise.resolve({ job: JOB, log: [] });
      }
      return Promise.reject(new RpcError('not-found', `There is no job ${id}.`));
    },
    'pools.list': () => Promise.reject(new RpcError('rejected', 'Not in this test.')),
    'pools.get': () => Promise.reject(new RpcError('rejected', 'Not in this test.')),
    'drives.list': () => Promise.reject(new RpcError('rejected', 'Not in this test.')),
    'pools.previewCreate': () => Promise.reject(new RpcError('rejected', 'Not in this test.')),
    'volumes.previewCreate': () => Promise.reject(new RpcError('rejected', 'Not in this test.')),
    'jobs.submit': () => Promise.reject(new RpcError('rejected', 'Not in this test.')),
    'jobs.retry': () => Promise.reject(new RpcError('rejected', 'Not in this test.')),
  };
}

/** Sends raw text and resolves with every line received until the server closes or goes quiet. */
function exchangeRaw(text: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.endsWith('\n')) {
        socket.end();
      }
    });
    socket.on('close', () => resolve(received.split('\n').filter((line) => line !== '')));
    socket.on('error', reject);
    socket.write(text);
  });
}

function client(): Promise<RpcClient> {
  return RpcClient.connect(socketPath);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-rpc-'));
  socketPath = join(directory, 'core.sock');
  logged = [];
  handlers = defaultHandlers();
  server = await RpcServer.listen(socketPath, {
    // Look the handler up on every call so a test can replace one.
    handlers: {
      'system.state': (params) => handlers['system.state'](params),
      'jobs.list': (params) => handlers['jobs.list'](params),
      'jobs.get': (params) => handlers['jobs.get'](params),
      'pools.list': (params) => handlers['pools.list'](params),
      'pools.get': (params) => handlers['pools.get'](params),
      'drives.list': (params) => handlers['drives.list'](params),
      'pools.previewCreate': (params) => handlers['pools.previewCreate'](params),
      'volumes.previewCreate': (params) => handlers['volumes.previewCreate'](params),
      'jobs.submit': (params) => handlers['jobs.submit'](params),
      'jobs.retry': (params) => handlers['jobs.retry'](params),
    },
    log: (line) => logged.push(line),
  });
});

afterEach(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe('calls', () => {
  it('returns results checked against the contract', async () => {
    const rpc = await client();
    await expect(rpc.call('system.state', {})).resolves.toEqual({
      snapshot: EMPTY_SNAPSHOT,
      readAt: AT,
      stateHash: 'abc',
    });
    await expect(rpc.call('jobs.get', { id: JOB_ID })).resolves.toEqual({ job: JOB, log: [] });
    await rpc.close();
  });

  it('runs overlapping calls on one connection and matches replies by id', async () => {
    const rpc = await client();
    const [list, state] = await Promise.all([
      rpc.call('jobs.list', {}),
      rpc.call('system.state', {}),
    ]);
    expect(list.jobs).toHaveLength(1);
    expect(state.stateHash).toBe('abc');
    await rpc.close();
  });

  it('rejects params that do not match the schema before the handler runs', async () => {
    let called = false;
    handlers = {
      ...defaultHandlers(),
      'jobs.get': () => {
        called = true;
        return Promise.resolve({ job: JOB, log: [] });
      },
    };
    const rpc = await client();
    const error = await rpc
      .call('jobs.get', { id: 'not-a-uuid' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe('invalid-params');
    expect((error as RpcError).message).toContain('id');
    expect(called).toBe(false);
    await rpc.close();
  });

  it('rejects unknown params rather than ignoring them', async () => {
    const rpc = await client();
    const call = rpc.call('jobs.list', { extra: true } as never);
    await expect(call).rejects.toMatchObject({ code: 'invalid-params' });
    await rpc.close();
  });

  it('passes a handler error code and reasons through', async () => {
    handlers = {
      ...defaultHandlers(),
      'jobs.list': () => Promise.reject(new RpcError('rejected', 'No.', ['first', 'second'])),
    };
    const rpc = await client();
    await expect(rpc.call('jobs.list', {})).rejects.toMatchObject({
      code: 'rejected',
      message: 'No.',
      reasons: ['first', 'second'],
    });
    await expect(rpc.call('jobs.get', { id: OTHER_JOB_ID })).rejects.toMatchObject({
      code: 'not-found',
    });
    await rpc.close();
  });

  it('hides an unexpected error behind internal and logs it', async () => {
    handlers = {
      ...defaultHandlers(),
      'jobs.list': () => Promise.reject(new Error('database is locked')),
    };
    const rpc = await client();
    const error = (await rpc.call('jobs.list', {}).catch((caught: unknown) => caught)) as RpcError;
    expect(error.code).toBe('internal');
    expect(error.message).not.toContain('database is locked');
    expect(logged.join('\n')).toContain('database is locked');
    await rpc.close();
  });

  it('fails a call whose result breaks the contract', async () => {
    handlers = {
      ...defaultHandlers(),
      'jobs.list': () => Promise.resolve({ jobs: [{ id: 'nonsense' }] } as never),
    };
    const rpc = await client();
    await expect(rpc.call('jobs.list', {})).rejects.toBeInstanceOf(ProtocolError);
    await rpc.close();
  });
});

describe('malformed requests', () => {
  it('answers an unknown method with invalid-request and its id', async () => {
    const [reply] = await exchangeRaw('{"id":7,"method":"pools.destroy","params":{}}\n');
    expect(JSON.parse(reply ?? '')).toEqual({
      id: 7,
      error: { code: 'invalid-request', message: 'Unknown method pools.destroy' },
    });
  });

  it('answers a line that is not JSON with a null id', async () => {
    const [reply] = await exchangeRaw('not json\n');
    expect(JSON.parse(reply ?? '')).toMatchObject({ id: null, error: { code: 'invalid-request' } });
  });

  it('does not treat an inherited property name as a method', async () => {
    const [reply] = await exchangeRaw('{"id":1,"method":"toString","params":{}}\n');
    expect(JSON.parse(reply ?? '')).toMatchObject({ id: 1, error: { code: 'invalid-request' } });
  });

  it('closes a connection that sends a line over the limit', async () => {
    const lines = await exchangeRaw('x'.repeat(MAX_LINE_BYTES + 1));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      id: null,
      error: { code: 'invalid-request' },
    });
  });
});

describe('events', () => {
  it('sends events to subscribed connections', async () => {
    const rpc = await client();
    const seen: RpcEvent[] = [];
    await rpc.subscribe((event) => seen.push(event));
    server.publish('state.changed', { readAt: AT, stateHash: 'def' });
    // Replies and events share the connection in order, so a reply means the event arrived.
    await rpc.call('jobs.list', {});
    expect(seen).toEqual([{ event: 'state.changed', data: { readAt: AT, stateHash: 'def' } }]);
    await rpc.close();
  });

  it('limits a subscription to one job when asked', async () => {
    const rpc = await client();
    const seen: RpcEvent[] = [];
    await rpc.subscribe((event) => seen.push(event), JOB_ID);
    server.publish('job.log', { jobId: OTHER_JOB_ID, step: 0, line: 'other' });
    server.publish('job.log', { jobId: JOB_ID, step: 0, line: 'mine' });
    server.publish('state.changed', { readAt: AT, stateHash: 'def' });
    await rpc.call('jobs.list', {});
    expect(seen).toEqual([{ event: 'job.log', data: { jobId: JOB_ID, step: 0, line: 'mine' } }]);
    await rpc.close();
  });
});

describe('connections', () => {
  it('says core is not running when nothing listens', async () => {
    await expect(RpcClient.connect(join(directory, 'missing.sock'))).rejects.toBeInstanceOf(
      CoreUnavailableError,
    );
  });

  it('fails waiting and later calls when the server goes away', async () => {
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const handlerReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    handlers = {
      ...defaultHandlers(),
      'jobs.list': () =>
        new Promise((resolve) => {
          reached();
          release = () => resolve({ jobs: [] });
        }),
    };
    const rpc = await client();
    const waiting = rpc.call('jobs.list', {});
    await handlerReached;
    await server.close();
    release();
    await expect(waiting).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(rpc.call('jobs.list', {})).rejects.toBeInstanceOf(ConnectionClosedError);
    server = await RpcServer.listen(socketPath, {
      handlers: defaultHandlers(),
      log: () => undefined,
    });
  });
});
