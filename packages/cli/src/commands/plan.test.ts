import { describe, expect, it } from 'vitest';

import { runCli } from '../cli-test-helpers.ts';

describe('ohr plan with hypothetical sizes', () => {
  it('prints the worked example from the plan', async () => {
    const result = await runCli(['plan', '--redundancy', 'shr1', '--sizes', '4TB,8TB,8TB']);
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')).toEqual([
      'SHR-1 plan for 3 drives',
      'Usable capacity: 11.99 TB of 20.00 TB raw',
      '',
      'Tiers',
      '  TIER  LEVEL  PARTITION  SLICE    MEMBERS  USABLE',
      '  1     raid5  2          3.99 TB  3        7.99 TB',
      '  2     raid1  3          3.99 TB  2        3.99 TB',
      '',
      'Drives',
      '  DRIVE    SIZE     PARTITIONS                      UNUSED',
      '  drive 1  4.00 TB  1: label, 2: tier 1             0 B',
      '  drive 2  8.00 TB  1: label, 2: tier 1, 3: tier 2  0 B',
      '  drive 3  8.00 TB  1: label, 2: tier 1, 3: tier 2  0 B',
    ]);
  });

  it('prints the layout as JSON', async () => {
    const result = await runCli([
      'plan',
      '--redundancy',
      'shr2',
      '--json',
      '--sizes',
      '4TB,4TB,4TB,4TB',
    ]);
    const layout = JSON.parse(result.stdout) as { tiers: { level: string }[] };
    expect(layout.tiers.map((tier) => tier.level)).toEqual(['raid6']);
  });

  it('explains when there are too few drives', async () => {
    const result = await runCli(['plan', '--redundancy', 'shr2', '--sizes', '4TB,4TB,4TB']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('at least 4 drives');
  });
});

describe('ohr plan with bad input', () => {
  it.each([
    ['no redundancy level', ['plan', '--sizes', '4TB,4TB'], 'Choose a redundancy level'],
    [
      'an unknown redundancy level',
      ['plan', '--redundancy', 'raid5', '--sizes', '4TB,4TB'],
      'Choose a redundancy level',
    ],
    [
      'both sizes and devices',
      ['plan', '--redundancy', 'shr1', '--sizes', '4TB,4TB', '/dev/sda'],
      'not both',
    ],
    ['neither sizes nor devices', ['plan', '--redundancy', 'shr1'], 'not both'],
    [
      'a size without a unit',
      ['plan', '--redundancy', 'shr1', '--sizes', '4,4TB'],
      'Invalid size "4"',
    ],
    [
      'an ambiguous unit',
      ['plan', '--redundancy', 'shr1', '--sizes', '4T,4TB'],
      'Unknown unit "T"',
    ],
  ])('rejects %s with exit code 2', async (_label, args, message) => {
    const result = await runCli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });
});

describe('ohr plan with real drives', () => {
  it('plans for drives on the machine and warns that they hold data', async () => {
    const result = await runCli([
      'plan',
      '--redundancy',
      'shr1',
      '/dev/sda',
      '/dev/sdb',
      '/dev/sdc',
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr.split('\n')).toEqual([
      'Warning: /dev/sda is not empty. Creating a pool on it would erase what is there.',
      'Warning: /dev/sdb is not empty. Creating a pool on it would erase what is there.',
      'Warning: /dev/sdc is not empty. Creating a pool on it would erase what is there.',
    ]);
    expect(result.stdout).toContain('/dev/sdb  8.00 TB  1: label, 2: tier 1, 3: tier 2');
  });

  it('refuses the system drive and unknown devices', async () => {
    const result = await runCli(['plan', '--redundancy', 'shr1', '/dev/nvme0n1', '/dev/sdz']);
    expect(result.code).toBe(1);
    expect(result.stderr.split('\n')).toEqual([
      '/dev/nvme0n1 holds the operating system. Open HR never uses it.',
      '/dev/sdz is not a physical drive on this machine.',
    ]);
  });
});
