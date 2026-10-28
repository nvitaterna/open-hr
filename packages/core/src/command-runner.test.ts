import { describe, expect, it } from 'vitest';

import { describeFailure, runCommand } from './command-runner.ts';
import { readTextFile } from './file-reader.ts';

describe('runCommand (real processes)', () => {
  it('returns stdout and a zero exit code', async () => {
    expect(await runCommand('echo', ['hello', '$HOME', '; ls'])).toEqual({
      kind: 'exited',
      exitCode: 0,
      stdout: 'hello $HOME ; ls\n',
      stderr: '',
    });
  });

  it('passes only the fixed environment', async () => {
    const result = await runCommand('env', []);
    if (result.kind !== 'exited') {
      throw new Error(`env did not run: ${result.kind}`);
    }
    expect(result.stdout.trim().split('\n').sort()).toEqual([
      'LANG=C',
      'LC_ALL=C',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ]);
  });

  it('reports a non-zero exit code', async () => {
    expect(await runCommand('false', [])).toMatchObject({ kind: 'exited', exitCode: 1 });
  });

  it('reports a missing program', async () => {
    expect(await runCommand('ohr-no-such-program', [])).toEqual({ kind: 'not-found' });
  });

  it('stops a command that runs too long', async () => {
    expect(await runCommand('sleep', ['5'], { timeoutMs: 100 })).toMatchObject({
      kind: 'timed-out',
    });
  });
});

describe('describeFailure', () => {
  it('describes every kind of failure', () => {
    expect(describeFailure('mdadm', { kind: 'not-found' })).toBe('mdadm is not installed');
    expect(describeFailure('mdadm', { kind: 'timed-out', stdout: '', stderr: '' })).toBe(
      'mdadm timed out',
    );
    expect(describeFailure('mdadm', { kind: 'failed', message: 'EACCES' })).toBe(
      'mdadm could not run: EACCES',
    );
    expect(
      describeFailure('pvs', { kind: 'exited', exitCode: 5, stdout: '', stderr: 'need root\n' }),
    ).toBe('pvs exited with code 5: need root');
  });
});

describe('readTextFile', () => {
  it('reads a file and returns null for a missing one', async () => {
    expect(await readTextFile(new URL('../package.json', import.meta.url).pathname)).toContain(
      '@ohr/core',
    );
    expect(await readTextFile('/proc/ohr-no-such-file')).toBeNull();
  });
});
