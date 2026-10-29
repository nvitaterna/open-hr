/**
 * ohr-core as a long-running process (plan section 5.1 and decision 0007):
 * the job store, the cached system snapshot, and the RPC server on the unix
 * socket, wired together. `main.ts` adds the command line and signals; tests
 * start it directly on a temporary socket.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { RpcServer } from '@ohr/rpc/server';

import type { CommandRunner, FileReader } from '../command-runner.ts';
import { JobStore } from '../jobs/store.ts';
import { readSystemState } from '../system-state.ts';
import { createHandlers } from './handlers.ts';
import { groupId, prepareSocketPath, secureSocket } from './socket.ts';
import { StateCache } from './state-cache.ts';

const IN_MEMORY = ':memory:';
/** How often the snapshot is read again when nothing else prompts it. */
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function resolveGroup(options: DaemonOptions): Promise<number | null> {
  if (options.socketGroup === null) {
    return null;
  }
  const gid = await groupId(options.socketGroup, options.readFile);
  if (gid === null) {
    options.log(
      `Group ${options.socketGroup} does not exist. The socket stays in root's group, so only root can connect.`,
    );
  }
  return gid;
}

export interface DaemonOptions {
  readonly socketPath: string;
  /** SQLite file, or ":memory:" for tests. */
  readonly databasePath: string;
  /** Group that may connect to the socket, or null to leave it in root's group. */
  readonly socketGroup: string | null;
  readonly run: CommandRunner;
  readonly readFile: FileReader;
  readonly refreshIntervalMs?: number;
  readonly log: (line: string) => void;
}

export interface Daemon {
  readonly server: RpcServer;
  readonly state: StateCache;
  /** Stops listening, removes the socket file, and closes the database. */
  readonly close: () => Promise<void>;
}

/** Opens the database, reads the system once, and starts listening. */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  if (options.databasePath !== IN_MEMORY) {
    await mkdir(dirname(options.databasePath), { recursive: true });
  }
  const store = JobStore.open(options.databasePath);
  let server: RpcServer | null = null;
  const state = new StateCache({
    read: () =>
      readSystemState({ run: options.run, readFile: options.readFile, includeSmart: false }),
    onChange: ({ readAt, stateHash }) => server?.publish('state.changed', { readAt, stateHash }),
  });
  try {
    await state.refresh();
    const gid = await resolveGroup(options);
    await prepareSocketPath(options.socketPath, gid);
    server = await RpcServer.listen(options.socketPath, {
      handlers: createHandlers({ store, state }),
      log: options.log,
    });
    await secureSocket(options.socketPath, gid);
  } catch (error) {
    await server?.close();
    store.close();
    throw error;
  }
  const timer = setInterval(() => {
    state.refresh().catch((error: unknown) => {
      options.log(`Reading the system state failed: ${errorText(error)}`);
    });
  }, options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
  const listening = server;
  return {
    server: listening,
    state,
    close: async () => {
      clearInterval(timer);
      await listening.close();
      store.close();
    },
  };
}
