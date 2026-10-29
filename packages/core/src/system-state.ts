/**
 * Reads the machine's storage state into one typed snapshot. Read-only: it
 * runs inspection commands and never changes anything.
 */

import { FINDMNT_COLUMNS, type Mount, parseFindmnt } from '@ohr/shared/parsers/findmnt';
import { type BlockDevice, LSBLK_COLUMNS, parseLsblk } from '@ohr/shared/parsers/lsblk';
import {
  type LogicalVolume,
  LV_FIELDS,
  lvmReportArgs,
  type PhysicalVolume,
  PV_FIELDS,
  parseLvs,
  parsePvs,
  parseVgs,
  VG_FIELDS,
  type VolumeGroup,
} from '@ohr/shared/parsers/lvm';
import { type MdDetail, parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import { parseMdstat } from '@ohr/shared/parsers/mdstat';
import { parseSmartctl, type SmartReport } from '@ohr/shared/parsers/smartctl';
import type { DriveState, MdArrayState, SystemSnapshot } from '@ohr/shared/system-snapshot';

import { type CommandRunner, describeFailure, type FileReader } from './command-runner.ts';
import { driveRole, physicalDrives } from './drive-roles.ts';

const MDSTAT_PATH = '/proc/mdstat';
const SMART_TIMEOUT_MS = 60_000;

interface Context {
  readonly run: CommandRunner;
  readonly readFile: FileReader;
  readonly warnings: string[];
}

/** Runs a command and returns stdout, or records a warning and returns null. */
async function output(
  context: Context,
  command: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await context.run(command, args);
  if (result.kind === 'exited' && result.exitCode === 0) {
    return result.stdout;
  }
  context.warnings.push(describeFailure(command, result));
  return null;
}

/** Parses output, turning a parse failure into a warning. */
function parseOrWarn<T>(
  context: Context,
  text: string | null,
  parse: (text: string) => T,
  fallback: T,
): T {
  if (text === null) {
    return fallback;
  }
  try {
    return parse(text);
  } catch (error) {
    context.warnings.push(String(error));
    return fallback;
  }
}

async function readBlockDevices(context: Context): Promise<BlockDevice[]> {
  const result = await context.run('lsblk', [
    '--json',
    '--bytes',
    '--output',
    LSBLK_COLUMNS.join(','),
  ]);
  if (result.kind !== 'exited' || result.exitCode !== 0) {
    throw new SystemStateError(describeFailure('lsblk', result));
  }
  return parseLsblk(result.stdout);
}

async function readMounts(context: Context): Promise<Mount[]> {
  const text = await output(context, 'findmnt', [
    '--json',
    '--bytes',
    '--output',
    FINDMNT_COLUMNS.join(','),
  ]);
  return parseOrWarn(context, text, parseFindmnt, []);
}

async function readMdArrays(context: Context): Promise<MdArrayState[]> {
  const mdstat = await context.readFile(MDSTAT_PATH);
  const arrays = parseOrWarn(context, mdstat, parseMdstat, []);
  return Promise.all(
    arrays.map(async (status) => {
      const path = `/dev/${status.name}`;
      const text = await output(context, 'mdadm', ['--detail', '--export', path]);
      const detail = parseOrWarn<MdDetail | null>(context, text, parseMdadmDetail, null);
      return { name: status.name, path, status, detail };
    }),
  );
}

async function readLvm(
  context: Context,
): Promise<Pick<SystemSnapshot, 'physicalVolumes' | 'volumeGroups' | 'logicalVolumes'>> {
  const [pvs, vgs, lvs] = await Promise.all([
    output(context, 'pvs', lvmReportArgs(PV_FIELDS)),
    output(context, 'vgs', lvmReportArgs(VG_FIELDS)),
    output(context, 'lvs', lvmReportArgs(LV_FIELDS)),
  ]);
  return {
    physicalVolumes: parseOrWarn<PhysicalVolume[]>(context, pvs, parsePvs, []),
    volumeGroups: parseOrWarn<VolumeGroup[]>(context, vgs, parseVgs, []),
    logicalVolumes: parseOrWarn<LogicalVolume[]>(context, lvs, parseLvs, []),
  };
}

/**
 * Reads SMART data without waking a sleeping drive. smartctl exits non-zero
 * for many health findings, so the JSON is parsed whenever it is present.
 */
async function readSmart(context: Context, device: BlockDevice): Promise<SmartReport | null> {
  const result = await context.run(
    'smartctl',
    ['--json', '--all', '--nocheck=standby', device.path],
    { timeoutMs: SMART_TIMEOUT_MS },
  );
  if (result.kind !== 'exited') {
    context.warnings.push(describeFailure('smartctl', result));
    return null;
  }
  const report = parseOrWarn<SmartReport | null>(context, result.stdout, parseSmartctl, null);
  // These two bits mean smartctl read nothing useful, including when it declined to wake a sleeping drive.
  if (report !== null && (report.exitFlags.commandLineError || report.exitFlags.deviceOpenFailed)) {
    const reason = report.messages.map((message) => message.text).join('; ') || 'no details';
    context.warnings.push(`SMART data unavailable for ${device.path}: ${reason}`);
    return null;
  }
  return report;
}

export class SystemStateError extends Error {
  override readonly name = 'SystemStateError';
}

export interface ReadOptions {
  readonly run: CommandRunner;
  readonly readFile: FileReader;
  /** Read SMART data for each drive. Slower, and needs root. */
  readonly includeSmart: boolean;
}

/** Reads the whole storage state. Throws SystemStateError only if lsblk itself fails. */
export async function readSystemState(options: ReadOptions): Promise<SystemSnapshot> {
  const context: Context = { run: options.run, readFile: options.readFile, warnings: [] };
  const [devices, mounts, mdArrays, lvm] = await Promise.all([
    readBlockDevices(context),
    readMounts(context),
    readMdArrays(context),
    readLvm(context),
  ]);
  const drives = await Promise.all(
    physicalDrives(devices).map(async (device) => {
      let smart: SmartReport | null = null;
      if (options.includeSmart) {
        smart = await readSmart(context, device);
      }
      return { device, role: driveRole(device), smart };
    }),
  );
  // Reads run in parallel, so sort warnings to keep output the same from run to run.
  return {
    drives,
    mdArrays,
    ...lvm,
    mounts,
    warnings: context.warnings.toSorted((a, b) => a.localeCompare(b)),
  };
}

/** Reads only the drive list, which needs no root and runs a single command. */
export async function readDrives(run: CommandRunner): Promise<DriveState[]> {
  const context: Context = { run, readFile: () => Promise.resolve(null), warnings: [] };
  const devices = await readBlockDevices(context);
  return physicalDrives(devices).map((device) => ({
    device,
    role: driveRole(device),
    smart: null,
  }));
}

/** Attached loop devices, as drives. Only for testing on loop devices: never offered to users. */
export async function readLoopDrives(run: CommandRunner): Promise<DriveState[]> {
  const context: Context = { run, readFile: () => Promise.resolve(null), warnings: [] };
  const devices = await readBlockDevices(context);
  return devices
    .filter((device) => device.type === 'loop' && device.sizeBytes > 0)
    .map((device) => ({ device, role: driveRole(device), smart: null }));
}
