import { PROJECT_NAME, SHORT_NAME } from '@ohr/shared/constants';

import { PLAN_USAGE, planCommand } from './commands/plan.ts';
import { POOL_USAGE, poolCommand } from './commands/pool.ts';
import { STATUS_USAGE, statusCommand } from './commands/status.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Io, UsageError } from './io.ts';

const USAGE = `${PROJECT_NAME}

Usage: ${SHORT_NAME} <command> [options]

Commands:
  status     Show drives, RAID arrays, and volume groups
  plan       Show how a new pool would be laid out
  pool       Create a pool: ${SHORT_NAME} pool create
  version    Print the version
  help       Show this message, or help for a command: ${SHORT_NAME} help plan`;

const COMMANDS: ReadonlyMap<string, { usage: string; handler: typeof statusCommand }> = new Map([
  ['status', { usage: STATUS_USAGE, handler: statusCommand }],
  ['plan', { usage: PLAN_USAGE, handler: planCommand }],
  ['pool', { usage: POOL_USAGE, handler: poolCommand }],
]);

function isParseArgsError(error: unknown): error is TypeError {
  return (
    error instanceof TypeError &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS')
  );
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

export const VERSION = '0.0.0';

/** Runs the CLI and returns the process exit code. */
export async function run(args: readonly string[], io: Io): Promise<number> {
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
    io.stderr(`Error: ${errorMessage(error)}`);
    return EXIT_FAILURE;
  }
}
