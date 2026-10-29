import { parseArgs } from 'node:util';

import type { JobDefinition } from '@ohr/core/jobs/engine';
import { buildPoolCreateJob } from '@ohr/core/jobs/pool-create';
import { previewPoolCreate } from '@ohr/core/jobs/pool-create-preview';
import { readLoopDrives, readSystemState } from '@ohr/core/system-state';
import { DEFAULT_DATABASE_PATH, type Redundancy } from '@ohr/shared/constants';
import { isValidPoolId } from '@ohr/shared/naming';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import { EXIT_FAILURE, type Io, UsageError } from '../io.ts';
import { confirmed, printSteps, runConfirmedJob } from '../jobs.ts';
import { printLayout } from './plan.ts';

const REDUNDANCY_LEVELS: readonly Redundancy[] = ['shr1', 'shr2'];
/** Part of core's reason for a drive that holds something. */
const WIPE_HINT_TRIGGER = 'wiped first';

interface CreateOptions {
  readonly poolId: string;
  readonly redundancy: Redundancy;
  readonly wipe: boolean;
  readonly allowLoop: boolean;
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
      'allow-loop': { type: 'boolean', default: false },
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
    allowLoop: values['allow-loop'],
    yes: values.yes,
    database: values.database,
    devices: positionals,
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
  const candidates = [...snapshot.drives];
  if (options.allowLoop) {
    candidates.push(...(await readLoopDrives(io.run)));
  }
  const preview = previewPoolCreate(
    {
      poolId: options.poolId,
      redundancy: options.redundancy,
      devices: [...options.devices],
      wipe: options.wipe,
    },
    snapshot,
    candidates,
  );
  if (!preview.ok) {
    for (const reason of preview.reasons) {
      io.stderr(reason);
    }
    if (!options.wipe && preview.reasons.some((reason) => reason.includes(WIPE_HINT_TRIGGER))) {
      io.stderr('Pass --wipe to erase drives that hold something.');
    }
    return EXIT_FAILURE;
  }
  const input = preview.value;
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
  --allow-loop   Also accept loop devices. For testing only: a pool on loop
                 devices does not come back after a reboot by itself.
  --yes          Skip the confirmation.
  --database     Job database path, for testing. Default ${DEFAULT_DATABASE_PATH}.`;

export function poolCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'create') {
    return createPool(rest, io);
  }
  return Promise.reject(new UsageError(`Unknown pool command: ${subcommand ?? '(none)'}`));
}
