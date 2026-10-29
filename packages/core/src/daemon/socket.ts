/**
 * The socket file's place, owner, and mode (decision 0007): `root:ohr` with
 * mode 0660 in a directory with mode 0750, so only root and members of the
 * `ohr` group can connect.
 */

import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname } from 'node:path';

import type { FileReader } from '../command-runner.ts';
import { SocketBusyError } from './socket-busy-error.ts';

const GROUP_FILE = '/etc/group';
const DIRECTORY_MODE = 0o750;
const SOCKET_MODE = 0o660;
/** chown leaves the owner alone when given -1. */
const KEEP_OWNER = -1;
const GROUP_FIELDS = 4;

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

/** Resolves true if something accepts a connection on `path`. */
function isListening(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (errorCode(error) === 'ECONNREFUSED' || errorCode(error) === 'ENOENT') {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

/** What is at `path`: nothing, a socket, or something else. Symbolic links are not followed. */
async function kindOf(path: string): Promise<'missing' | 'socket' | 'other'> {
  try {
    const info = await lstat(path);
    if (info.isSocket()) {
      return 'socket';
    }
    return 'other';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

/** The numeric id of a group from /etc/group, or null if there is no such group. */
export async function groupId(name: string, readFile: FileReader): Promise<number | null> {
  const text = (await readFile(GROUP_FILE)) ?? '';
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    if (fields.length >= GROUP_FIELDS && fields[0] === name) {
      const id = Number(fields[2]);
      if (Number.isInteger(id)) {
        return id;
      }
    }
  }
  return null;
}

/**
 * Makes the socket's directory if it is missing and removes a socket file
 * left behind by a daemon that died. Throws SocketBusyError if a daemon is
 * still listening, and refuses to remove anything that is not a socket.
 */
export async function prepareSocketPath(path: string, gid: number | null): Promise<void> {
  const directory = dirname(path);
  if ((await kindOf(directory)) === 'missing') {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    if (gid !== null) {
      await chown(directory, KEEP_OWNER, gid);
    }
  }
  const kind = await kindOf(path);
  if (kind === 'missing') {
    return;
  }
  if (kind === 'other') {
    throw new Error(`${path} exists and is not a socket. Remove it or choose another --socket.`);
  }
  if (await isListening(path)) {
    throw new SocketBusyError(`Another ohr-core is already listening on ${path}.`);
  }
  await unlink(path);
}

/**
 * Gives the socket its group and mode once it exists. Until this runs the
 * file has the umask's mode and root's group; with systemd's default umask
 * of 022 only root can connect in that gap.
 */
export async function secureSocket(path: string, gid: number | null): Promise<void> {
  if (gid !== null) {
    await chown(path, KEEP_OWNER, gid);
  }
  await chmod(path, SOCKET_MODE);
}
