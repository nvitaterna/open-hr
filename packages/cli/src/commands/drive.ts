import { parseArgs } from 'node:util';

import type { Result } from '@ohr/rpc/contract';
import { RpcError } from '@ohr/rpc/rpc-error';
import type { DriveReplaceInput } from '@ohr/shared/drive-replace-input';
import { isValidPoolId } from '@ohr/shared/naming';

import { EXIT_FAILURE, type Io, UsageError } from '../io.ts';
import { confirmed, followJob, printRefusal, printSteps } from '../jobs.ts';

/** What the user types for the old drive when it is gone from the machine. */
const MISSING = 'missing';

interface ReplaceOptions {
  readonly poolId: string;
  readonly oldDrive: string | null;
  readonly newDrive: string;
  readonly wipe: boolean;
  readonly yes: boolean;
}

function parseReplaceOptions(args: readonly string[]): ReplaceOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      wipe: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  const [poolId, oldDrive, newDrive, ...extra] = positionals;
  if (poolId === undefined || !isValidPoolId(poolId)) {
    throw new UsageError('Name the pool first: 1 to 8 lowercase letters or digits.');
  }
  if (oldDrive === undefined || newDrive === undefined || extra.length > 0) {
    throw new UsageError(`Give the drive to replace, or ${MISSING}, and then the new drive.`);
  }
  let old: string | null = oldDrive;
  if (oldDrive === MISSING) {
    old = null;
  }
  return { poolId, oldDrive: old, newDrive, wipe: values.wipe, yes: values.yes };
}

function printPreview(
  io: Io,
  input: DriveReplaceInput,
  steps: Parameters<typeof printSteps>[1],
): void {
  const newDrive = input.newDrives[0]?.path ?? '';
  const oldDrive = input.oldDrive ?? 'the missing drive';
  io.stdout(`Pool ${input.poolId}: replace ${oldDrive} with ${newDrive}`);
  for (const action of input.actions) {
    if (action.kind === 'replace-member') {
      let how = 'rebuilt, because the old member has failed or is gone';
      if (action.mode === 'live') {
        how = 'copied while the old member keeps working, so the tier stays redundant';
      }
      io.stdout(`  Tier ${action.tier}: ${how}`);
    }
  }
  io.stdout('');
  printSteps(io, steps);
  io.stdout('');
  io.stdout(`This erases everything on ${newDrive}.`);
  if (input.oldDrive !== null) {
    io.stdout(
      `${input.oldDrive} is not erased. Afterwards it is no longer in the pool and can be taken out.`,
    );
  }
  io.stdout('Rebuilding and copying keep the pool online, but can take hours on large drives.');
}

async function replaceDrive(args: readonly string[], io: Io): Promise<number> {
  const options = parseReplaceOptions(args);
  const core = await io.core();
  let preview: Result<'drives.previewReplace'>;
  try {
    preview = await core.call('drives.previewReplace', {
      poolId: options.poolId,
      oldDrive: options.oldDrive,
      newDrive: options.newDrive,
      wipe: options.wipe,
    });
  } catch (error) {
    if (error instanceof RpcError && error.code === 'rejected') {
      printRefusal(io, error, options.wipe);
      return EXIT_FAILURE;
    }
    throw error;
  }
  printPreview(io, preview.input, preview.steps);
  if (!(await confirmed(io, 'pool id', preview.input.poolId, options.yes))) {
    return EXIT_FAILURE;
  }
  return followJob(io, {
    subject: `The drive in pool ${preview.input.poolId}`,
    done: 'replaced',
    start: async (client) =>
      (
        await client.call('jobs.submit', {
          kind: 'drive-replace',
          input: preview.input,
          stateHash: preview.stateHash,
        })
      ).job,
  });
}

export const DRIVE_USAGE = `Usage: ohr drive replace <pool> <old-drive|missing> <new-drive> [--wipe] [--yes]

Replaces one drive of a pool with a new drive that has room for every tier
the old one was in. Where the old drive still works, each tier is copied
onto the new drive while the old one stays in it, so the pool keeps its
redundancy. Where it has failed, or is gone (give missing), the tier is
rebuilt onto the new drive. The old drive is not erased; afterwards it is no
longer in the pool. Shows the plan and the exact commands first and asks
for the pool id. A larger new drive's extra space is used by ohr pool expand.

Options:
  --wipe   Erase the new drive if it holds partitions, a filesystem, or a pool.
  --yes    Skip the confirmation.`;

export function driveCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'replace') {
    return replaceDrive(rest, io);
  }
  return Promise.reject(new UsageError(`Unknown drive command: ${subcommand ?? '(none)'}`));
}
