import { parseArgs } from 'node:util';

import {
  DEFAULT_MOUNT_ROOT,
  FILESYSTEMS,
  type FilesystemType,
  LVM_EXTENT_BYTES,
} from '@ohr/shared/constants';
import { isValidPoolId } from '@ohr/shared/naming';
import { alignDown, formatSize, parseSize, SizeParseError } from '@ohr/shared/sizes';
import type { VolumeCreateRequest } from '@ohr/shared/volume-create-request';
import type { VolumeGrowRequest } from '@ohr/shared/volume-grow-request';
import { isValidVolumeName } from '@ohr/shared/volume-name';

import { EXIT_FAILURE, type Io, UsageError } from '../io.ts';
import { confirmed, followJob, printSteps } from '../jobs.ts';

interface CreateOptions {
  readonly poolId: string;
  readonly name: string;
  readonly filesystem: FilesystemType;
  readonly sizeBytes: number | null;
  /** Null lets core choose the default under /mnt/ohr. */
  readonly mountPoint: string | null;
  readonly yes: boolean;
}

function parseFilesystem(value: string | undefined): FilesystemType {
  const type = FILESYSTEMS.find((candidate) => candidate === value);
  if (type === undefined) {
    throw new UsageError('Choose a filesystem with --fs btrfs or --fs ext4.');
  }
  return type;
}

/** The requested size as whole LVM extents, or null for all free space. */
function parseVolumeSize(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  let bytes: number;
  try {
    bytes = parseSize(value);
  } catch (error) {
    if (error instanceof SizeParseError) {
      throw new UsageError(error.message, { cause: error });
    }
    throw error;
  }
  const aligned = alignDown(bytes, LVM_EXTENT_BYTES);
  if (aligned <= 0) {
    throw new UsageError(`A volume needs at least ${formatSize(LVM_EXTENT_BYTES)}.`);
  }
  return aligned;
}

interface GrowOptions {
  readonly poolId: string;
  readonly name: string;
  /** How much to add, or null for all free space. */
  readonly addBytes: number | null;
  readonly yes: boolean;
}

function parseGrowOptions(args: readonly string[]): GrowOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { yes: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: true,
  });
  const [poolId, name, size, ...extra] = positionals;
  if (poolId === undefined || !isValidPoolId(poolId)) {
    throw new UsageError('Name the pool first: 1 to 8 lowercase letters or digits.');
  }
  if (name === undefined || !isValidVolumeName(name) || extra.length > 0) {
    throw new UsageError('Give the pool, the volume, and optionally how much to add.');
  }
  return { poolId, name, addBytes: parseVolumeSize(size), yes: values.yes };
}

async function growVolume(args: readonly string[], io: Io): Promise<number> {
  const options = parseGrowOptions(args);
  let size: VolumeGrowRequest['size'] = { kind: 'all-free' };
  if (options.addBytes !== null) {
    size = { kind: 'add-bytes', bytes: options.addBytes };
  }
  const core = await io.core();
  const preview = await core.call('volumes.previewGrow', {
    poolId: options.poolId,
    name: options.name,
    size,
  });
  const { input } = preview;
  let target = formatSize(preview.sizeBytes);
  if (input.size.kind === 'all-free') {
    target = `${target}, all the pool's free space`;
  }
  io.stdout(`Volume ${input.name} in pool ${input.poolId}`);
  io.stdout(`  Grows to: ${target}`);
  io.stdout(`  Filesystem: ${input.filesystem}, mounted at ${input.mountPoint}, grown online`);
  io.stdout('');
  printSteps(io, preview.steps);
  io.stdout('');
  if (!(await confirmed(io, 'volume name', input.name, options.yes))) {
    return EXIT_FAILURE;
  }
  return followJob(io, {
    subject: `Volume ${input.name}`,
    done: 'grown',
    start: async (client) =>
      (
        await client.call('jobs.submit', {
          kind: 'volume-grow',
          input,
          stateHash: preview.stateHash,
        })
      ).job,
  });
}

function parseCreateOptions(args: readonly string[]): CreateOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      pool: { type: 'string' },
      name: { type: 'string' },
      fs: { type: 'string' },
      size: { type: 'string' },
      mount: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (positionals.length > 0) {
    throw new UsageError('ohr volume create takes options only.');
  }
  if (values.pool === undefined || !isValidPoolId(values.pool)) {
    throw new UsageError('Name the pool with --pool <id>.');
  }
  if (values.name === undefined || !isValidVolumeName(values.name)) {
    throw new UsageError(
      'Name the volume with --name: 1 to 32 lowercase letters, digits, dashes, or underscores.',
    );
  }
  return {
    poolId: values.pool,
    name: values.name,
    filesystem: parseFilesystem(values.fs),
    sizeBytes: parseVolumeSize(values.size),
    mountPoint: values.mount ?? null,
    yes: values.yes,
  };
}

function request(options: CreateOptions): VolumeCreateRequest {
  let size: VolumeCreateRequest['size'] = { kind: 'all-free' };
  if (options.sizeBytes !== null) {
    size = { kind: 'bytes', bytes: options.sizeBytes };
  }
  const base = {
    poolId: options.poolId,
    name: options.name,
    filesystem: options.filesystem,
    size,
  };
  if (options.mountPoint === null) {
    return base;
  }
  return { ...base, mountPoint: options.mountPoint };
}

async function createVolume(args: readonly string[], io: Io): Promise<number> {
  const options = parseCreateOptions(args);
  const core = await io.core();
  const preview = await core.call('volumes.previewCreate', request(options));
  const { input } = preview;
  let size = formatSize(preview.sizeBytes);
  if (input.size.kind === 'all-free') {
    size = `all free space (${size})`;
  }
  io.stdout(`Volume ${input.name} in pool ${input.poolId}`);
  io.stdout(`  Filesystem: ${input.filesystem}`);
  io.stdout(`  Size: ${size}`);
  io.stdout(`  Mount point: ${input.mountPoint}`);
  io.stdout('');
  printSteps(io, preview.steps);
  io.stdout('');
  if (!(await confirmed(io, 'volume name', input.name, options.yes))) {
    return EXIT_FAILURE;
  }
  return followJob(io, {
    subject: `Volume ${input.name}`,
    start: async (client) =>
      (
        await client.call('jobs.submit', {
          kind: 'volume-create',
          input,
          stateHash: preview.stateHash,
        })
      ).job,
  });
}

export const VOLUME_USAGE = `Usage: ohr volume create --pool <id> --name <name> --fs <btrfs|ext4> [--size <size>] [--mount <path>] [--yes]
       ohr volume grow <pool> <volume> [<size to add>] [--yes]

Creates a volume in a pool: a logical volume, a filesystem on it, and a
systemd mount unit so it is mounted now and after every boot. Shows the
steps and the exact commands first and asks for the volume name before
writing anything. ohr-core runs the job; Ctrl-C stops following it but not
the job.

Options:
  --pool         The pool id.
  --name         Volume name: 1 to 32 lowercase letters, digits, dashes, or
                 underscores. It is also the filesystem label.
  --fs           btrfs or ext4.
  --size         Size with a unit, such as 500GB or 2TiB, rounded down to whole
                 4 MiB extents. Without it the volume takes all free space.
  --mount        Mount point. Default ${DEFAULT_MOUNT_ROOT}/<name>.
  --yes          Skip the confirmation.

volume grow makes a mounted volume larger and grows its filesystem while it
stays mounted and in use: by the size given, such as 100GB, rounded down to
whole 4 MiB extents, or by all the pool's free space. Volumes never shrink.`;

export function volumeCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'create') {
    return createVolume(rest, io);
  }
  if (subcommand === 'grow') {
    return growVolume(rest, io);
  }
  return Promise.reject(new UsageError(`Unknown volume command: ${subcommand ?? '(none)'}`));
}
