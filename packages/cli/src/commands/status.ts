import { parseArgs } from 'node:util';

import { readSystemState } from '@ohr/core/system-state';
import { isDegraded, type MdstatSync } from '@ohr/shared/parsers/mdstat';
import { formatSize } from '@ohr/shared/sizes';
import type { DriveState, MdArrayState, SystemSnapshot } from '@ohr/shared/system-snapshot';

import { EXIT_OK, type Io } from '../io.ts';
import { formatTable } from '../table.ts';

const NOT_AVAILABLE = '-';
const INDENT = '  ';

function smartHealth(drive: DriveState): string {
  if (drive.smart === null) {
    return NOT_AVAILABLE;
  }
  if (drive.smart.passed === null) {
    return 'unknown';
  }
  if (drive.smart.passed) {
    return 'passed';
  }
  return 'FAILING';
}

function syncProgress(sync: MdstatSync): string {
  if (sync.percent === null) {
    return sync.state;
  }
  return `${sync.percent}%`;
}

function arrayState(array: MdArrayState): string {
  const { status } = array;
  if (!status.active) {
    return 'inactive';
  }
  // A new RAID5 or RAID6 is built by rebuilding onto its last member, so it
  // looks degraded until then, exactly like an array rebuilding after a failure.
  if (isDegraded(status)) {
    if (status.sync === null) {
      return 'DEGRADED';
    }
    if (status.sync.state === 'running') {
      return `rebuilding ${syncProgress(status.sync)}`;
    }
    return 'rebuild queued';
  }
  if (status.sync !== null) {
    return `${status.sync.action} ${syncProgress(status.sync)}`;
  }
  return 'healthy';
}

function memberList(array: MdArrayState): string {
  return array.status.members
    .toSorted((a, b) => a.slot - b.slot)
    .map((member) => {
      const flags = [member.faulty && 'failed', member.spare && 'spare'].filter(Boolean);
      if (flags.length === 0) {
        return member.device;
      }
      return `${member.device}(${flags.join(',')})`;
    })
    .join(' ');
}

function section(io: Io, title: string, lines: readonly string[]): void {
  io.stdout(title);
  for (const line of lines) {
    io.stdout(`${INDENT}${line}`);
  }
  io.stdout('');
}

function printDrives(io: Io, snapshot: SystemSnapshot): void {
  section(
    io,
    'Drives',
    formatTable(
      ['device', 'size', 'model', 'role', 'smart'],
      snapshot.drives.map((drive) => [
        drive.device.path,
        formatSize(drive.device.sizeBytes),
        drive.device.model ?? NOT_AVAILABLE,
        drive.role,
        smartHealth(drive),
      ]),
    ),
  );
}

function printArrays(io: Io, snapshot: SystemSnapshot): void {
  if (snapshot.mdArrays.length === 0) {
    return;
  }
  section(
    io,
    'RAID arrays',
    formatTable(
      ['array', 'name', 'level', 'size', 'state', 'members'],
      snapshot.mdArrays.map((array) => [
        array.path,
        array.detail?.devName ?? NOT_AVAILABLE,
        array.status.level ?? NOT_AVAILABLE,
        formatSize(array.status.sizeBytes ?? 0),
        arrayState(array),
        memberList(array),
      ]),
    ),
  );
}

function printVolumeGroups(io: Io, snapshot: SystemSnapshot): void {
  if (snapshot.volumeGroups.length === 0) {
    return;
  }
  section(
    io,
    'Volume groups',
    formatTable(
      ['name', 'size', 'free', 'pvs', 'lvs'],
      snapshot.volumeGroups.map((vg) => [
        vg.name,
        formatSize(vg.sizeBytes),
        formatSize(vg.freeBytes),
        String(vg.physicalVolumeCount),
        String(vg.logicalVolumeCount),
      ]),
    ),
  );
}

export const STATUS_USAGE = `Usage: ohr status [--smart] [--json]

Shows drives, RAID arrays, and LVM volume groups. Read-only.

Options:
  --smart    Include SMART health. Needs root. Never wakes sleeping drives.
  --json     Print the full snapshot as JSON.`;

export async function statusCommand(args: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      smart: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const snapshot = await readSystemState({
    run: io.run,
    readFile: io.readFile,
    includeSmart: values.smart,
  });
  if (values.json) {
    io.stdout(JSON.stringify(snapshot, null, 2));
    return EXIT_OK;
  }
  printDrives(io, snapshot);
  printArrays(io, snapshot);
  printVolumeGroups(io, snapshot);
  if (snapshot.warnings.length > 0) {
    section(io, 'Warnings', snapshot.warnings);
  }
  return EXIT_OK;
}
