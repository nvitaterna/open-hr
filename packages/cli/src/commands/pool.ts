import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import type { JobDefinition } from '@ohr/core/jobs/engine';
import { buildPoolCreateJob } from '@ohr/core/jobs/pool-create';
import { type DriveState, readSystemState, type SystemSnapshot } from '@ohr/core/system-state';
import { DEFAULT_DATABASE_PATH, type Redundancy } from '@ohr/shared/constants';
import { isValidPoolId, mdArrayName, volumeGroupName } from '@ohr/shared/naming';
import { describePlanError, planPool } from '@ohr/shared/planner';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import { EXIT_FAILURE, type Io, UsageError } from '../io.ts';
import { confirmed, printSteps, runConfirmedJob } from '../jobs.ts';
import { printLayout } from './plan.ts';

const REDUNDANCY_LEVELS: readonly Redundancy[] = ['shr1', 'shr2'];

interface CreateOptions {
  readonly poolId: string;
  readonly redundancy: Redundancy;
  readonly wipe: boolean;
  readonly yes: boolean;
  readonly database: string;
  readonly devices: readonly string[];
}

function parseRedundancy(value: string | undefined): Redundancy {
  const level = REDUNDANCY_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new UsageError('Choose a redundancy level with --redundancy shr1 or --redundancy shr2.');
  }
  return level;
}

function parseCreateOptions(args: readonly string[]): CreateOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      redundancy: { type: 'string' },
      id: { type: 'string' },
      wipe: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      database: { type: 'string', default: DEFAULT_DATABASE_PATH },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.id === undefined || !isValidPoolId(values.id)) {
    throw new UsageError('Give the pool a name with --id: 1 to 8 lowercase letters or digits.');
  }
  if (positionals.length === 0) {
    throw new UsageError('Give the device paths of the drives to use.');
  }
  return {
    poolId: values.id,
    redundancy: parseRedundancy(values.redundancy),
    wipe: values.wipe,
    yes: values.yes,
    database: values.database,
    devices: positionals,
  };
}

/** What stops the pool from being created on these drives, or nothing. */
function driveProblems(options: CreateOptions, snapshot: SystemSnapshot): string[] {
  const problems: string[] = [];
  const known = new Map(snapshot.drives.map((drive) => [drive.device.path, drive]));
  for (const path of options.devices) {
    const drive = known.get(path);
    if (drive === undefined) {
      problems.push(`${path} is not a physical drive on this machine.`);
    } else if (drive.role === 'system') {
      problems.push(`${path} holds the operating system. Open HR never uses it.`);
    } else if (drive.role !== 'empty' && !options.wipe) {
      problems.push(`${path} is not empty (${describeContents(drive)}). Pass --wipe to erase it.`);
    }
  }
  const group = volumeGroupName(options.poolId);
  if (snapshot.volumeGroups.some((candidate) => candidate.name === group)) {
    problems.push(`Volume group ${group} already exists. Choose another pool id.`);
  }
  const arrayPrefix = `${mdArrayName(options.poolId, 1).slice(0, -1)}`;
  if (snapshot.mdArrays.some((array) => array.detail?.devName?.startsWith(arrayPrefix) === true)) {
    problems.push(`Arrays named ${arrayPrefix}* already exist. Choose another pool id.`);
  }
  return problems;
}

function describeContents(drive: DriveState): string {
  const { device } = drive;
  if (drive.role === 'ohr') {
    return 'an Open HR pool';
  }
  if (device.children.length > 0) {
    return `${device.children.length} partitions`;
  }
  return device.fsType ?? 'a signature';
}

function buildInput(options: CreateOptions, snapshot: SystemSnapshot): PoolCreateInput | string {
  const drives = options.devices.map((path) => {
    const drive = snapshot.drives.find((candidate) => candidate.device.path === path);
    if (drive === undefined) {
      throw new Error(`${path} vanished`);
    }
    return drive;
  });
  const plan = planPool(
    drives.map((drive) => ({ id: drive.device.path, sizeBytes: drive.device.sizeBytes })),
    options.redundancy,
  );
  if (!plan.ok) {
    return describePlanError(plan.error);
  }
  return {
    poolId: options.poolId,
    poolUuid: randomUUID(),
    redundancy: options.redundancy,
    wipe: options.wipe,
    drives: drives.map((drive) => ({
      path: drive.device.path,
      serial: drive.device.serial,
      wwn: drive.device.wwn,
      sizeBytes: drive.device.sizeBytes,
      driveUuid: randomUUID(),
    })),
    layout: plan.layout,
  };
}

function printPreview(io: Io, input: PoolCreateInput, definition: JobDefinition): void {
  io.stdout(`Pool ${input.poolId}`);
  printLayout(io, input.layout);
  io.stdout('');
  printSteps(io, definition);
  io.stdout('');
  const erased = input.drives.map((drive) => drive.path).join(', ');
  io.stdout(`This erases everything on ${erased}.`);
}

async function createPool(args: readonly string[], io: Io): Promise<number> {
  const options = parseCreateOptions(args);
  if (!io.isRoot()) {
    io.stderr('Creating a pool changes drives, so it needs root. Run with sudo.');
    return EXIT_FAILURE;
  }
  const snapshot = await readSystemState({
    run: io.run,
    readFile: io.readFile,
    includeSmart: false,
  });
  const problems = driveProblems(options, snapshot);
  for (const problem of problems) {
    io.stderr(problem);
  }
  if (problems.length > 0) {
    return EXIT_FAILURE;
  }
  const input = buildInput(options, snapshot);
  if (typeof input === 'string') {
    io.stderr(input);
    return EXIT_FAILURE;
  }
  const definition = buildPoolCreateJob(input);
  printPreview(io, input, definition);
  if (!(await confirmed(io, 'pool id', input.poolId, options.yes))) {
    return EXIT_FAILURE;
  }
  return runConfirmedJob(io, {
    definition,
    snapshot,
    database: options.database,
    subject: `Pool ${input.poolId}`,
  });
}

export const POOL_USAGE = `Usage: ohr pool create --id <pool> --redundancy <shr1|shr2> [--wipe] [--yes] <device>...

Creates a pool on the given drives: partitions them, builds one md array per
tier, and puts the arrays in one volume group. Shows the plan and the exact
commands first and asks for the pool id before writing anything. Needs root.

Options:
  --id           Pool id, 1 to 8 lowercase letters or digits. Names the volume
                 group ohr-<id> and the arrays ohr_<id>_t<n>.
  --redundancy   shr1 survives one drive failure, shr2 survives two.
  --wipe         Erase drives that hold partitions, a filesystem, or a pool.
  --yes          Skip the confirmation.
  --database     Job database path, for testing. Default ${DEFAULT_DATABASE_PATH}.`;

export function poolCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'create') {
    return createPool(rest, io);
  }
  return Promise.reject(new UsageError(`Unknown pool command: ${subcommand ?? '(none)'}`));
}
