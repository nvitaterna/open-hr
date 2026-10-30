import { parseArgs } from 'node:util';

import type { Params, Result } from '@ohr/rpc/contract';
import { RpcError } from '@ohr/rpc/rpc-error';
import type { Redundancy } from '@ohr/shared/constants';
import { isValidPoolId } from '@ohr/shared/naming';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';
import type { PoolExpandInput } from '@ohr/shared/pool-expand-input';
import { formatSize } from '@ohr/shared/sizes';
import { isValidVolumeName } from '@ohr/shared/volume-name';

import { EXIT_FAILURE, type Io, UsageError } from '../io.ts';
import { confirmed, followJob, printRefusal, printSteps, WIPE_HINT_TRIGGER } from '../jobs.ts';
import { printLayout } from './plan.ts';

const REDUNDANCY_LEVELS: readonly Redundancy[] = ['shr1', 'shr2'];

interface ExpandOptions {
  readonly poolId: string;
  readonly wipe: boolean;
  readonly yes: boolean;
  readonly devices: readonly string[];
  /** A volume to grow into the new space, or null. */
  readonly growVolume: string | null;
}

interface CreateOptions {
  readonly poolId: string;
  readonly redundancy: Redundancy;
  readonly wipe: boolean;
  readonly yes: boolean;
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
    devices: positionals,
  };
}

/** Options for pool add (devices required) and pool expand (no devices). */
function parseExpandOptions(args: readonly string[], withDevices: boolean): ExpandOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      wipe: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      grow: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });
  const [poolId, ...devices] = positionals;
  if (values.grow !== undefined && !isValidVolumeName(values.grow)) {
    throw new UsageError('Name the volume to grow with --grow <volume>.');
  }
  if (poolId === undefined || !isValidPoolId(poolId)) {
    throw new UsageError('Name the pool first: 1 to 8 lowercase letters or digits.');
  }
  if (withDevices && devices.length === 0) {
    throw new UsageError('Give the device paths of the drives to add.');
  }
  if (!withDevices && (devices.length > 0 || values.wipe)) {
    throw new UsageError('ohr pool expand takes only the pool. Add drives with ohr pool add.');
  }
  return {
    poolId,
    wipe: values.wipe,
    yes: values.yes,
    devices,
    growVolume: values.grow ?? null,
  };
}

function printExpandPreview(
  io: Io,
  input: PoolExpandInput,
  steps: Parameters<typeof printSteps>[1],
): void {
  const before = formatSize(input.usableBytesBefore);
  const after = formatSize(input.target.usableBytes);
  io.stdout(`Pool ${input.poolId}: ${before} usable now, ${after} after`);
  printLayout(io, input.target);
  io.stdout('');
  printSteps(io, steps);
  io.stdout('');
  if (input.newDrives.length > 0) {
    io.stdout(
      `This erases everything on ${input.newDrives.map((drive) => drive.path).join(', ')}.`,
    );
  }
  if (input.growVolume !== null && input.growVolume !== undefined) {
    io.stdout(`Volume ${input.growVolume.name} then grows into all the new space, online.`);
  }
  io.stdout(
    'Reshaping keeps the pool and its volumes online, but can take hours or days on large drives.',
  );
}

async function expandPool(args: readonly string[], io: Io, withDevices: boolean): Promise<number> {
  const options = parseExpandOptions(args, withDevices);
  const core = await io.core();
  let preview: Result<'pools.previewExpand'>;
  try {
    const request: Params<'pools.previewExpand'> = {
      poolId: options.poolId,
      devices: [...options.devices],
      wipe: options.wipe,
    };
    if (options.growVolume !== null) {
      request.growVolume = options.growVolume;
    }
    preview = await core.call('pools.previewExpand', request);
  } catch (error) {
    if (error instanceof RpcError && error.code === 'rejected') {
      printRefusal(io, error, options.wipe);
      return EXIT_FAILURE;
    }
    throw error;
  }
  printExpandPreview(io, preview.input, preview.steps);
  if (!(await confirmed(io, 'pool id', preview.input.poolId, options.yes))) {
    return EXIT_FAILURE;
  }
  return followJob(io, {
    subject: `Pool ${preview.input.poolId}`,
    done: 'grown',
    start: async (client) =>
      (
        await client.call('jobs.submit', {
          kind: 'pool-expand',
          input: preview.input,
          stateHash: preview.stateHash,
        })
      ).job,
  });
}

function printPreview(
  io: Io,
  input: PoolCreateInput,
  steps: Parameters<typeof printSteps>[1],
): void {
  io.stdout(`Pool ${input.poolId}`);
  printLayout(io, input.layout);
  io.stdout('');
  printSteps(io, steps);
  io.stdout('');
  const erased = input.drives.map((drive) => drive.path).join(', ');
  io.stdout(`This erases everything on ${erased}.`);
}

async function createPool(args: readonly string[], io: Io): Promise<number> {
  const options = parseCreateOptions(args);
  const core = await io.core();
  let preview: Result<'pools.previewCreate'>;
  try {
    preview = await core.call('pools.previewCreate', {
      poolId: options.poolId,
      redundancy: options.redundancy,
      devices: [...options.devices],
      wipe: options.wipe,
    });
  } catch (error) {
    if (
      error instanceof RpcError &&
      !options.wipe &&
      error.reasons.some((reason) => reason.includes(WIPE_HINT_TRIGGER))
    ) {
      for (const reason of error.reasons) {
        io.stderr(reason);
      }
      io.stderr('Pass --wipe to erase drives that hold something.');
      return EXIT_FAILURE;
    }
    throw error;
  }
  printPreview(io, preview.input, preview.steps);
  if (!(await confirmed(io, 'pool id', preview.input.poolId, options.yes))) {
    return EXIT_FAILURE;
  }
  return followJob(io, {
    subject: `Pool ${preview.input.poolId}`,
    start: async (client) =>
      (
        await client.call('jobs.submit', {
          kind: 'pool-create',
          input: preview.input,
          stateHash: preview.stateHash,
        })
      ).job,
  });
}

export const POOL_USAGE = `Usage: ohr pool create --id <pool> --redundancy <shr1|shr2> [--wipe] [--yes] <device>...
       ohr pool add <pool> [--wipe] [--grow <volume>] [--yes] <device>...
       ohr pool expand <pool> [--grow <volume>] [--yes]

Creates a pool on the given drives: partitions them, builds one md array per
tier, and puts the arrays in one volume group. Shows the plan and the exact
commands first and asks for the pool id before writing anything. ohr-core
runs the job; Ctrl-C stops following it but not the job.

Options:
  --id           Pool id, 1 to 8 lowercase letters or digits. Names the volume
                 group ohr-<id> and the arrays ohr_<id>_t<n>.
  --redundancy   shr1 survives one drive failure, shr2 survives two.
  --wipe         Erase drives that hold partitions, a filesystem, or a pool.
  --yes          Skip the confirmation.

pool add puts more drives in a pool: it partitions and labels them, adds
them to the tiers they have room for, reshapes those tiers, and builds new
tiers from space that two or more drives share. A two-member RAID1 tier
becomes RAID5. pool expand does the same with the space the pool's drives
already have, for example after a larger drive replaced a smaller one.
Both show the capacity before and after and the exact commands first, and
ask for the pool id. The pool stays online throughout. Volumes do not grow
by themselves: --grow <volume> grows one mounted volume into all the new
space at the end, or grow one later with ohr volume grow.`;

export function poolCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'create') {
    return createPool(rest, io);
  }
  if (subcommand === 'add') {
    return expandPool(rest, io, true);
  }
  if (subcommand === 'expand') {
    return expandPool(rest, io, false);
  }
  return Promise.reject(new UsageError(`Unknown pool command: ${subcommand ?? '(none)'}`));
}
