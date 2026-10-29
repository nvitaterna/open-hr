/** Loop devices for integration tests. Not part of the package API. Needs root. */

import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runChecked, runCommand } from './command-runner.ts';

/**
 * Disk-backed scratch space. /tmp is often RAM (tmpfs), and arrays that
 * resync while a test runs would fill it.
 */
const SCRATCH_ROOT = '/var/tmp';

export interface LoopDevices {
  /** Device paths, in the order of the sizes given. */
  readonly paths: readonly string[];
  /** Scratch directory holding the backing files; tests may put mount points here. */
  readonly dir: string;
  /** Detaches the devices and deletes the directory. */
  readonly detach: () => Promise<void>;
}

/** Sparse files of the given sizes, attached one at a time because losetup --find races. */
export async function attachLoopDevices(
  prefix: string,
  sizes: readonly number[],
): Promise<LoopDevices> {
  const dir = await mkdtemp(join(SCRATCH_ROOT, `${prefix}-`));
  const paths: string[] = [];
  for (const [index, size] of sizes.entries()) {
    const file = join(dir, `drive${index}.img`);
    await writeFile(file, '');
    await truncate(file, size);
    const loop = await runChecked(runCommand, 'losetup', ['--find', '--partscan', '--show', file]);
    paths.push(loop.trim());
  }
  return {
    paths,
    dir,
    detach: async () => {
      await Promise.all(paths.map((path) => runCommand('losetup', ['--detach', path])));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
