/** A fake terminal and machine for CLI tests. Not part of the package API. */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandResult } from '@ohr/core/command-runner';
import { type Daemon, startDaemon } from '@ohr/core/daemon/daemon';
import { RpcClient } from '@ohr/rpc/client';

import type { Environment } from './io.ts';
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
const POOL_FREE_GIB = 8;
const POOL_FREE_BYTES = POOL_FREE_GIB * GIB;

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

/** ohr-core on the fake machine, or null when the test wants it stopped. */
function startCore(
  socket: string,
  answers: ReadonlyMap<string, CommandResult>,
  files: ReadonlyMap<string, string>,
  options: CliOptions,
): Promise<Daemon | null> {
  if (options.coreStopped === true) {
    return Promise.resolve(null);
  }
  return startDaemon({
    socketPath: socket,
    databasePath: options.database ?? ':memory:',
    socketGroup: null,
    watch: null,
    allowLoopDevices: options.allowLoop ?? false,
    run: (command, commandArgs) =>
      Promise.resolve(
        answers.get(`${command} ${commandArgs.at(-1) ?? ''}`) ??
          answers.get(command) ?? { kind: 'not-found' },
      ),
    readFile: (path) => Promise.resolve(files.get(path) ?? null),
    labelIo: {
      read: (path) => Promise.reject(new Error(`no label on ${path} in this test`)),
      write: () => Promise.reject(new Error('read-only')),
    },
    log: () => undefined,
  });
}

export interface CliOptions {
  /** What the fake user types at a confirmation prompt. */
  readonly answer?: string;
  /** Start ohr-core with --allow-loop. */
  readonly allowLoop?: boolean;
  /** Leave ohr-core stopped, to see what the CLI says. */
  readonly coreStopped?: boolean;
  /** Job database, to share jobs between runs. Default: a fresh one in memory. */
  readonly database?: string;
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

/** The empty-drives machine plus a pool p2 with 8 GiB free and no volumes yet. */
export function poolMachine(): Map<string, CommandResult> {
  const answers = emptyDrivesMachine();
  const vgs = `{"report":[{"vg":[{"vg_name":"ohr-p2","vg_uuid":"7cjBJ4-KVk1-HVST-0h32-yU8H-5llJ-zzI029","vg_size":"${POOL_FREE_BYTES}","vg_free":"${POOL_FREE_BYTES}","pv_count":"1","lv_count":"0"}]}]}`;
  answers.set('vgs', ok(vgs));
  return answers;
}

/** Runs the CLI against ohr-core on a fake machine and captures its output. */
export async function runCli(
  args: readonly string[],
  answers: ReadonlyMap<string, CommandResult> = exampleMachine(),
  files: ReadonlyMap<string, string> = exampleFiles(),
  options: CliOptions = {},
): Promise<CliResult> {
  const directory = await mkdtemp(join(tmpdir(), 'ohr-cli-'));
  const socket = join(directory, 'core.sock');
  const daemon = await startCore(socket, answers, files, options);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const environment: Environment = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    confirm: (question) => {
      stdout.push(question);
      return Promise.resolve(options.answer ?? '');
    },
    connect: (path) => RpcClient.connect(path),
    onInterrupt: () => () => undefined,
  };
  try {
    const code = await run(['--socket', socket, ...args], environment);
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    await daemon?.jobs.idle();
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
