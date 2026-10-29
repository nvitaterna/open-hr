import { link, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeFiles } from '../fake-system-test-helpers.ts';
import { groupId, prepareSocketPath, secureSocket } from './socket.ts';
import { SocketBusyError } from './socket-busy-error.ts';

const GROUPS = `root:x:0:
adm:x:4:nico
ohr:x:998:www
ohrx:x:997:
`;

let directory: string;

function listen(path: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(path, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-socket-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('groupId', () => {
  it('finds a group by its exact name', async () => {
    const files = fakeFiles(new Map([['/etc/group', GROUPS]]));
    await expect(groupId('ohr', files)).resolves.toBe(998);
    await expect(groupId('oh', files)).resolves.toBeNull();
  });

  it('returns null without a group file', async () => {
    await expect(groupId('ohr', fakeFiles(new Map()))).resolves.toBeNull();
  });
});

describe('prepareSocketPath', () => {
  it('creates a missing directory with mode 0750', async () => {
    const path = join(directory, 'run', 'core.sock');
    await prepareSocketPath(path, null);
    const info = await stat(join(directory, 'run'));
    expect(info.mode % 0o1000).toBe(0o750);
  });

  it('removes a socket file nobody listens on', async () => {
    const live = join(directory, 'live.sock');
    const path = join(directory, 'core.sock');
    const server = await listen(live);
    // Closing a server removes its file. A hard link to it stays behind as a dead socket.
    await link(live, path);
    await close(server);
    await prepareSocketPath(path, null);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never removes a file that is not a socket', async () => {
    const path = join(directory, 'core.sock');
    await writeFile(path, 'precious');
    await expect(prepareSocketPath(path, null)).rejects.toThrow('not a socket');
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('refuses to start when another daemon is listening', async () => {
    const path = join(directory, 'core.sock');
    const server = await listen(path);
    await expect(prepareSocketPath(path, null)).rejects.toBeInstanceOf(SocketBusyError);
    await close(server);
  });
});

describe('secureSocket', () => {
  it('sets mode 0660', async () => {
    const path = join(directory, 'core.sock');
    const server = await listen(path);
    await secureSocket(path, null);
    const info = await stat(path);
    expect(info.mode % 0o1000).toBe(0o660);
    await close(server);
  });
});
