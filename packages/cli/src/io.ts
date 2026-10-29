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
  /** Asks the user a question on the terminal and returns what they typed. */
  readonly confirm: (question: string) => Promise<string>;
  /** True when running as root, which structural changes need. */
  readonly isRoot: () => boolean;
}

/** Raised for bad command-line input. Shown with the usage text and exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
