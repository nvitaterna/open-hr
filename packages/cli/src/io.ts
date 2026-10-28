import type { CommandRunner, FileReader } from '@ohr/core/command-runner';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Everything a command touches outside itself, so tests can replace it. */
export interface Io {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly run: CommandRunner;
  readonly readFile: FileReader;
}

/** Raised for bad command-line input. Shown with the usage text and exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
