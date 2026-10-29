#!/usr/bin/env node
/**
 * The ohr-web command: serves the API (and later the UI) until SIGTERM, or
 * with `setup-token` writes a fresh one-time setup token (decision 0008).
 */

import { chown, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { CORE_SOCKET_PATH, DEFAULT_WEB_PORT } from '@ohr/shared/constants';

import { CoreLink } from './core-link.ts';
import { LoginLimiter } from './login-limiter.ts';
import { buildWebServer } from './server.ts';
import { writeSetupToken } from './setup-token.ts';
import { WebStore } from './web-store.ts';

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const DEFAULT_DATA_DIR = '/var/lib/ohr/web';
const DEFAULT_TLS_DIR = '/etc/ohr/tls';
const ALL_ADDRESSES = '0.0.0.0';
const LOCALHOST = '127.0.0.1';
const DATABASE_FILE = 'web.db';
const TOKEN_FILE = 'setup-token';

const USAGE = `Usage: ohr-web [options]
       ohr-web setup-token [--data <dir>]

Serves the Open HR web interface. Normally started by systemd as ohr-web.service.
setup-token writes a new one-time token for creating the admin account, which
is also how a forgotten password is reset. Run it as root.

Options:
  --port <n>          Port to listen on (default ${DEFAULT_WEB_PORT})
  --host <address>    Address to listen on (default ${ALL_ADDRESSES})
  --data <dir>        Web data: database and setup token (default ${DEFAULT_DATA_DIR})
  --tls <dir>         Directory with cert.pem and key.pem (default ${DEFAULT_TLS_DIR})
  --socket <path>     ohr-core's socket (default ${CORE_SOCKET_PATH})
  --ui <dir>          The UI build to serve (default: none, the API only)
  --insecure-http     Plain HTTP on ${LOCALHOST}, for development only
  --help              Show this message`;

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function options(args: readonly string[]): {
  values: {
    port: string;
    host: string;
    data: string;
    tls: string;
    socket: string;
    ui?: string;
    'insecure-http': boolean;
    help: boolean;
  };
  positionals: string[];
} {
  return parseArgs({
    args: [...args],
    options: {
      port: { type: 'string', default: String(DEFAULT_WEB_PORT) },
      host: { type: 'string', default: ALL_ADDRESSES },
      data: { type: 'string', default: DEFAULT_DATA_DIR },
      tls: { type: 'string', default: DEFAULT_TLS_DIR },
      socket: { type: 'string', default: CORE_SOCKET_PATH },
      ui: { type: 'string' },
      'insecure-http': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });
}

function uiDirectory(dir: string | undefined): string | null {
  if (dir === undefined) {
    return null;
  }
  return resolve(dir);
}

/** Writes a token the ohr user can read: owned like the data directory, mode 0600. */
async function setupToken(dataDir: string): Promise<number> {
  const path = join(dataDir, TOKEN_FILE);
  const token = await writeSetupToken(path);
  const owner = await stat(dataDir);
  await chown(path, owner.uid, owner.gid);
  process.stdout.write(`Setup token: ${token}\n`);
  process.stdout.write('Open the web interface and enter it to create the admin account.\n');
  return 0;
}

async function serve(values: ReturnType<typeof options>['values']): Promise<number> {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0) {
    log(`--port must be a port number, got "${values.port}".`);
    return EXIT_USAGE;
  }
  const insecure = values['insecure-http'];
  let tls: { key: Buffer; cert: Buffer } | null = null;
  let { host } = values;
  if (insecure) {
    host = LOCALHOST;
    log('Serving plain HTTP on localhost. Never use --insecure-http on a real install.');
  } else {
    tls = {
      key: await readFile(join(values.tls, 'key.pem')),
      cert: await readFile(join(values.tls, 'cert.pem')),
    };
  }
  const store = WebStore.open(join(values.data, DATABASE_FILE));
  const core = new CoreLink({ socketPath: values.socket, log });
  const app = await buildWebServer({
    store,
    limiter: new LoginLimiter(),
    core,
    // The static file server needs an absolute path.
    uiDir: uiDirectory(values.ui),
    setupTokenPath: join(values.data, TOKEN_FILE),
    secureCookies: !insecure,
    tls,
    logger: true,
  });
  await app.listen({ port, host });
  const stop = (signal: string): void => {
    log(`Received ${signal}, stopping.`);
    Promise.all([app.close(), core.close()]).then(
      () => {
        store.close();
        process.exit(0);
      },
      (error: unknown) => {
        log(`Stopping failed: ${errorText(error)}`);
        process.exit(EXIT_FAILURE);
      },
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return 0;
}

function main(args: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof options>;
  try {
    parsed = options(args);
  } catch (error) {
    log(`${errorText(error)}\n\n${USAGE}`);
    return Promise.resolve(EXIT_USAGE);
  }
  const [command, ...extra] = parsed.positionals;
  if (parsed.values.help) {
    process.stdout.write(`${USAGE}\n`);
    return Promise.resolve(0);
  }
  if (command === 'setup-token' && extra.length === 0) {
    return setupToken(parsed.values.data);
  }
  if (command !== undefined) {
    log(`Unknown command: ${command}\n\n${USAGE}`);
    return Promise.resolve(EXIT_USAGE);
  }
  return serve(parsed.values);
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== 0) {
    process.exitCode = code;
  }
} catch (error) {
  log(`ohr-web failed: ${errorText(error)}`);
  process.exitCode = EXIT_FAILURE;
}
