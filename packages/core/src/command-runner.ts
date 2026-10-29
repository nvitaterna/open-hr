/**
 * The one place Open HR starts external programs. Commands always run with an
 * argument array and no shell, with a fixed minimal environment and the C
 * locale so output formats stay stable, and with a timeout so a hung drive
 * cannot hang the daemon.
 */

import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
/** 64 MiB. */
const MAX_OUTPUT_BYTES = 67_108_864;

/** Fixed system PATH. The daemon runs as root, so it never trusts an inherited PATH. */
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The whole environment commands see. Nothing is inherited, and the C locale
 * keeps output formats stable. Built from entries because the keys are
 * environment variable names, not identifiers.
 */
const COMMAND_ENV: NodeJS.ProcessEnv = Object.fromEntries([
  ['PATH', SAFE_PATH],
  ['LC_ALL', 'C'],
  ['LANG', 'C'],
]);

interface ExecFailure {
  readonly code?: unknown;
  readonly killed?: boolean;
  readonly message?: string;
}

function isExecFailure(value: unknown): value is ExecFailure {
  return typeof value === 'object' && value !== null;
}

function toResult(error: unknown, stdout: string, stderr: string): CommandResult {
  if (error === null) {
    return { kind: 'exited', exitCode: 0, stdout, stderr };
  }
  if (!isExecFailure(error)) {
    return { kind: 'failed', message: String(error) };
  }
  if (error.code === 'ENOENT') {
    return { kind: 'not-found' };
  }
  if (error.killed === true) {
    return { kind: 'timed-out', stdout, stderr };
  }
  if (typeof error.code === 'number') {
    return { kind: 'exited', exitCode: error.code, stdout, stderr };
  }
  return { kind: 'failed', message: error.message ?? String(error.code) };
}

export type CommandResult =
  | {
      readonly kind: 'exited';
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'timed-out'; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface RunOptions {
  readonly timeoutMs?: number;
}

/** Runs a program. Implementations must never invoke a shell. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandResult>;

/** Reads a whole text file, or returns null if it does not exist. */
export type FileReader = (path: string) => Promise<string | null>;

/** The real runner, backed by child_process.execFile. */
export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: 'utf8',
        env: COMMAND_ENV,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        resolve(toResult(error, stdout, stderr));
      },
    );
  });

/** One-line description of a command result that is not a clean exit. */
export function describeFailure(command: string, result: CommandResult): string {
  switch (result.kind) {
    case 'exited':
      return `${command} exited with code ${result.exitCode}: ${result.stderr.trim() || 'no error output'}`;
    case 'not-found':
      return `${command} is not installed`;
    case 'timed-out':
      return `${command} timed out`;
    case 'failed':
      return `${command} could not run: ${result.message}`;
    default:
      throw new Error(`Unhandled command result: ${String(result satisfies never)}`);
  }
}

/** Raised by runChecked when a command does not exit cleanly. */
export class CommandError extends Error {
  override readonly name = 'CommandError';
  readonly result: CommandResult;

  constructor(command: string, result: CommandResult) {
    super(describeFailure(command, result));
    this.result = result;
  }
}

/** Runs a command that must succeed, returning its stdout. Throws CommandError otherwise. */
export async function runChecked(
  run: CommandRunner,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<string> {
  const result = await run(command, args, options);
  if (result.kind !== 'exited' || result.exitCode !== 0) {
    throw new CommandError(command, result);
  }
  return result.stdout;
}
