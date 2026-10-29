import { describe, expect, it } from 'vitest';

import { VERSION } from '@ohr/shared/constants';

import { runCli } from './cli-test-helpers.ts';

describe('ohr', () => {
  it('prints usage with no arguments', async () => {
    const result = await runCli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: ohr [--socket <path>] <command>');
    expect(result.stdout).toContain('status');
  });

  it('prints help for one command', async () => {
    expect((await runCli(['help', 'plan'])).stdout).toContain('--redundancy');
  });

  it('prints help for a command given --help', async () => {
    const result = await runCli(['plan', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--redundancy');
    expect(result.stderr).toBe('');
  });

  it('prints the version', async () => {
    expect((await runCli(['version'])).stdout).toBe(`ohr ${VERSION}`);
  });

  it('rejects unknown commands with exit code 2', async () => {
    const result = await runCli(['explode']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command: explode');
  });

  it('rejects unknown options with the command usage and exit code 2', async () => {
    const result = await runCli(['status', '--loud']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage: ohr status');
  });
});
