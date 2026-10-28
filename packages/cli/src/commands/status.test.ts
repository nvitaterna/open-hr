import { describe, expect, it } from 'vitest';

import { exampleMachine, runCli } from '../cli-test-helpers.ts';

describe('ohr status', () => {
  it('lists drives, arrays, and volume groups', async () => {
    const result = await runCli(['status']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('/dev/nvme0n1  500.10 GB  Samsung SSD 980 500GB  system  -');
    expect(result.stdout).toContain(
      '/dev/md127  ohr_p1_t1  raid5  8.00 TB  healthy  sda2 sdb2 sdc2',
    );
    expect(result.stdout).toContain('ohr-p1  12.00 TB  0 B   2    1');
    expect(result.stdout).not.toContain('Warnings');
  });

  it('shows SMART health when asked', async () => {
    const result = await runCli(['status', '--smart']);
    expect(result.stdout).toContain('WDC WD40EFZX-68AWUN0   ohr     passed');
    expect(result.stdout).toContain('ST8000VN004-2M2101     ohr     FAILING');
  });

  it('prints the snapshot as JSON', async () => {
    const result = await runCli(['status', '--json']);
    const snapshot = JSON.parse(result.stdout) as { drives: unknown[] };
    expect(snapshot.drives).toHaveLength(4);
  });

  it('lists warnings for things it could not read', async () => {
    const answers = exampleMachine();
    answers.delete('vgs');
    const result = await runCli(['status'], answers);
    expect(result.stdout).toContain('Warnings\n  vgs is not installed');
  });

  it('fails with a message when lsblk fails', async () => {
    const answers = exampleMachine();
    answers.set('lsblk', { kind: 'exited', exitCode: 32, stdout: '', stderr: 'lsblk: failed' });
    const result = await runCli(['status'], answers);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Error: lsblk exited with code 32: lsblk: failed');
  });
});
