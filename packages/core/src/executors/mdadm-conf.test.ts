import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PoolIdError } from '@ohr/shared/naming';

import { fakeRunner, ok } from '../fake-system-test-helpers.ts';
import {
  arrayDefinition,
  mdadmConfPath,
  removeMdadmConf,
  renderMdadmConf,
  writeMdadmConf,
} from './mdadm-conf.ts';

const DEFINITIONS = [
  { device: '/dev/md/ohr_p1_t1', metadata: '1.2', uuid: '140b5ec3:72c1c4ad:6daf496c:2a364b9a' },
  { device: '/dev/md/ohr_p1_t2', metadata: null, uuid: 'f5126f62:e4406841:d9539c70:fd003a2e' },
];
const EXPECTED = `# Open Hybrid RAID pool p1. Written by ohr; edits are overwritten.
# To assemble by hand: mdadm --assemble --scan
ARRAY /dev/md/ohr_p1_t1 metadata=1.2 UUID=140b5ec3:72c1c4ad:6daf496c:2a364b9a
ARRAY /dev/md/ohr_p1_t2 UUID=f5126f62:e4406841:d9539c70:fd003a2e
`;

let confDir = '';

beforeAll(async () => {
  confDir = join(await mkdtemp(join(tmpdir(), 'ohr-mdadm-conf-')), 'mdadm.conf.d');
});

afterAll(async () => {
  await rm(join(confDir, '..'), { recursive: true, force: true });
});

describe('mdadmConfPath', () => {
  it('is one file per pool in the system directory', () => {
    expect(mdadmConfPath('p1')).toBe('/etc/mdadm/mdadm.conf.d/ohr-p1.conf');
  });

  it('refuses an invalid pool id', () => {
    expect(() => mdadmConfPath('P1')).toThrow(PoolIdError);
  });
});

describe('arrayDefinition', () => {
  it('reads the ARRAY line mdadm prints', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        [
          'mdadm',
          ok('ARRAY /dev/md/ohr_p1_t1 metadata=1.2 UUID=140b5ec3:72c1c4ad:6daf496c:2a364b9a\n'),
        ],
      ]),
    );
    expect(await arrayDefinition(run, '/dev/md/ohr_p1_t1')).toEqual(DEFINITIONS[0]);
    expect(calls).toEqual([
      { command: 'mdadm', args: ['--detail', '--scan', '/dev/md/ohr_p1_t1'] },
    ]);
  });
});

describe('renderMdadmConf', () => {
  it('writes a header and one ARRAY line per array', () => {
    expect(renderMdadmConf('p1', DEFINITIONS)).toBe(EXPECTED);
  });
});

describe('writeMdadmConf and removeMdadmConf', () => {
  it('creates the directory and file, replaces it, and removes it', async () => {
    const path = await writeMdadmConf('p1', DEFINITIONS.slice(0, 1), { confDir });
    expect(path).toBe(join(confDir, 'ohr-p1.conf'));
    expect(await readFile(path, 'utf8')).toContain('ohr_p1_t1');
    expect(await readFile(path, 'utf8')).not.toContain('ohr_p1_t2');

    await writeMdadmConf('p1', DEFINITIONS, { confDir });
    expect(await readFile(path, 'utf8')).toBe(EXPECTED);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    await removeMdadmConf('p1', { confDir });
    expect(existsSync(path)).toBe(false);
    await expect(removeMdadmConf('p1', { confDir })).resolves.toBeUndefined();
  });
});
