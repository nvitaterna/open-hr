import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './passwords.ts';

const PHC_HASH = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/u;

describe('passwords', () => {
  it('stores argon2id with the decided parameters and a fresh salt', async () => {
    const first = await hashPassword('correct horse battery');
    const second = await hashPassword('correct horse battery');
    expect(first).toMatch(PHC_HASH);
    expect(first).not.toBe(second);
  });

  it('verifies the right password and nothing else', async () => {
    const stored = await hashPassword('correct horse battery');
    await expect(verifyPassword('correct horse battery', stored)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
  });

  it('never matches a malformed hash', async () => {
    await expect(verifyPassword('anything', 'plain text')).resolves.toBe(false);
    await expect(verifyPassword('anything', '$argon2i$v=19$m=1,t=1,p=1$AA$AA')).resolves.toBe(
      false,
    );
  });
});
