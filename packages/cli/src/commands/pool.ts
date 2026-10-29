import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { type JobEvent, previewJob, runJob, submitJob } from '@ohr/core/jobs/engine';
import { JobConflictError } from '@ohr/core/jobs/job-conflict-error';
import { buildPoolCreateJob } from '@ohr/core/jobs/pool-create';
import { systemStateHash } from '@ohr/core/jobs/state-hash';
import { JobStore } from '@ohr/core/jobs/store';
import { type DriveState, readSystemState, type SystemSnapshot } from '@ohr/core/system-state';
import { DEFAULT_DATABASE_PATH, type Redundancy } from '@ohr/shared/constants';
import type { JobRecord } from '@ohr/shared/jobs';
import { isValidPoolId, mdArrayName, volumeGroupName } from '@ohr/shared/naming';
import { describePlanError, planPool } from '@ohr/shared/planner';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import { EXIT_FAILURE, EXIT_OK, type Io, UsageError } from '../io.ts';
import { printLayout } from './plan.ts';

const REDUNDANCY_LEVELS: readonly Redundancy[] = ['shr1', 'shr2'];
const INDENT = '  ';

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

function printPreview(
  io: Io,
  input: PoolCreateInput,
  steps: readonly { name: string; commands: readonly string[] }[],
): void {
  io.stdout(`Pool ${input.poolId}`);
  printLayout(io, input.layout);
  io.stdout('');
  io.stdout('Steps');
  for (const [index, step] of steps.entries()) {
    io.stdout(`${INDENT}${index + 1}. ${step.name}`);
    for (const command of step.commands) {
      io.stdout(`${INDENT}${INDENT}${command}`);
    }
  }
  io.stdout('');
  const erased = input.drives.map((drive) => drive.path).join(', ');
  io.stdout(`This erases everything on ${erased}.`);
}

function progressLine(event: JobEvent, total: number): string | null {
  if (event.kind === 'step') {
    if (event.status === 'running') {
      return `[${event.index + 1}/${total}] ${event.name}`;
    }
    if (event.status === 'failed') {
      return `[${event.index + 1}/${total}] ${event.name}: failed: ${event.error ?? ''}`;
    }
    return `[${event.index + 1}/${total}] ${event.name}: ${event.status}`;
  }
  if (event.kind === 'log') {
    return `${INDENT}${event.line}`;
  }
  return null;
}

function reportOutcome(io: Io, job: JobRecord): number {
  if (job.status === 'done') {
    io.stdout(`Pool ${job.poolId} created. Job ${job.id}.`);
    return EXIT_OK;
  }
  io.stderr(`Pool ${job.poolId} was not created: ${job.error ?? job.status}. Job ${job.id}.`);
  io.stderr('Nothing was undone. Fix the cause and run the same command again to resume.');
  return EXIT_FAILURE;
}

async function createPool(args: readonly string[], io: Io): Promise<number> {
  const options = parseCreateOptions(args);
  if (!io.isRoot()) {
    io.stderr('Creating a pool changes drives, so it needs root. Run with sudo.');
    return EXIT_FAILURE;
  }
  const snapshotOptions = { run: io.run, readFile: io.readFile, includeSmart: false };
  const snapshot = await readSystemState(snapshotOptions);
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
  const preview = previewJob(definition);
  printPreview(io, input, preview.steps);
  if (!options.yes) {
    const typed = await io.confirm(`Type the pool id (${input.poolId}) to continue: `);
    if (typed.trim() !== input.poolId) {
      io.stderr('Cancelled. Nothing was changed.');
      return EXIT_FAILURE;
    }
  }
  await mkdir(dirname(options.database), { recursive: true });
  const store = JobStore.open(options.database);
  try {
    let job: JobRecord;
    try {
      job = submitJob(store, definition, systemStateHash(snapshot));
    } catch (error) {
      if (error instanceof JobConflictError) {
        io.stderr(error.message);
        return EXIT_FAILURE;
      }
      throw error;
    }
    const total = preview.steps.length;
    const finished = await runJob(store, definition, job.id, {
      run: io.run,
      stateHash: systemStateHash(await readSystemState(snapshotOptions)),
      listener: (event) => {
        const line = progressLine(event, total);
        if (line !== null) {
          io.stdout(line);
        }
      },
    });
    return reportOutcome(io, finished);
  } finally {
    store.close();
  }
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
