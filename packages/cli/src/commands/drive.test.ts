import { describe, expect, it } from 'vitest';

import {
  exampleFiles,
  exampleLabels,
  exampleMachineWithNewDrive,
  runCli,
} from '../cli-test-helpers.ts';

describe('ohr drive replace', () => {
  it('needs a pool, the old drive or missing, and the new drive', async () => {
    expect((await runCli(['drive'])).code).toBe(2);
    expect((await runCli(['drive', 'replace', 'p1', '/dev/sdb'])).code).toBe(2);
    expect((await runCli(['drive', 'replace', 'P1', '/dev/sdb', '/dev/sdd'])).code).toBe(2);
    expect((await runCli(['drive', 'replace', 'p1', 'a', 'b', 'c'])).code).toBe(2);
  });

  it('shows each tier copied live and the commands, then stops unless confirmed', async () => {
    const result = await runCli(
      ['drive', 'replace', 'p1', '/dev/sdb', '/dev/sdd'],
      exampleMachineWithNewDrive(),
      exampleFiles(),
      { labels: exampleLabels(), answer: 'nope' },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Pool p1: replace /dev/sdb with /dev/sdd');
    expect(result.stdout).toContain('Tier 1: copied while the old member keeps working');
    expect(result.stdout).toContain(
      'mdadm --manage /dev/md/ohr_p1_t2 --replace /dev/sdb3 --with /dev/sdd3',
    );
    expect(result.stdout).toContain('/dev/sdb is not erased.');
    expect(result.stderr).toContain('Cancelled. Nothing was changed.');
  });

  it("shows core's reasons when it refuses", async () => {
    const result = await runCli(
      ['drive', 'replace', 'p1', 'missing', '/dev/sdd'],
      exampleMachineWithNewDrive(),
      exampleFiles(),
      { labels: exampleLabels() },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing');
  });
});
