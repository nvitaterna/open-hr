import { parseArgs } from 'node:util';

import type { Redundancy } from '@ohr/shared/constants';
import { type DriveInput, describePlanError, type Layout, planPool } from '@ohr/shared/planner';
import { formatSize, parseSize, SizeParseError } from '@ohr/shared/sizes';

import { EXIT_FAILURE, EXIT_OK, type Io, UsageError } from '../io.ts';
import { formatTable } from '../table.ts';

const REDUNDANCY_LEVELS: readonly Redundancy[] = ['shr1', 'shr2'];
const REDUNDANCY_TITLES: Readonly<Record<Redundancy, string>> = { shr1: 'SHR-1', shr2: 'SHR-2' };
const INDENT = '  ';

function parseRedundancy(value: string | undefined): Redundancy {
  const level = REDUNDANCY_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new UsageError('Choose a redundancy level with --redundancy shr1 or --redundancy shr2.');
  }
  return level;
}

function hypotheticalDrives(list: string): DriveInput[] {
  return list.split(',').map((text, index) => {
    try {
      return { id: `drive ${index + 1}`, sizeBytes: parseSize(text) };
    } catch (error) {
      if (error instanceof SizeParseError) {
        throw new UsageError(error.message, { cause: error });
      }
      throw error;
    }
  });
}

/** Looks up real drives, with problems that stop planning and warnings that do not. */
async function realDrives(
  paths: readonly string[],
  io: Io,
): Promise<{ drives: DriveInput[]; problems: string[]; warnings: string[] }> {
  const core = await io.core();
  const { snapshot } = await core.call('system.state', {});
  const known = new Map(snapshot.drives.map((drive) => [drive.device.path, drive]));
  const drives: DriveInput[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const path of paths) {
    const drive = known.get(path);
    if (drive === undefined) {
      problems.push(`${path} is not a physical drive on this machine.`);
    } else if (drive.role === 'system') {
      problems.push(`${path} holds the operating system. Open HR never uses it.`);
    } else {
      if (drive.role !== 'empty') {
        warnings.push(`${path} is not empty. Creating a pool on it would erase what is there.`);
      }
      drives.push({ id: path, sizeBytes: drive.device.sizeBytes });
    }
  }
  return { drives, problems, warnings };
}

/** The drives to plan for, or null after reporting why there are none. */
async function chooseDrives(
  sizes: string | undefined,
  paths: readonly string[],
  io: Io,
): Promise<DriveInput[] | null> {
  if (sizes !== undefined) {
    return hypotheticalDrives(sizes);
  }
  const found = await realDrives(paths, io);
  for (const problem of found.problems) {
    io.stderr(problem);
  }
  if (found.problems.length > 0) {
    return null;
  }
  for (const warning of found.warnings) {
    io.stderr(`Warning: ${warning}`);
  }
  return found.drives;
}

function partitionSummary(layout: Layout, driveId: string): string {
  const drive = layout.drives.find((candidate) => candidate.id === driveId);
  return (drive?.partitions ?? [])
    .map((partition) => {
      if (partition.tier === null) {
        return `${partition.number}: label`;
      }
      return `${partition.number}: tier ${partition.tier}`;
    })
    .join(', ');
}

/** Prints a layout as tiers and drives. Shared with pool create. */
export function printLayout(io: Io, layout: Layout): void {
  io.stdout(`${REDUNDANCY_TITLES[layout.redundancy]} plan for ${layout.drives.length} drives`);
  io.stdout(
    `Usable capacity: ${formatSize(layout.usableBytes)} of ${formatSize(layout.rawBytes)} raw`,
  );
  io.stdout('');
  io.stdout('Tiers');
  const tierRows = formatTable(
    ['tier', 'level', 'partition', 'slice', 'members', 'usable'],
    layout.tiers.map((tier) => [
      String(tier.tier),
      tier.level,
      String(tier.partitionNumber),
      formatSize(tier.sliceBytes),
      String(tier.members.length),
      formatSize(tier.usableBytes),
    ]),
  );
  for (const row of tierRows) {
    io.stdout(`${INDENT}${row}`);
  }
  io.stdout('');
  io.stdout('Drives');
  const driveRows = formatTable(
    ['drive', 'size', 'partitions', 'unused'],
    layout.drives.map((drive) => [
      drive.id,
      formatSize(drive.sizeBytes),
      partitionSummary(layout, drive.id),
      formatSize(drive.unusedBytes),
    ]),
  );
  for (const row of driveRows) {
    io.stdout(`${INDENT}${row}`);
  }
}

export const PLAN_USAGE = `Usage: ohr plan --redundancy <shr1|shr2> [--json] <device>...
       ohr plan --redundancy <shr1|shr2> [--json] --sizes <size>,<size>,...

Shows how Open HR would lay out a new pool. Read-only: nothing is written.

Options:
  --redundancy   shr1 survives one drive failure, shr2 survives two.
  --sizes        Plan for hypothetical drives instead of real ones. Sizes need
                 a unit: 4TB and 8TB like drive labels, or 4TiB in binary units.
  --json         Print the layout as JSON.`;

export async function planCommand(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      redundancy: { type: 'string' },
      sizes: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  const redundancy = parseRedundancy(values.redundancy);
  if ((values.sizes === undefined) === (positionals.length === 0)) {
    throw new UsageError('Give either device paths or --sizes, not both.');
  }
  const drives = await chooseDrives(values.sizes, positionals, io);
  if (drives === null) {
    return EXIT_FAILURE;
  }
  const result = planPool(drives, redundancy);
  if (!result.ok) {
    io.stderr(describePlanError(result.error));
    return EXIT_FAILURE;
  }
  if (values.json) {
    io.stdout(JSON.stringify(result.layout, null, 2));
  } else {
    printLayout(io, result.layout);
  }
  return EXIT_OK;
}
