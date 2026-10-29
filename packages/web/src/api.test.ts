import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DRIVE,
  GIB,
  JOB,
  JOB_ID,
  POOL,
  POOL_UUID,
  VOLUME_INPUT,
} from './fake-core-test-helpers.ts';
import { type Harness, startHarness } from './web-test-helpers.ts';

const OTHER_JOB_ID = '00000000-0000-4000-8000-000000000002';

let web: Harness;

beforeEach(async () => {
  web = await startHarness();
});

afterEach(async () => {
  await web.close();
});

describe('reading', () => {
  it('passes system, drives, pools, volumes, and jobs on from core', async () => {
    expect((await web.call('GET', '/api/v1/system')).json()).toMatchObject({
      stateHash: 'hash-1',
    });
    expect((await web.call('GET', '/api/v1/drives')).json()).toEqual({ drives: [DRIVE] });
    expect((await web.call('GET', '/api/v1/drives/sda')).json()).toEqual({ drive: DRIVE });
    expect((await web.call('GET', '/api/v1/pools')).json()).toEqual({ pools: [POOL] });
    expect((await web.call('GET', '/api/v1/pools/p1')).json()).toEqual({ pool: POOL });
    expect((await web.call('GET', '/api/v1/pools/p1/volumes')).json()).toEqual({
      volumes: POOL.volumes,
    });
    expect((await web.call('GET', '/api/v1/jobs')).json()).toEqual({ jobs: [JOB] });
    expect((await web.call('GET', `/api/v1/jobs/${OTHER_JOB_ID}`)).json()).toMatchObject({
      job: { id: OTHER_JOB_ID },
    });
  });

  it('asks for SMART only when the query says so', async () => {
    await web.call('GET', '/api/v1/system?smart=true');
    await web.call('GET', '/api/v1/system');
    expect(web.received.map((entry) => entry.params)).toEqual([{ smart: true }, {}]);
  });

  it('answers 404 for an unknown pool or drive, and 400 for a malformed job id', async () => {
    const pool = await web.call('GET', '/api/v1/pools/nope');
    expect(pool.statusCode).toBe(404);
    expect(pool.json()).toEqual({ error: 'not-found', message: 'There is no pool nope.' });
    expect((await web.call('GET', '/api/v1/drives/sdz')).statusCode).toBe(404);
    expect((await web.call('GET', '/api/v1/jobs/not-a-uuid')).statusCode).toBe(400);
  });

  it('needs a session', async () => {
    web.cookie = '';
    expect((await web.call('GET', '/api/v1/pools')).statusCode).toBe(401);
    expect((await web.call('GET', '/api/v1/events')).statusCode).toBe(401);
    expect(web.received).toEqual([]);
  });

  it('answers 503 while core is not running', async () => {
    await web.stopCore();
    const response = await web.call('GET', '/api/v1/pools');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'core-unavailable' });
  });
});

describe('creating a pool', () => {
  it('passes a refusal on with its reasons', async () => {
    const response = await web.call('POST', '/api/v1/pools/preview', {
      poolId: 'p2',
      redundancy: 'shr1',
      devices: ['/dev/sdb'],
      wipe: false,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: 'rejected',
      message: 'The pool cannot be created.',
      reasons: ['/dev/sdb holds a filesystem. Choose wipe to erase it.'],
    });
  });

  it('checks a body before core sees it', async () => {
    const response = await web.call('POST', '/api/v1/pools/preview', { poolId: 'p2' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid-request' });
    expect(web.received).toEqual([]);
  });

  it('answers 409 when the machine changed since the preview', async () => {
    const response = await web.call('POST', '/api/v1/pools', {
      input: {
        poolId: 'p2',
        poolUuid: POOL_UUID,
        redundancy: 'shr1',
        wipe: false,
        drives: [{ path: '/dev/sdb', serial: null, wwn: null, sizeBytes: GIB, driveUuid: JOB_ID }],
        layout: { redundancy: 'shr1', drives: [], tiers: [], rawBytes: 0, usableBytes: 0 },
      },
      stateHash: 'stale',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'state-changed' });
  });
});

describe('creating a volume and retrying', () => {
  it('previews a volume for the pool in the path and starts the job', async () => {
    const preview = await web.call('POST', '/api/v1/pools/p1/volumes/preview', {
      name: 'media',
      filesystem: 'ext4',
      size: { kind: 'all-free' },
    });
    expect(preview.statusCode).toBe(200);
    expect(web.received[0]).toEqual({
      method: 'volumes.previewCreate',
      params: { poolId: 'p1', name: 'media', filesystem: 'ext4', size: { kind: 'all-free' } },
    });
    const { input, stateHash } = preview.json<{ input: unknown; stateHash: string }>();
    const created = await web.call('POST', '/api/v1/pools/p1/volumes', { input, stateHash });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toEqual({ job: JOB });
    expect(web.received[1]).toEqual({
      method: 'jobs.submit',
      params: { kind: 'volume-create', input: VOLUME_INPUT, stateHash: 'hash-1' },
    });
  });

  it('refuses a volume input for another pool than the path names', async () => {
    const response = await web.call('POST', '/api/v1/pools/p2/volumes', {
      input: VOLUME_INPUT,
      stateHash: 'hash-1',
    });
    expect(response.statusCode).toBe(400);
    expect(web.received).toEqual([]);
  });

  it('passes a retry conflict on', async () => {
    const response = await web.call('POST', `/api/v1/jobs/${JOB_ID}/retry`);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'conflict' });
  });
});
