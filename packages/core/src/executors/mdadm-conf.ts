/**
 * Keeps one mdadm config file per pool in /etc/mdadm/mdadm.conf.d, which
 * mdadm reads after the main file (decision 0005). The main file, which
 * Debian generates and the user may edit, is never touched. The file lists
 * the pool's arrays the way `mdadm --detail --scan` prints them, so
 * `mdadm --assemble --scan` can rebuild the pool from it by hand.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assertPoolId } from '@ohr/shared/naming';
import { type MdArrayDefinition, parseMdadmScan } from '@ohr/shared/parsers/mdadm-scan';

import { type CommandRunner, runChecked } from '../command-runner.ts';
import { singleRow } from './single-row.ts';

const DEFAULT_CONF_DIR = '/etc/mdadm/mdadm.conf.d';
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

function arrayLine(definition: MdArrayDefinition): string {
  if (definition.metadata === null) {
    return `ARRAY ${definition.device} UUID=${definition.uuid}`;
  }
  return `ARRAY ${definition.device} metadata=${definition.metadata} UUID=${definition.uuid}`;
}

export interface MdadmConfOptions {
  /** Where the per-pool files live. The default is the system directory. */
  readonly confDir?: string | undefined;
}

/** Path of a pool's config file. */
export function mdadmConfPath(poolId: string, options: MdadmConfOptions = {}): string {
  assertPoolId(poolId);
  return join(options.confDir ?? DEFAULT_CONF_DIR, `ohr-${poolId}.conf`);
}

/** The ARRAY line mdadm prints for one array. */
export async function arrayDefinition(
  run: CommandRunner,
  arrayPath: string,
): Promise<MdArrayDefinition> {
  const scan = await runChecked(run, 'mdadm', ['--detail', '--scan', arrayPath]);
  return singleRow(parseMdadmScan(scan), 'array');
}

/** The config file's text: a header and one ARRAY line per tier. */
export function renderMdadmConf(poolId: string, definitions: readonly MdArrayDefinition[]): string {
  assertPoolId(poolId);
  const lines = [
    `# Open Hybrid RAID pool ${poolId}. Written by ohr; edits are overwritten.`,
    '# To assemble by hand: mdadm --assemble --scan',
    ...definitions.map(arrayLine),
  ];
  return `${lines.join('\n')}\n`;
}

/** Writes the pool's config file, replacing any earlier one in one step. Returns its path. */
export async function writeMdadmConf(
  poolId: string,
  definitions: readonly MdArrayDefinition[],
  options: MdadmConfOptions = {},
): Promise<string> {
  const path = mdadmConfPath(poolId, options);
  const text = renderMdadmConf(poolId, definitions);
  await mkdir(options.confDir ?? DEFAULT_CONF_DIR, { recursive: true, mode: DIR_MODE });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, { mode: FILE_MODE });
  await rename(temporary, path);
  return path;
}

/** Removes the pool's config file. Nothing happens if it is already gone. */
export async function removeMdadmConf(
  poolId: string,
  options: MdadmConfOptions = {},
): Promise<void> {
  await rm(mdadmConfPath(poolId, options), { force: true });
}
