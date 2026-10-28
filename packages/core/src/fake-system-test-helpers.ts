/** A fake machine for tests, backed by the shared parser fixtures. Not part of the package API. */

import { readFileSync } from 'node:fs';

import type { CommandResult, CommandRunner, FileReader } from './command-runner.ts';

const FIXTURES = new URL('../../shared/fixtures/', import.meta.url);

export interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

export function fixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8');
}

export function ok(stdout: string): CommandResult {
  return { kind: 'exited', exitCode: 0, stdout, stderr: '' };
}

/**
 * Builds a runner that answers by command name and last argument. `answers`
 * maps "command" or "command lastArg" to a result. Unknown commands are not found.
 */
export function fakeRunner(answers: ReadonlyMap<string, CommandResult>): {
  run: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args });
    const specific = answers.get(`${command} ${args.at(-1) ?? ''}`);
    return Promise.resolve(specific ?? answers.get(command) ?? { kind: 'not-found' });
  };
  return { run, calls };
}

export function fakeFiles(files: ReadonlyMap<string, string>): FileReader {
  return (path) => Promise.resolve(files.get(path) ?? null);
}

/** The worked example from the plan: NVMe system drive and 4, 8, 8 TB drives in SHR-1. */
export function exampleShr1Answers(): Map<string, CommandResult> {
  return new Map<string, CommandResult>([
    ['lsblk', ok(fixture('example-shr1/lsblk.json'))],
    ['findmnt', ok(fixture('example-shr1/findmnt.json'))],
    ['pvs', ok(fixture('example-shr1/pvs.json'))],
    ['vgs', ok(fixture('example-shr1/vgs.json'))],
    ['lvs', ok(fixture('example-shr1/lvs.json'))],
    ['mdadm /dev/md126', ok(fixture('example-shr1/mdadm-detail-md126.txt'))],
    ['mdadm /dev/md127', ok(fixture('example-shr1/mdadm-detail-md127.txt'))],
    ['smartctl /dev/nvme0n1', ok(fixture('example-shr1/smartctl-nvme0n1.json'))],
    ['smartctl /dev/sda', ok(fixture('example-shr1/smartctl-sda.json'))],
    [
      'smartctl /dev/sdb',
      {
        kind: 'exited',
        exitCode: 200,
        stdout: fixture('example-shr1/smartctl-sdb-failing.json'),
        stderr: '',
      },
    ],
  ]);
}

export function exampleShr1Files(): FileReader {
  return fakeFiles(new Map([['/proc/mdstat', fixture('example-shr1/mdstat.txt')]]));
}
