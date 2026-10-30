import { describe, expect, it } from 'vitest';

import {
  emptyDrivesMachine,
  exampleFiles,
  exampleMachine,
  exampleMachineWithFreeSpace,
  poolMachine,
  runCli,
  vmFiles,
  vmMachine,
} from '../cli-test-helpers.ts';

const CREATE = ['volume', 'create', '--pool', 'p2', '--name', 'media', '--fs', 'btrfs'];

describe('ohr volume create', () => {
  it('needs a pool, a name, and a filesystem, and checks the size and mount point', async () => {
    expect((await runCli(['volume', 'create', '--name', 'media', '--fs', 'btrfs'])).code).toBe(2);
    expect((await runCli(['volume', 'create', '--pool', 'p2', '--fs', 'btrfs'])).code).toBe(2);
    expect(
      (await runCli(['volume', 'create', '--pool', 'p2', '--name', 'Media', '--fs', 'btrfs'])).code,
    ).toBe(2);
    expect((await runCli(['volume', 'create', '--pool', 'p2', '--name', 'media'])).code).toBe(2);
    expect((await runCli([...CREATE, '--size', '100'])).code).toBe(2);
    expect((await runCli([...CREATE, '--size', '1MB'])).code).toBe(2);
    expect((await runCli(['volume', 'delete'])).code).toBe(2);
  });

  it("passes on core's refusal of a relative mount point", async () => {
    const result = await runCli([...CREATE, '--mount', 'media'], poolMachine());
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('The mount point must be an absolute directory path, got "media".');
  });

  it('refuses a missing pool, a name in use, no free space, and a busy mount point', async () => {
    const missing = await runCli(CREATE, emptyDrivesMachine());
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('There is no pool p2 on this machine');

    const inUse = await runCli(
      ['volume', 'create', '--pool', 'dev', '--name', 'data', '--fs', 'btrfs', '--mount', '/srv/x'],
      vmMachine(),
      vmFiles('mdstat.txt'),
    );
    expect(inUse.code).toBe(1);
    expect(inUse.stderr).toContain('Pool dev already has a volume named data.');
    expect(inUse.stderr).toContain('Pool dev has no free space.');

    const tooBig = await runCli([...CREATE, '--size', '20GB'], poolMachine());
    expect(tooBig.code).toBe(1);
    expect(tooBig.stderr).toContain('less than the 19.99 GB asked for');

    const busy = await runCli([...CREATE, '--name', 'data'], poolMachine());
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain('/mnt/ohr/data already has something mounted on it.');
  });

  it('shows the steps and commands, then stops when the name is not typed back', async () => {
    const result = await runCli(CREATE, poolMachine(), new Map(), { answer: 'no' });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Volume media in pool p2');
    expect(result.stdout).toContain('Filesystem: btrfs');
    expect(result.stdout).toContain('Size: all free space (8.58 GB)');
    expect(result.stdout).toContain('Mount point: /mnt/ohr/media');
    expect(result.stdout).toContain('1. create volume media');
    expect(result.stdout).toContain(
      'lvcreate --yes --wipesignatures y --zero y --extents 100%FREE --name media ohr-p2',
    );
    expect(result.stdout).toContain('mkfs.btrfs --quiet --label media /dev/ohr-p2/media');
    expect(result.stdout).toContain('systemctl enable --now mnt-ohr-media.mount');
    expect(result.stdout).toContain('Type the volume name (media) to continue:');
    expect(result.stderr).toBe('Cancelled. Nothing was changed.');
  });

  it('rounds a size down to whole extents', async () => {
    const result = await runCli(
      [...CREATE, '--size', '1GB', '--mount', '/srv/media'],
      poolMachine(),
      new Map(),
      {
        answer: 'no',
      },
    );
    expect(result.stdout).toContain('Size: 998.24 MB');
    expect(result.stdout).toContain('--size 998244352b');
  });
});

describe('ohr volume grow', () => {
  const Gib = 1024 ** 3;

  it('needs a pool and a volume, and checks the size', async () => {
    expect((await runCli(['volume', 'grow', 'p1'])).code).toBe(2);
    expect((await runCli(['volume', 'grow', 'p1', 'Data'])).code).toBe(2);
    expect((await runCli(['volume', 'grow', 'p1', 'data', '1MB'])).code).toBe(2);
    expect((await runCli(['volume', 'grow', 'p1', 'data', '1GB', 'extra'])).code).toBe(2);
  });

  it("passes on core's refusal when the pool has no free space", async () => {
    const result = await runCli(['volume', 'grow', 'p1', 'data'], exampleMachine(), exampleFiles());
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Pool p1 has no free space.');
  });

  it('shows the size afterwards and the commands, then stops unless confirmed', async () => {
    const result = await runCli(
      ['volume', 'grow', 'p1', 'data', '4GiB'],
      exampleMachineWithFreeSpace(10 * Gib),
      exampleFiles(),
      { answer: 'nope' },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Volume data in pool p1');
    expect(result.stdout).toContain('Filesystem: btrfs, mounted at /mnt/ohr/data, grown online');
    expect(result.stdout).toContain('btrfs filesystem resize max /mnt/ohr/data');
    expect(result.stdout).toContain('Type the volume name (data) to continue');
    expect(result.stderr).toContain('Cancelled. Nothing was changed.');
  });
});
