import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoreLink } from './core-link.ts';
import { LoginLimiter } from './login-limiter.ts';
import { buildWebServer } from './server.ts';
import { WebStore } from './web-store.ts';

const INDEX_HTML = '<!doctype html><title>Open HR</title><div id="root"></div>';
const SCRIPT = 'console.log("ui");';

let directory: string;
let store: WebStore;
let core: CoreLink;
let app: FastifyInstance;

async function serve(uiDir: string | null): Promise<void> {
  app = await buildWebServer({
    store,
    limiter: new LoginLimiter(),
    core,
    setupTokenPath: join(directory, 'setup-token'),
    secureCookies: false,
    tls: null,
    uiDir,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-web-ui-'));
  await mkdir(join(directory, 'ui', 'assets'), { recursive: true });
  await writeFile(join(directory, 'ui', 'index.html'), INDEX_HTML);
  await writeFile(join(directory, 'ui', 'assets', 'index-abc123.js'), SCRIPT);
  store = WebStore.open(':memory:');
  core = new CoreLink({ socketPath: join(directory, 'core.sock') });
  await serve(join(directory, 'ui'));
});

afterEach(async () => {
  await app.close();
  await core.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
});

describe('serving the UI', () => {
  it('answers index.html for the root and for any page, never cached', async () => {
    const responses = await Promise.all(
      ['/', '/drives', '/pools/tank'].map((url) => app.inject({ url })),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.body).toBe(INDEX_HTML);
    }
  });

  it('serves hashed assets with a long cache', async () => {
    const response = await app.inject({ url: '/assets/index-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(SCRIPT);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps answering JSON for the API', async () => {
    const response = await app.inject({ url: '/api/v1/setup' });
    expect(response.json()).toEqual({ required: true });
    const unknown = await app.inject({ url: '/api/v1/nothing' });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ error: 'setup-required' });
  });

  it('sends a strict content security policy with every response', async () => {
    const responses = await Promise.all(['/', '/api/v1/setup'].map((url) => app.inject({ url })));
    for (const response of responses) {
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('answers 404 for pages when there is no UI to serve', async () => {
    await app.close();
    await serve(null);
    const response = await app.inject({ url: '/drives' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });
});
