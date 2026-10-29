#!/usr/bin/env node
/** The ohr-core command: runs the root daemon until SIGTERM or SIGINT. */

import process from 'node:process';
import { parseArgs } from 'node:util';

import { CORE_SOCKET_PATH, DEFAULT_DATABASE_PATH, SHORT_NAME } from '@ohr/shared/constants';

import { runCommand } from '../command-runner.ts';
import { readTextFile } from '../file-reader.ts';
import { startDaemon } from './daemon.ts';

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const USAGE = `Usage: ohr-core [options]

Runs the Open HR root daemon. Normally started by systemd as ohr-core.service.

Options:
  --socket <path>     Unix socket to listen on (default ${CORE_SOCKET_PATH})
  --database <path>   SQLite database (default ${DEFAULT_DATABASE_PATH})
  --group <name>      Group allowed to connect (default ${SHORT_NAME}); "" for root only
  --allow-loop        Offer loop devices as drives. For testing only: a pool on
                      loop devices does not come back after a reboot by itself.
  --help              Show this message`;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function options(): {
  socket: string;
  database: string;
  group: string;
  'allow-loop': boolean;
  help: boolean;
} {
  const { values } = parseArgs({
    options: {
      socket: { type: 'string', default: CORE_SOCKET_PATH },
      database: { type: 'string', default: DEFAULT_DATABASE_PATH },
      group: { type: 'string', default: SHORT_NAME },
      'allow-loop': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  return values;
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof options>;
  try {
    parsed = options();
  } catch (error) {
    log(errorText(error));
    log(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (process.getuid?.() !== 0) {
    log('ohr-core is not running as root. Reads will be incomplete and jobs will fail.');
  }
  let socketGroup: string | null = parsed.group;
  if (socketGroup === '') {
    socketGroup = null;
  }
  const daemon = await startDaemon({
    socketPath: parsed.socket,
    databasePath: parsed.database,
    socketGroup,
    run: runCommand,
    readFile: readTextFile,
    allowLoopDevices: parsed['allow-loop'],
    log,
  });
  log(`ohr-core listening on ${parsed.socket}`);
  const stop = (signal: string): void => {
    log(`Received ${signal}, stopping.`);
    daemon.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log(`Stopping failed: ${String(error)}`);
        process.exit(EXIT_FAILURE);
      },
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return 0;
}

try {
  const code = await main();
  if (code !== 0) {
    process.exitCode = code;
  }
} catch (error) {
  log(`ohr-core failed to start: ${errorText(error)}`);
  process.exitCode = EXIT_FAILURE;
}
