import { parseArgs } from 'node:util';

import { assertMountPoint, defaultMountPoint } from '@ohr/core/executors/mount';
import { buildVolumeCreateJob } from '@ohr/core/jobs/volume-create';
import { readSystemState } from '@ohr/core/system-state';
import {
  DEFAULT_DATABASE_PATH,
  FILESYSTEMS,
  type FilesystemType,
  LVM_EXTENT_BYTES,
} from '@ohr/shared/constants';
import { isValidPoolId, volumeGroupName } from '@ohr/shared/naming';
import { alignDown, formatSize, parseSize, SizeParseError } from '@ohr/shared/sizes';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';
import type { VolumeCreateInput } from '@ohr/shared/volume-create-input';
import { isValidVolumeName } from '@ohr/shared/volume-name';

import { EXIT_FAILURE, type Io, UsageError } from '../io.ts';
import { confirmed, printSteps, runConfirmedJob } from '../jobs.ts';

interface CreateOptions {
  readonly poolId: string;
  readonly name: string;
  readonly filesystem: FilesystemType;
  readonly sizeBytes: number | null;
  readonly mountPoint: string;
  readonly yes: boolean;
  readonly database: string;
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
      database: { type: 'string', default: DEFAULT_DATABASE_PATH },
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
  const mountPoint = values.mount ?? defaultMountPoint(values.name);
  try {
    assertMountPoint(mountPoint);
  } catch (error) {
    throw new UsageError(`--mount must be an absolute directory path, got "${mountPoint}".`, {
      cause: error,
    });
  }
  return {
    poolId: values.pool,
    name: values.name,
    filesystem: parseFilesystem(values.fs),
    sizeBytes: parseVolumeSize(values.size),
    mountPoint,
    yes: values.yes,
    database: values.database,
  };
}

/** What stops the volume from being created, or nothing. */
function problems(options: CreateOptions, snapshot: SystemSnapshot): string[] {
  const found: string[] = [];
  const groupName = volumeGroupName(options.poolId);
  const group = snapshot.volumeGroups.find((candidate) => candidate.name === groupName);
  if (group === undefined) {
    found.push(
      `There is no pool ${options.poolId} on this machine (no volume group ${groupName}).`,
    );
    return found;
  }
  if (
    snapshot.logicalVolumes.some(
      (volume) => volume.volumeGroup === groupName && volume.name === options.name,
    )
  ) {
    found.push(`Pool ${options.poolId} already has a volume named ${options.name}.`);
  }
  if (options.sizeBytes === null && group.freeBytes <= 0) {
    found.push(`Pool ${options.poolId} has no free space.`);
  } else if (options.sizeBytes !== null && options.sizeBytes > group.freeBytes) {
    found.push(
      `Pool ${options.poolId} has ${formatSize(group.freeBytes)} free, less than the ${formatSize(options.sizeBytes)} asked for.`,
    );
  }
  if (snapshot.mounts.some((mount) => mount.target === options.mountPoint)) {
    found.push(`${options.mountPoint} already has something mounted on it.`);
  }
  return found;
}

function describeSize(options: CreateOptions, snapshot: SystemSnapshot): string {
  if (options.sizeBytes !== null) {
    return formatSize(options.sizeBytes);
  }
  const group = snapshot.volumeGroups.find(
    (candidate) => candidate.name === volumeGroupName(options.poolId),
  );
  return `all free space (${formatSize(group?.freeBytes ?? 0)})`;
}

async function createVolume(args: readonly string[], io: Io): Promise<number> {
  const options = parseCreateOptions(args);
  if (!io.isRoot()) {
    io.stderr('Creating a volume changes the pool, so it needs root. Run with sudo.');
    return EXIT_FAILURE;
  }
  const snapshot = await readSystemState({
    run: io.run,
    readFile: io.readFile,
    includeSmart: false,
  });
  const found = problems(options, snapshot);
  for (const problem of found) {
    io.stderr(problem);
  }
  if (found.length > 0) {
    return EXIT_FAILURE;
  }
  let size: VolumeCreateInput['size'] = { kind: 'all-free' };
  if (options.sizeBytes !== null) {
    size = { kind: 'bytes', bytes: options.sizeBytes };
  }
  const input: VolumeCreateInput = {
    poolId: options.poolId,
    name: options.name,
    filesystem: options.filesystem,
    size,
    mountPoint: options.mountPoint,
  };
  const definition = buildVolumeCreateJob(input);
  io.stdout(`Volume ${input.name} in pool ${input.poolId}`);
  io.stdout(`  Filesystem: ${input.filesystem}`);
  io.stdout(`  Size: ${describeSize(options, snapshot)}`);
  io.stdout(`  Mount point: ${input.mountPoint}`);
  io.stdout('');
  printSteps(io, definition);
  io.stdout('');
  if (!(await confirmed(io, 'volume name', input.name, options.yes))) {
    return EXIT_FAILURE;
  }
  return runConfirmedJob(io, {
    definition,
    snapshot,
    database: options.database,
    subject: `Volume ${input.name}`,
  });
}

export const VOLUME_USAGE = `Usage: ohr volume create --pool <id> --name <name> --fs <btrfs|ext4> [--size <size>] [--mount <path>] [--yes]

Creates a volume in a pool: a logical volume, a filesystem on it, and a
systemd mount unit so it is mounted now and after every boot. Shows the
steps and the exact commands first and asks for the volume name before
writing anything. Needs root.

Options:
  --pool         The pool id.
  --name         Volume name: 1 to 32 lowercase letters, digits, dashes, or
                 underscores. It is also the filesystem label.
  --fs           btrfs or ext4.
  --size         Size with a unit, such as 500GB or 2TiB, rounded down to whole
                 4 MiB extents. Without it the volume takes all free space.
  --mount        Mount point. Default ${'/mnt/ohr/<name>'}.
  --yes          Skip the confirmation.
  --database     Job database path, for testing. Default ${DEFAULT_DATABASE_PATH}.`;

export function volumeCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'create') {
    return createVolume(rest, io);
  }
  return Promise.reject(new UsageError(`Unknown volume command: ${subcommand ?? '(none)'}`));
}
