import { PROJECT_NAME, SHORT_NAME } from '@ohr/shared/constants';

const USAGE = `${PROJECT_NAME}

Usage: ${SHORT_NAME} <command>

Commands:
  version    Print the version
  help       Show this message

More commands arrive with milestone M1.`;

const EXIT_OK = 0;
const EXIT_USAGE = 2;

export const VERSION = '0.0.0';

export interface Output {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Runs the CLI and returns the process exit code. */
export function run(args: readonly string[], out: Output): number {
  const [command] = args;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out.stdout(USAGE);
      return EXIT_OK;
    case 'version':
    case '--version':
    case '-v':
      out.stdout(`${SHORT_NAME} ${VERSION}`);
      return EXIT_OK;
    default:
      out.stderr(`Unknown command: ${command}\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}
