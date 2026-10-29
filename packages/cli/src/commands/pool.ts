import { parseArgs } from 'node:util';

import type { Result } from '@ohr/rpc/contract';
import { RpcError } from '@ohr/rpc/rpc-error';
import type { Redundancy } from '@ohr/shared/constants';
import { isValidPoolId } from '@ohr/shared/naming';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import { EXIT_FAILURE, type Io, UsageError } from '../io.ts';
import { confirmed, followJob, printSteps } from '../jobs.ts';
import { printLayout } from './plan.ts';

const REDUNDANCY_LEVELS: readonly Redundancy[] = ['shr1', 'shr2'];
/** Part of core's reason for a drive that holds something. */
const WIPE_HINT_TRIGGER = 'wiped first';

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

Creates a pool on the given drives: partitions them, builds one md array per
tier, and puts the arrays in one volume group. Shows the plan and the exact
commands first and asks for the pool id before writing anything. ohr-core
runs the job; Ctrl-C stops following it but not the job.

Options:
  --id           Pool id, 1 to 8 lowercase letters or digits. Names the volume
                 group ohr-<id> and the arrays ohr_<id>_t<n>.
  --redundancy   shr1 survives one drive failure, shr2 survives two.
  --wipe         Erase drives that hold partitions, a filesystem, or a pool.
  --yes          Skip the confirmation.`;

export function poolCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'create') {
    return createPool(rest, io);
  }
  return Promise.reject(new UsageError(`Unknown pool command: ${subcommand ?? '(none)'}`));
}
