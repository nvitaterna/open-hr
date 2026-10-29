import type { RpcClient } from '@ohr/rpc/client';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** What the CLI uses of a connection to ohr-core. */
export type Core = Pick<RpcClient, 'call' | 'subscribe' | 'close'>;

/** What the process provides: the terminal and the way to reach ohr-core. Tests replace it. */
export interface Environment {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Asks the user a question on the terminal and returns what they typed. */
  readonly confirm: (question: string) => Promise<string>;
  /** Connects to ohr-core on the socket at `path`. */
  readonly connect: (path: string) => Promise<Core>;
  /** Calls `handler` on Ctrl-C until the returned function is called. */
  readonly onInterrupt: (handler: () => void) => () => void;
}

/** Everything a command touches outside itself. */
export interface Io {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly confirm: (question: string) => Promise<string>;
  /** Connects to ohr-core. Throws CoreUnavailableError if it is not running. */
  readonly core: () => Promise<Core>;
  readonly onInterrupt: (handler: () => void) => () => void;
}

/** Raised for bad command-line input. Shown with the usage text and exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
