/**
 * Password hashing with argon2id from node:crypto (decision 0008): 19 MiB of
 * memory, 2 passes, 1 lane, the OWASP minimum. Hashes are stored in the PHC
 * string format that other argon2 tools read, so a later change of
 * parameters can still verify old hashes.
 */

import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'argon2id';
const VERSION = 19;
const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const TAG_BYTES = 32;
const SALT_BYTES = 16;
const BASE64_PADDING = /[=]+$/u;
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(?<memory>\d+),t=(?<passes>\d+),p=(?<parallelism>\d+)\$(?<salt>[A-Za-z0-9+/]+)\$(?<hash>[A-Za-z0-9+/]+)$/u;

interface Parameters {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

function derive(
  password: string,
  salt: Buffer,
  parameters: Parameters,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      ALGORITHM,
      { message: password, nonce: salt, tagLength, ...parameters },
      (error, key) => {
        if (error === null) {
          resolve(key);
        } else {
          reject(error);
        }
      },
    );
  });
}

/** Unpadded standard base64, as the PHC format writes it. */
function encode(bytes: Buffer): string {
  return bytes.toString('base64').replace(BASE64_PADDING, '');
}

/** Hashes a password into a PHC string with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const parameters = { memory: MEMORY_KIB, passes: PASSES, parallelism: PARALLELISM };
  const hash = await derive(password, salt, parameters, TAG_BYTES);
  return `$${ALGORITHM}$v=${VERSION}$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${encode(salt)}$${encode(hash)}`;
}

/** True when `password` matches the stored hash. A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const groups = PHC_PATTERN.exec(stored)?.groups;
  if (groups?.salt === undefined || groups.hash === undefined) {
    return false;
  }
  const expected = Buffer.from(groups.hash, 'base64');
  const actual = await derive(
    password,
    Buffer.from(groups.salt, 'base64'),
    {
      memory: Number(groups.memory),
      passes: Number(groups.passes),
      parallelism: Number(groups.parallelism),
    },
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}
