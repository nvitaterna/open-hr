import { RpcError } from '@ohr/rpc/rpc-error';
import { CORE_SOCKET_PATH, PROJECT_NAME, SHORT_NAME, VERSION } from '@ohr/shared/constants';

import { JOB_USAGE, jobCommand } from './commands/job.ts';
import { PLAN_USAGE, planCommand } from './commands/plan.ts';
import { POOL_USAGE, poolCommand } from './commands/pool.ts';
import { STATUS_USAGE, statusCommand } from './commands/status.ts';
import { VOLUME_USAGE, volumeCommand } from './commands/volume.ts';
import {
  type Core,
  type Environment,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type Io,
  UsageError,
} from './io.ts';

const USAGE = `${PROJECT_NAME}

Usage: ${SHORT_NAME} [--socket <path>] <command> [options]

Commands:
  status     Show drives, RAID arrays, and volume groups
  plan       Show how a new pool would be laid out
  pool       Create a pool: ${SHORT_NAME} pool create
  volume     Create a volume in a pool: ${SHORT_NAME} volume create
  job        List, show, and retry jobs: ${SHORT_NAME} job list
  version    Print the version
  help       Show this message, or help for a command: ${SHORT_NAME} help plan

Every command except version and plan --sizes asks ohr-core, which must be
running. --socket picks its socket; the default is ${CORE_SOCKET_PATH}.`;

const COMMANDS: ReadonlyMap<string, { usage: string; handler: typeof statusCommand }> = new Map([
  ['status', { usage: STATUS_USAGE, handler: statusCommand }],
  ['plan', { usage: PLAN_USAGE, handler: planCommand }],
  ['pool', { usage: POOL_USAGE, handler: poolCommand }],
  ['volume', { usage: VOLUME_USAGE, handler: volumeCommand }],
  ['job', { usage: JOB_USAGE, handler: jobCommand }],
]);

const SOCKET_OPTION = '--socket';
const SOCKET_PREFIX = `${SOCKET_OPTION}=`;

function isParseArgsError(error: unknown): error is TypeError {
  return (
    error instanceof TypeError &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS')
  );
}

/** Takes a leading --socket option off the arguments. */
function splitSocket(args: readonly string[]): { socket: string; rest: readonly string[] } {
  const [first, second, ...others] = args;
  if (first === SOCKET_OPTION) {
    if (second === undefined) {
      throw new UsageError(`${SOCKET_OPTION} needs a path.`);
    }
    return { socket: second, rest: others };
  }
  if (first?.startsWith(SOCKET_PREFIX) === true) {
    return { socket: first.slice(SOCKET_PREFIX.length), rest: args.slice(1) };
  }
  return { socket: CORE_SOCKET_PATH, rest: args };
}

/** Prints a refusal from core: its reasons, one per line, or its message. */
function reportRpcError(io: Io, error: RpcError): void {
  if (error.reasons.length === 0) {
    io.stderr(error.message);
    return;
  }
  for (const reason of error.reasons) {
    io.stderr(reason);
  }
}

function help(topic: string | undefined, io: Io): number {
  let usage = USAGE;
  if (topic !== undefined) {
    usage = COMMANDS.get(topic)?.usage ?? USAGE;
  }
  io.stdout(usage);
  return EXIT_OK;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function dispatch(args: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = args;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    return help(rest[0], io);
  }
  if (name === 'version' || name === '--version' || name === '-v') {
    io.stdout(`${SHORT_NAME} ${VERSION}`);
    return EXIT_OK;
  }
  const command = COMMANDS.get(name);
  if (command === undefined) {
    io.stderr(`Unknown command: ${name}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    return help(name, io);
  }
  try {
    return await command.handler(rest, io);
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.stderr(`${error.message}\n\n${command.usage}`);
      return EXIT_USAGE;
    }
    if (error instanceof RpcError) {
      reportRpcError(io, error);
      return EXIT_FAILURE;
    }
    io.stderr(`Error: ${errorMessage(error)}`);
    return EXIT_FAILURE;
  }
}

/** Runs the CLI and returns the process exit code. */
export async function run(args: readonly string[], environment: Environment): Promise<number> {
  let socket: string;
  let commandArgs: readonly string[];
  try {
    ({ socket, rest: commandArgs } = splitSocket(args));
  } catch (error) {
    environment.stderr(`${errorMessage(error)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  // One connection per run, opened by the first command that needs core.
  const opened: { core: Core | null } = { core: null };
  const io: Io = {
    stdout: environment.stdout,
    stderr: environment.stderr,
    confirm: environment.confirm,
    onInterrupt: environment.onInterrupt,
    core: async () => {
      opened.core ??= await environment.connect(socket);
      return opened.core;
    },
  };
  try {
    return await dispatch(commandArgs, io);
  } finally {
    await opened.core?.close();
  }
}
