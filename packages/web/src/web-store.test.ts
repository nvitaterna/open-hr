import { describe, expect, it } from 'vitest';

import { WebStore } from './web-store.ts';

describe('WebStore', () => {
  it('holds exactly one admin account', () => {
    const store = WebStore.open(':memory:');
    expect(store.admin()).toBeNull();
    expect(store.createAdmin({ username: 'nico', passwordHash: 'h1' }, 't')).toBe(true);
    expect(store.createAdmin({ username: 'eve', passwordHash: 'h2' }, 't')).toBe(false);
    expect(store.admin()).toEqual({ username: 'nico', passwordHash: 'h1' });
    store.close();
  });

  it('expires a session that has been idle too long', () => {
    const store = WebStore.open(':memory:');
    store.createSession('a', '2026-10-01T00:00:00.000Z');
    store.createSession('b', '2026-10-20T00:00:00.000Z');
    const cutoff = '2026-10-10T00:00:00.000Z';
    expect(store.useSession('a', '2026-10-21T00:00:00.000Z', cutoff)).toBe(false);
    expect(store.useSession('b', '2026-10-21T00:00:00.000Z', cutoff)).toBe(true);
    expect(store.useSession('a', '2026-10-21T00:00:00.000Z', cutoff)).toBe(false);
    expect(store.useSession('unknown', '2026-10-21T00:00:00.000Z', cutoff)).toBe(false);
    store.deleteIdleSessions('2026-10-22T00:00:00.000Z');
    expect(store.useSession('b', '2026-10-21T00:00:00.000Z', cutoff)).toBe(false);
    store.close();
  });
});
