import { describe, expect, it } from 'vitest';

import {
  emptyDrivesMachine,
  exampleFiles,
  exampleLabels,
  exampleMachine,
  exampleMachineWithNewDrive,
  runCli,
} from '../cli-test-helpers.ts';

describe('ohr pool create', () => {
  it('needs an id, a redundancy level, and devices', async () => {
    expect((await runCli(['pool', 'create', '--redundancy', 'shr1', '/dev/sdx'])).code).toBe(2);
    expect(
      (await runCli(['pool', 'create', '--id', 'Pool', '--redundancy', 'shr1', '/dev/sdx'])).code,
    ).toBe(2);
    expect((await runCli(['pool', 'create', '--id', 'p2', '/dev/sdx'])).code).toBe(2);
    expect((await runCli(['pool', 'create', '--id', 'p2', '--redundancy', 'shr1'])).code).toBe(2);
    expect((await runCli(['pool', 'explode'])).code).toBe(2);
  });

  it('says so when ohr-core is not running', async () => {
    const result = await runCli(
      ['pool', 'create', '--id', 'p2', '--redundancy', 'shr1', '/dev/sdx', '/dev/sdy'],
      emptyDrivesMachine(),
      new Map(),
      { coreStopped: true },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ohr-core is not running');
  });

  it('refuses the OS drive, unknown drives, drives with data, and a pool id in use', async () => {
    const result = await runCli(
      [
        'pool',
        'create',
        '--id',
        'p1',
        '--redundancy',
        'shr1',
        '/dev/nvme0n1',
        '/dev/sda',
        '/dev/sdq',
      ],
      exampleMachine(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('/dev/nvme0n1 holds the operating system');
    expect(result.stderr).toContain(
      '/dev/sda is not empty (an Open HR pool). It has to be wiped first.',
    );
    expect(result.stderr).toContain('/dev/sdq is not a physical drive');
    expect(result.stderr).toContain('Volume group ohr-p1 already exists');
    expect(result.stderr).toContain('Pass --wipe to erase drives that hold something.');
  });

  it('shows the plan and the commands, then stops when the id is not typed back', async () => {
    const result = await runCli(
      ['pool', 'create', '--id', 'p2', '--redundancy', 'shr1', '/dev/sdx', '/dev/sdy'],
      emptyDrivesMachine(),
      new Map(),
      { answer: 'nope' },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Pool p2');
    expect(result.stdout).toContain('SHR-1 plan for 2 drives');
    expect(result.stdout).toContain('1. partition /dev/sdx');
    expect(result.stdout).toContain('sgdisk --clear --new 1:1M:+16M');
    expect(result.stdout).toContain('mdadm --create /dev/md/ohr_p2_t1 --run');
    expect(result.stdout).toContain('This erases everything on /dev/sdx, /dev/sdy.');
    expect(result.stdout).toContain('Type the pool id (p2) to continue:');
    expect(result.stderr).toBe('Cancelled. Nothing was changed.');
  });

  it('explains the plan error when the drives cannot form a pool', async () => {
    const result = await runCli(
      ['pool', 'create', '--id', 'p2', '--redundancy', 'shr2', '/dev/sdx', '/dev/sdy'],
      emptyDrivesMachine(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('needs at least 4 drives');
  });

  it('accepts loop devices only when ohr-core runs with --allow-loop', async () => {
    const machine = emptyDrivesMachine();
    const lsblk = JSON.parse(String((machine.get('lsblk') as { stdout: string }).stdout)) as {
      blockdevices: Record<string, unknown>[];
    };
    for (const name of ['loop7', 'loop8']) {
      lsblk.blockdevices.push({
        ...lsblk.blockdevices[1],
        name,
        path: `/dev/${name}`,
        type: 'loop',
        serial: null,
      });
    }
    machine.set('lsblk', {
      kind: 'exited',
      exitCode: 0,
      stdout: JSON.stringify(lsblk),
      stderr: '',
    });
    const args = [
      'pool',
      'create',
      '--id',
      'p2',
      '--redundancy',
      'shr1',
      '/dev/loop7',
      '/dev/loop8',
    ];
    const refused = await runCli(args, machine, new Map());
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('/dev/loop7 is not a physical drive');
    const allowed = await runCli(args, machine, new Map(), { answer: 'no', allowLoop: true });
    expect(allowed.stdout).toContain('1. partition /dev/loop7');
    expect(allowed.stderr).toBe('Cancelled. Nothing was changed.');
  });
});

describe('ohr pool add and ohr pool expand', () => {
  it('needs a valid pool, drives to add, and no drives for expand', async () => {
    expect((await runCli(['pool', 'add'])).code).toBe(2);
    expect((await runCli(['pool', 'add', 'P1', '/dev/sdd'])).code).toBe(2);
    expect((await runCli(['pool', 'add', 'p1'])).code).toBe(2);
    expect((await runCli(['pool', 'expand', 'p1', '/dev/sdd'])).code).toBe(2);
    expect((await runCli(['pool', 'expand', 'p1', '--wipe'])).code).toBe(2);
  });

  it("shows core's reasons when it refuses", async () => {
    const result = await runCli(
      ['pool', 'add', 'p1', '/dev/sda', '/dev/nvme0n1'],
      exampleMachineWithNewDrive(),
      exampleFiles(),
      { labels: exampleLabels() },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('/dev/sda is already in pool p1.');
    expect(result.stderr).toContain('/dev/nvme0n1 holds the operating system');
  });

  it('shows the capacity before and after and the commands, then stops unless confirmed', async () => {
    const result = await runCli(
      ['pool', 'add', 'p1', '/dev/sdd'],
      exampleMachineWithNewDrive(),
      exampleFiles(),
      { labels: exampleLabels(), answer: 'nope' },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Pool p1: ');
    expect(result.stdout).toContain(' usable now, ');
    expect(result.stdout).toContain('mdadm --grow /dev/md/ohr_p1_t2 --level=5');
    expect(result.stdout).toContain('mdadm --grow /dev/md/ohr_p1_t2 --chunk=512');
    expect(result.stdout).toContain('This erases everything on /dev/sdd.');
    expect(result.stdout).toContain('Type the pool id (p1) to continue');
    expect(result.stderr).toContain('Cancelled. Nothing was changed.');
  });

  it('says when a pool has no space to use', async () => {
    const result = await runCli(['pool', 'expand', 'p1'], exampleMachine(), exampleFiles(), {
      labels: exampleLabels(),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe('');
  });
});
