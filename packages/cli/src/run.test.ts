import { describe, expect, it } from 'vitest';
import { run } from './run.js';

function capture(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = run(args, { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('ohr cli', () => {
  it('prints usage with no arguments', () => {
    const r = capture([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: ohr');
  });

  it('prints the version', () => {
    expect(capture(['version']).stdout).toBe('ohr 0.0.0');
  });

  it('rejects unknown commands with exit code 2', () => {
    const r = capture(['explode']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown command: explode');
  });
});
