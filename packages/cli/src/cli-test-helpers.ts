/** A fake terminal and machine for CLI tests. Not part of the package API. */

import { readFileSync } from 'node:fs';

import type { CommandResult } from '@ohr/core/command-runner';

import type { Io } from './io.ts';
import { run } from './run.ts';

const FIXTURES = new URL('../../shared/fixtures/', import.meta.url);

function fixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8');
}

function ok(stdout: string): CommandResult {
  return { kind: 'exited', exitCode: 0, stdout, stderr: '' };
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The worked example machine: answers keyed by command, or by command and last argument. */
export function exampleMachine(): Map<string, CommandResult> {
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
    ['smartctl /dev/sdb', ok(fixture('example-shr1/smartctl-sdb-failing.json'))],
    ['smartctl /dev/sdc', ok(fixture('example-shr1/smartctl-sda.json'))],
  ]);
}

export function exampleFiles(): ReadonlyMap<string, string> {
  return new Map([['/proc/mdstat', fixture('example-shr1/mdstat.txt')]]);
}

/** Runs the CLI against a fake machine and captures its output. */
export async function runCli(
  args: readonly string[],
  answers: ReadonlyMap<string, CommandResult> = exampleMachine(),
  files: ReadonlyMap<string, string> = exampleFiles(),
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    run: (command, commandArgs) =>
      Promise.resolve(
        answers.get(`${command} ${commandArgs.at(-1) ?? ''}`) ??
          answers.get(command) ?? { kind: 'not-found' },
      ),
    readFile: (path) => Promise.resolve(files.get(path) ?? null),
  };
  const code = await run(args, io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}
