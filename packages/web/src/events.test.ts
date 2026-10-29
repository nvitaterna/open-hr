import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JOB_ID } from './fake-core-test-helpers.ts';
import { type Harness, startHarness } from './web-test-helpers.ts';

const STARTS_WITH_RETRY = /^retry: /u;

let web: Harness;

beforeEach(async () => {
  web = await startHarness();
});

afterEach(async () => {
  await web.close();
});

describe('the event stream', () => {
  it('relays core events to the browser, with keepalives', async () => {
    const stream = await web.openStream();
    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    await web.untilSubscribed();
    const step = { jobId: JOB_ID, index: 0, name: 'Create', status: 'running', error: null };
    web.publish('job.step', { ...step, status: 'running' });
    // Wait for each on its own: on a slow machine a keepalive can come before the event.
    const frame = `event: job.step\ndata: ${JSON.stringify(step)}\n\n`;
    await expect(stream.waitFor(frame)).resolves.toMatch(STARTS_WITH_RETRY);
    await expect(stream.waitFor(': keepalive')).resolves.toContain(': keepalive');
  });

  it('shares one core subscription between streams and lets go of closed ones', async () => {
    const first = await web.openStream();
    const second = await web.openStream();
    await web.untilSubscribed();
    expect(web.coreConnections()).toBe(1);
    web.publish('job.log', { jobId: JOB_ID, step: 0, line: 'hello' });
    await Promise.all([first.waitFor('hello'), second.waitFor('hello')]);
    first.response.destroy();
    await expect.poll(() => web.core.listenerCount).toBe(1);
  });

  it('subscribes again when core comes back, and says the state changed', async () => {
    const stream = await web.openStream();
    await web.untilSubscribed();
    await web.stopCore();
    await web.startCore();
    await stream.waitFor('event: state.changed');
    web.publish('job.log', { jobId: JOB_ID, step: null, line: 'after' });
    await expect(stream.waitFor('after')).resolves.toContain('event: job.log');
  });

  it('ends open streams when the server closes', async () => {
    const stream = await web.openStream();
    const ended = new Promise((resolve) => {
      stream.response.on('close', resolve);
    });
    await web.closeServer();
    await expect(ended).resolves.toBeUndefined();
  });
});
