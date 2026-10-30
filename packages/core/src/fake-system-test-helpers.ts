/** A fake machine for tests, backed by the shared parser fixtures. Not part of the package API. */

import { readFileSync } from 'node:fs';

import { encodeLabelDescriptor } from '@ohr/shared/label-descriptor';

import type { CommandResult, CommandRunner, FileReader } from './command-runner.ts';
import type { BlockDeviceIo } from './executors/label-partition.ts';

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

/** The worked example's lsblk output with one more drive, empty, such as a new 8 TB sdd. */
export function exampleLsblkWithEmptyDrive(name: string, sizeBytes: number): string {
  const lsblk = JSON.parse(fixture('example-shr1/lsblk.json')) as { blockdevices: unknown[] };
  lsblk.blockdevices.push({
    name,
    path: `/dev/${name}`,
    pkname: null,
    type: 'disk',
    size: sizeBytes,
    model: 'Fake Disk',
    serial: `FAKE-${name}`,
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
    start: null,
    mountpoints: [null],
  });
  return JSON.stringify(lsblk);
}

/** The example pool's UUID, as its labels carry it. */
export const EXAMPLE_POOL_UUID = '6f1c2a4e-8b3d-4c5e-9a7f-1b2c3d4e5f60';

/** A label reader that serves the given partitions and fails for any other path. */
export function fakeLabelIo(labels: ReadonlyMap<string, Uint8Array>): BlockDeviceIo {
  return {
    read: (path) => {
      const bytes = labels.get(path);
      if (bytes === undefined) {
        return Promise.reject(new Error(`ENOENT: no such device ${path}`));
      }
      return Promise.resolve(bytes);
    },
    write: () => Promise.reject(new Error('the fake label reader is read-only')),
  };
}

/** Labels for the worked example's three pool drives. */
export function exampleShr1Labels(): BlockDeviceIo {
  return fakeLabelIo(
    new Map(
      ['sda', 'sdb', 'sdc'].map((name, index) => [
        `/dev/${name}1`,
        encodeLabelDescriptor({
          poolId: 'p1',
          poolUuid: EXAMPLE_POOL_UUID,
          driveUuid: `00000000-0000-4000-8000-00000000000${index + 1}`,
          redundancy: 'shr1',
          writtenAt: '2026-10-29T12:00:00.000Z',
        }),
      ]),
    ),
  );
}
