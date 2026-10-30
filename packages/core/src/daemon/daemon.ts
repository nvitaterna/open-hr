/**
 * ohr-core as a long-running process (plan section 5.1 and decision 0007):
 * the job store, the cached system snapshot, and the RPC server on the unix
 * socket, wired together. `main.ts` adds the command line and signals; tests
 * start it directly on a temporary socket.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { RpcServer } from '@ohr/rpc/server';

import {
  type CommandRunner,
  type FileReader,
  type LineWatcher,
  type Watcher,
  watchLines,
} from '../command-runner.ts';
import type { BlockDeviceIo } from '../executors/label-partition.ts';
import { type JobDeps, jobDefinition } from '../jobs/definitions.ts';
import type { JobEvent } from '../jobs/engine.ts';
import { systemStateHash } from '../jobs/state-hash.ts';
import { JobStore } from '../jobs/store.ts';
import { readSystemState } from '../system-state.ts';
import { createHandlers } from './handlers.ts';
import { publishJobEvent } from './job-events.ts';
import { JobRunner } from './job-runner.ts';
import { groupId, prepareSocketPath, secureSocket } from './socket.ts';
import { StateCache } from './state-cache.ts';

const IN_MEMORY = ':memory:';
/** How often the snapshot is read again when nothing else prompts it. */
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
/** udev reports many events per change, so refresh once they have been quiet this long. */
const UDEV_SETTLE_MS = 1000;
const UDEV_EVENT_PREFIX = 'UDEV';
const UDEV_MONITOR_ARGS = ['monitor', '--udev', '--subsystem-match=block'];

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

/** True for events after which the machine may look different. */
function changesMachine(event: JobEvent): boolean {
  return (
    (event.kind === 'step' && event.status !== 'running' && event.status !== 'pending') ||
    (event.kind === 'job' && (event.status === 'done' || event.status === 'failed'))
  );
}

/** Refreshes the state after udev block events settle. Returns the watcher, or null without udevadm. */
function watchUdev(options: DaemonOptions, state: StateCache): Watcher | null {
  let { watch } = options;
  if (watch === undefined) {
    watch = watchLines;
  } else if (watch === null) {
    return null;
  }
  let settle: NodeJS.Timeout | null = null;
  return watch(
    'udevadm',
    UDEV_MONITOR_ARGS,
    (line) => {
      if (!line.startsWith(UDEV_EVENT_PREFIX)) {
        return;
      }
      if (settle !== null) {
        clearTimeout(settle);
      }
      settle = setTimeout(() => {
        settle = null;
        state.refresh().catch((error: unknown) => {
          options.log(`Reading the system state failed: ${errorText(error)}`);
        });
      }, UDEV_SETTLE_MS);
    },
    (reason) => options.log(`${reason}. Drive changes are noticed on the timer only.`),
  );
}

export interface DaemonOptions {
  readonly socketPath: string;
  /** SQLite file, or ":memory:" for tests. */
  readonly databasePath: string;
  /** Group that may connect to the socket, or null to leave it in root's group. */
  readonly socketGroup: string | null;
  readonly run: CommandRunner;
  readonly readFile: FileReader;
  /** Reads the label partitions. Tests pass a fake so they never open a real device. */
  readonly labelIo: BlockDeviceIo;
  readonly refreshIntervalMs?: number;
  /** Starts `udevadm monitor`. Null turns udev watching off, for tests. */
  readonly watch?: LineWatcher | null;
  /** Count loop devices as drives. Only for tests on loop devices. */
  readonly allowLoopDevices?: boolean;
  /** Overrides for the job builders, for tests. */
  readonly jobDeps?: JobDeps;
  readonly log: (line: string) => void;
}

export interface Daemon {
  readonly server: RpcServer;
  readonly state: StateCache;
  readonly jobs: JobRunner;
  /**
   * Stops listening, removes the socket file, and closes the database once
   * no job is running. A job that is still running is left to the process
   * exit and resumes on the next start.
   */
  readonly close: () => Promise<void>;
}

/** Opens the database, reads the system once, starts listening, and resumes unfinished jobs. */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  if (options.databasePath !== IN_MEMORY) {
    await mkdir(dirname(options.databasePath), { recursive: true });
  }
  const store = JobStore.open(options.databasePath);
  let server: RpcServer | null = null;
  const state = new StateCache({
    read: () =>
      readSystemState({
        run: options.run,
        readFile: options.readFile,
        includeSmart: false,
        labelIo: options.labelIo,
        includeLoopDevices: options.allowLoopDevices ?? false,
      }),
    onChange: ({ readAt, stateHash }) => server?.publish('state.changed', { readAt, stateHash }),
  });
  const jobDeps = options.jobDeps ?? {};
  const jobs = new JobRunner({
    store,
    run: options.run,
    definitionFor: (job) => jobDefinition(job, jobDeps),
    onEvent: (event) => {
      const publish = (): void => {
        if (server !== null) {
          publishJobEvent(server, event);
        }
      };
      if (!changesMachine(event)) {
        publish();
        return;
      }
      const refreshed = state.refresh().then(
        () => undefined,
        (error: unknown) => {
          options.log(`Reading the system state failed: ${errorText(error)}`);
        },
      );
      if (event.kind === 'job') {
        // Clients read the state when a job finishes, so announce it only once the cache has caught up.
        refreshed.then(publish, publish);
      } else {
        publish();
      }
    },
    log: options.log,
  });
  // A failed first read is not fatal: the daemon still listens, and callers get the error.
  await state.refresh().catch((error: unknown) => {
    options.log(`Reading the system state failed: ${errorText(error)}`);
  });
  try {
    const gid = await resolveGroup(options);
    await prepareSocketPath(options.socketPath, gid);
    server = await RpcServer.listen(options.socketPath, {
      handlers: createHandlers({
        store,
        state,
        jobs,
        jobDeps,
        readWithSmart: async () => {
          const snapshot = await readSystemState({
            run: options.run,
            readFile: options.readFile,
            includeSmart: true,
            labelIo: options.labelIo,
            includeLoopDevices: options.allowLoopDevices ?? false,
          });
          return {
            snapshot,
            readAt: new Date().toISOString(),
            stateHash: systemStateHash(snapshot),
          };
        },
      }),
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
  const udev = watchUdev(options, state);
  jobs.resumeUnfinished();
  const listening = server;
  return {
    server: listening,
    state,
    jobs,
    close: async () => {
      clearInterval(timer);
      udev?.stop();
      await listening.close();
      if (jobs.runningJobIds.length === 0) {
        store.close();
      }
    },
  };
}
