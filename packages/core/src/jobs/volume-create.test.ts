import { describe, expect, it } from 'vitest';

import type { VolumeCreateInput } from '@ohr/shared/volume-create-input';

import type { CommandResult } from '../command-runner.ts';
import { fakeRunner, fixture, ok } from '../fake-system-test-helpers.ts';
import type { StepContext, StepDefinition } from './engine.ts';
import { buildVolumeCreateJob, type VolumeCreateDeps } from './volume-create.ts';

const MIB = 1024 ** 2;
const DATA: VolumeCreateInput = {
  poolId: 'dev',
  name: 'data',
  filesystem: 'btrfs',
  size: { kind: 'all-free' },
  mountPoint: '/mnt/ohr/data',
};
const BTRFS_BLKID =
  'DEVNAME=/dev/ohr-dev/data\nLABEL=data\nUUID=43364e4c-acb5-4352-9811-eb8dea00d35b\nTYPE=btrfs\n';
const NOTHING_FOUND: CommandResult = { kind: 'exited', exitCode: 2, stdout: '', stderr: '' };
const NOT_FOUND: CommandResult = { kind: 'exited', exitCode: 1, stdout: '', stderr: '' };
/** What findmnt prints for the VM's data volume, mounted from its device-mapper path. */
const MOUNTED_REPORT =
  '{"filesystems":[{"target":"/mnt/ohr/data","source":"/dev/mapper/ohr--dev-data[/@data]","fstype":"btrfs","options":"rw,relatime,subvol=/@data","size":25300041728,"used":0,"avail":25300041728}]}';
/** The VM's data volume is mounted from its mapper path; this maps it back to the LV path. */
const resolveMapper = (path: string): Promise<string> =>
  Promise.resolve(path.replace('/dev/mapper/ohr--dev-data', '/dev/ohr-dev/data'));

function step(input: VolumeCreateInput, name: string, deps: VolumeCreateDeps = {}): StepDefinition {
  const found = buildVolumeCreateJob(input, deps).steps.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) {
    throw new Error(`no step ${name}`);
  }
  return found;
}

function context(run: StepContext['run']): StepContext {
  return { run, log: () => undefined, progress: () => undefined };
}

describe('buildVolumeCreateJob', () => {
  it('creates, formats, and mounts, with the exact commands', () => {
    const definition = buildVolumeCreateJob(DATA);
    expect(definition.kind).toBe('volume-create');
    expect(definition.steps.map((candidate) => candidate.name)).toEqual([
      'create volume data',
      'format data',
      'mount data',
    ]);
    expect(definition.steps[0]?.commands[0]).toBe(
      'lvcreate --yes --wipesignatures y --zero y --extents 100%FREE --name data ohr-dev',
    );
    expect(definition.steps[1]?.commands[0]).toBe(
      'mkfs.btrfs --quiet --label data /dev/ohr-dev/data',
    );
    expect(definition.steps[1]?.commands).toContain('btrfs subvolume create <scratch>/@data');
    expect(definition.steps[2]?.commands).toEqual([
      'write /etc/systemd/system/mnt-ohr-data.mount',
      'systemctl daemon-reload',
      'systemctl enable --now mnt-ohr-data.mount',
    ]);
  });

  it('formats ext4 with an exact size and no subvolumes', () => {
    const definition = buildVolumeCreateJob({
      ...DATA,
      name: 'scratch',
      filesystem: 'ext4',
      size: { kind: 'bytes', bytes: 8 * MIB },
      mountPoint: '/srv/scratch',
    });
    expect(definition.steps[0]?.commands[0]).toContain('--size 8388608b');
    expect(definition.steps[1]?.commands).toEqual(['mkfs.ext4 -q -L scratch /dev/ohr-dev/scratch']);
  });

  it('refuses a bad mount point', () => {
    expect(() => buildVolumeCreateJob({ ...DATA, mountPoint: 'relative' })).toThrow(RangeError);
  });
});

describe('volume-create preconditions', () => {
  it('skips a volume that exists and blocks one with another size', async () => {
    const { run } = fakeRunner(new Map([['lvs', ok(fixture('vm-shr1/lvs.json'))]]));
    await expect(
      step(DATA, 'create volume data').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'already-done',
    });
    const sized = { ...DATA, size: { kind: 'bytes', bytes: 8 * MIB } } as const;
    await expect(
      step(sized, 'create volume data').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'blocked',
    });
    const { run: none } = fakeRunner(new Map([['lvs', NOT_FOUND]]));
    await expect(step(DATA, 'create volume data').precondition(context(none))).resolves.toEqual({
      kind: 'ready',
    });
  });

  it('decides on formatting from what blkid finds', async () => {
    const { run: empty } = fakeRunner(new Map([['blkid', NOTHING_FOUND]]));
    await expect(step(DATA, 'format data').precondition(context(empty))).resolves.toEqual({
      kind: 'ready',
    });
    const { run: btrfs } = fakeRunner(new Map([['blkid', ok(BTRFS_BLKID)]]));
    await expect(step(DATA, 'format data').precondition(context(btrfs))).resolves.toMatchObject({
      kind: 'already-done',
    });
    await expect(
      step({ ...DATA, filesystem: 'ext4' }, 'format data').precondition(context(btrfs)),
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: '/dev/ohr-dev/data already holds btrfs, not ext4',
    });
    const { run: other } = fakeRunner(
      new Map([['blkid', ok(BTRFS_BLKID.replace('LABEL=data', 'LABEL=old'))]]),
    );
    await expect(step(DATA, 'format data').precondition(context(other))).resolves.toMatchObject({
      kind: 'blocked',
    });
  });

  it('decides on mounting from what is mounted there', async () => {
    const { run: mounted } = fakeRunner(new Map([['findmnt', ok(MOUNTED_REPORT)]]));
    await expect(
      step(DATA, 'mount data', { resolvePath: resolveMapper }).precondition(context(mounted)),
    ).resolves.toMatchObject({ kind: 'already-done' });
    await expect(
      step(DATA, 'mount data', { resolvePath: (path) => Promise.resolve(path) }).precondition(
        context(mounted),
      ),
    ).resolves.toMatchObject({ kind: 'blocked' });
    const { run: none } = fakeRunner(new Map([['findmnt', NOT_FOUND]]));
    await expect(step(DATA, 'mount data').precondition(context(none))).resolves.toEqual({
      kind: 'ready',
    });
  });
});
