/**
 * One native systemd mount unit per volume, so volumes come back after a
 * reboot (decision 0005). The unit is wanted, not required, by
 * multi-user.target: a missing pool fails its unit and boot carries on,
 * which is what `nofail` means in fstab.
 */

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FilesystemType } from '@ohr/shared/constants';
import { assertPoolId } from '@ohr/shared/naming';
import { assertVolumeName } from '@ohr/shared/volume-name';

import { type CommandRunner, runChecked } from '../command-runner.ts';
import { assertMountPoint, mountOptions } from './mount.ts';

/** Characters systemd keeps as they are in a unit name, besides '/' which becomes '-'. */
const SAFE_CHAR = /[A-Za-z0-9:_.]/u;
const SLASH = 0x2f;
const ASCII_LIMIT = 0x80;
const HEX = 16;
const HEX_WIDTH = 2;
const EDGE_SLASHES = /^\/+|\/+$/gu;
const FILE_MODE = 0o644;
const UNIT_DIRS: Readonly<Record<UnitScope, string>> = {
  persistent: '/etc/systemd/system',
  runtime: '/run/systemd/system',
};
/** Mounting waits for the device, which may still be assembling. */
const SYSTEMCTL_TIMEOUT_MS = 180_000;

function escapeByte(byte: number): string {
  return `\\x${byte.toString(HEX).padStart(HEX_WIDTH, '0')}`;
}

function scopeArgs(scope: UnitScope): string[] {
  if (scope === 'runtime') {
    return ['--runtime'];
  }
  return [];
}

/** Where the unit file lives and what it is called. */
export type UnitScope = 'persistent' | 'runtime';

export interface MountUnitRequest {
  readonly poolId: string;
  /** Volume name, for the unit's description. */
  readonly volume: string;
  /** Device path of the logical volume. */
  readonly device: string;
  readonly type: FilesystemType;
  readonly mountPoint: string;
}

export interface InstalledMountUnit {
  readonly unitName: string;
  readonly unitPath: string;
}

/** The unit-name form of a path, as systemd-escape --path prints it (systemd.unit(5)). */
export function escapeSystemdPath(path: string): string {
  const trimmed = path.replace(EDGE_SLASHES, '');
  if (trimmed === '') {
    return '-';
  }
  let escaped = '';
  for (const byte of new TextEncoder().encode(trimmed)) {
    const char = String.fromCharCode(byte);
    if (byte === SLASH) {
      escaped += '-';
    } else if (byte < ASCII_LIMIT && SAFE_CHAR.test(char)) {
      escaped += char;
    } else {
      escaped += escapeByte(byte);
    }
  }
  if (escaped.startsWith('.')) {
    return `${escapeByte('.'.charCodeAt(0))}${escaped.slice(1)}`;
  }
  return escaped;
}

/** The unit name systemd requires for a mount at `mountPoint`. */
export function mountUnitName(mountPoint: string): string {
  assertMountPoint(mountPoint);
  return `${escapeSystemdPath(mountPoint)}.mount`;
}

export function mountUnitPath(mountPoint: string, scope: UnitScope): string {
  return join(UNIT_DIRS[scope], mountUnitName(mountPoint));
}

/** The unit file's text. */
export function renderMountUnit(request: MountUnitRequest): string {
  assertPoolId(request.poolId);
  assertVolumeName(request.volume);
  assertMountPoint(request.mountPoint);
  const options = mountOptions(request.type);
  let optionText = 'defaults';
  if (options.length > 0) {
    optionText = options.join(',');
  }
  const lines = [
    '[Unit]',
    `Description=Open HR volume ${request.volume} in pool ${request.poolId}`,
    'Documentation=https://github.com/nvitaterna/open-hr',
    '',
    '[Mount]',
    `What=${request.device}`,
    `Where=${request.mountPoint}`,
    `Type=${request.type}`,
    `Options=${optionText}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ];
  return `${lines.join('\n')}\n`;
}

/** Writes the unit, reloads systemd, enables it for boot, and mounts the volume now. */
export async function installMountUnit(
  run: CommandRunner,
  request: MountUnitRequest,
  scope: UnitScope,
): Promise<InstalledMountUnit> {
  const text = renderMountUnit(request);
  const unitName = mountUnitName(request.mountPoint);
  const unitPath = mountUnitPath(request.mountPoint, scope);
  await writeFile(unitPath, text, { mode: FILE_MODE });
  await runChecked(run, 'systemctl', ['daemon-reload']);
  await runChecked(run, 'systemctl', ['enable', '--now', ...scopeArgs(scope), unitName], {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  return { unitName, unitPath };
}

/** Unmounts the volume, disables the unit for boot, deletes it, and reloads systemd. */
export async function removeMountUnit(
  run: CommandRunner,
  mountPoint: string,
  scope: UnitScope,
): Promise<void> {
  const unitName = mountUnitName(mountPoint);
  await runChecked(run, 'systemctl', ['disable', '--now', ...scopeArgs(scope), unitName], {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  await rm(mountUnitPath(mountPoint, scope), { force: true });
  await runChecked(run, 'systemctl', ['daemon-reload']);
}
