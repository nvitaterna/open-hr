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

const GIB = 1_073_741_824;
const FAKE_DISK_GIB = 4;
const FAKE_DISK_BYTES = FAKE_DISK_GIB * GIB;

function emptyDisk(name: string, sizeBytes: number, serial: string): string {
  return JSON.stringify({
    name,
    path: `/dev/${name}`,
    pkname: null,
    type: 'disk',
    size: sizeBytes,
    model: 'Fake Disk',
    serial,
    wwn: null,
    tran: 'sata',
    rota: true,
    rm: false,
    ro: false,
    fstype: null,
    uuid: null,
    partuuid: null,
    partlabel: null,
    parttype: null,
    partn: null,
    mountpoints: [null],
  });
}

export interface CliOptions {
  /** What the fake user types at a confirmation prompt. */
  readonly answer?: string;
  readonly isRoot?: boolean;
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

/** The real VM pool from fixtures/vm-shr1. */
export function vmMachine(): Map<string, CommandResult> {
  const answers = new Map<string, CommandResult>([
    ['lsblk', ok(fixture('vm-shr1/lsblk.json'))],
    ['findmnt', ok(fixture('vm-shr1/findmnt.json'))],
    ['pvs', ok(fixture('vm-shr1/pvs.json'))],
    ['vgs', ok(fixture('vm-shr1/vgs.json'))],
    ['lvs', ok(fixture('vm-shr1/lvs.json'))],
  ]);
  for (const md of ['md124', 'md125', 'md126', 'md127']) {
    answers.set(`mdadm /dev/${md}`, ok(fixture(`vm-shr1/mdadm-detail-${md}.txt`)));
  }
  return answers;
}

/** /proc/mdstat from the VM pool, after the initial build or during it. */
export function vmFiles(mdstat: 'mdstat.txt' | 'mdstat-resync.txt'): ReadonlyMap<string, string> {
  return new Map([['/proc/mdstat', fixture(`vm-shr1/${mdstat}`)]]);
}

/** The worked example's system drive plus two empty 4 GiB disks, sdx and sdy, and no pool. */
export function emptyDrivesMachine(): Map<string, CommandResult> {
  const example = JSON.parse(fixture('example-shr1/lsblk.json')) as {
    blockdevices: { name: string }[];
  };
  const system = example.blockdevices.find((device) => device.name === 'nvme0n1');
  const lsblk = JSON.stringify({
    blockdevices: [
      system,
      JSON.parse(emptyDisk('sdx', FAKE_DISK_BYTES, 'X1')),
      JSON.parse(emptyDisk('sdy', FAKE_DISK_BYTES, 'Y1')),
    ],
  });
  const emptyReport = (key: string): string => JSON.stringify({ report: [{ [key]: [] }] });
  return new Map<string, CommandResult>([
    ['lsblk', ok(lsblk)],
    ['findmnt', ok(fixture('example-shr1/findmnt.json'))],
    ['pvs', ok(emptyReport('pv'))],
    ['vgs', ok(emptyReport('vg'))],
    ['lvs', ok(emptyReport('lv'))],
  ]);
}

/** Runs the CLI against a fake machine and captures its output. */
export async function runCli(
  args: readonly string[],
  answers: ReadonlyMap<string, CommandResult> = exampleMachine(),
  files: ReadonlyMap<string, string> = exampleFiles(),
  options: CliOptions = {},
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
    confirm: (question) => {
      stdout.push(question);
      return Promise.resolve(options.answer ?? '');
    },
    isRoot: () => options.isRoot ?? true,
  };
  const code = await run(args, io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}
