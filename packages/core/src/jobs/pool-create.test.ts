import { describe, expect, it } from 'vitest';

import { planPool } from '@ohr/shared/planner';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import type { CommandResult } from '../command-runner.ts';
import type { BlockDeviceIo } from '../executors/label-partition.ts';
import { exampleShr1Answers, fakeRunner, fixture, ok } from '../fake-system-test-helpers.ts';
import type { StepContext, StepDefinition } from './engine.ts';
import { buildPoolCreateJob } from './pool-create.ts';

const GIB = 1024 ** 3;
/** The VM pool's drives: sda, sdc to sdg of 2, 4, 4, 6, 8, and 8 GiB. sdb is the OS. */
const VM_DRIVES = [
  ['/dev/sda', 2 * GIB],
  ['/dev/sdc', 4 * GIB],
  ['/dev/sdd', 4 * GIB],
  ['/dev/sde', 6 * GIB],
  ['/dev/sdf', 8 * GIB],
  ['/dev/sdg', 8 * GIB],
] as const;
const POOL_UUID = '6f1c2b0e-8a3d-4c5e-9f7a-1b2c3d4e5f60';
const NOT_PLANNED = /is not in the planned layout/u;

function vmInput(wipe = false): PoolCreateInput {
  const plan = planPool(
    VM_DRIVES.map(([path, sizeBytes]) => ({ id: path, sizeBytes })),
    'shr1',
  );
  if (!plan.ok) {
    throw new Error('plan failed');
  }
  return {
    poolId: 'dev',
    poolUuid: POOL_UUID,
    redundancy: 'shr1',
    wipe,
    drives: VM_DRIVES.map(([path, sizeBytes], index) => ({
      path,
      serial: null,
      wwn: null,
      sizeBytes,
      driveUuid: `0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f7${index}`,
    })),
    layout: plan.layout,
  };
}

/** The VM machine as the parsers' fixtures captured it. */
function vmAnswers(): Map<string, CommandResult> {
  const answers = new Map([
    ['lsblk', ok(fixture('vm-shr1/lsblk.json'))],
    ['pvs', ok(fixture('vm-shr1/pvs.json'))],
    ['vgs', ok(fixture('vm-shr1/vgs.json'))],
    ['mdadm /dev/md/ohr_dev_t1', ok(fixture('vm-shr1/mdadm-detail-md127.txt'))],
    ['mdadm /dev/md/ohr_dev_t2', ok(fixture('vm-shr1/mdadm-detail-md126.txt'))],
  ]);
  return answers;
}

/** A label partition store that answers every read with the same bytes. */
function labelIo(bytes: Uint8Array): BlockDeviceIo {
  return { read: () => Promise.resolve(bytes), write: () => Promise.resolve() };
}

function context(run: StepContext['run']): StepContext {
  return { run, log: () => undefined, progress: () => undefined };
}

function step(input: PoolCreateInput, name: string, io?: BlockDeviceIo): StepDefinition {
  const definition = buildPoolCreateJob(input, { labelIo: io ?? labelIo(new Uint8Array(0)) });
  const found = definition.steps.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no step ${name}`);
  }
  return found;
}

describe('buildPoolCreateJob', () => {
  it('lists partition, label, array, LVM, and config steps in order', () => {
    const definition = buildPoolCreateJob(vmInput());
    expect(definition.kind).toBe('pool-create');
    expect(definition.steps.map((candidate) => candidate.name)).toEqual([
      ...VM_DRIVES.map(([path]) => `partition ${path}`),
      ...VM_DRIVES.map(([path]) => `label ${path}`),
      'create tier 1 array',
      'create tier 2 array',
      'create tier 3 array',
      'create tier 4 array',
      'add tier 1 array to LVM',
      'add tier 2 array to LVM',
      'add tier 3 array to LVM',
      'add tier 4 array to LVM',
      'create volume group',
      'write mdadm config',
    ]);
  });

  it('previews the exact commands', () => {
    const definition = buildPoolCreateJob(vmInput());
    expect(definition.steps[0]?.commands[0]).toBe(
      'sgdisk --clear --new 1:1M:+16M --typecode 1:8300 --change-name 1:ohr-dev-label --new 2:17M:+1967M --typecode 2:FD00 --change-name 2:ohr-dev-t1 /dev/sda',
    );
    expect(step(vmInput(), 'create tier 4 array').commands).toEqual([
      'mdadm --create /dev/md/ohr_dev_t4 --run --metadata=1.2 --homehost=any --name=ohr_dev_t4 --level=raid1 --raid-devices=2 --bitmap=internal /dev/sdf5 /dev/sdg5',
      'udevadm settle',
    ]);
    expect(step(vmInput(), 'create volume group').commands).toEqual([
      'vgcreate --physicalextentsize 4M ohr-dev /dev/md/ohr_dev_t1 /dev/md/ohr_dev_t2 /dev/md/ohr_dev_t3 /dev/md/ohr_dev_t4',
    ]);
  });

  it('refuses a drive that is not in the layout', () => {
    const input = vmInput();
    const broken = {
      ...input,
      drives: [...input.drives, { ...input.drives[0], path: '/dev/sdz' }],
    };
    expect(() => buildPoolCreateJob(broken as PoolCreateInput)).toThrow(NOT_PLANNED);
  });
});

describe('pool-create preconditions on the VM pool', () => {
  it('sees the partitions, arrays, physical volumes, and group as already done', async () => {
    const { run } = fakeRunner(vmAnswers());
    const input = vmInput();
    await expect(
      step(input, 'partition /dev/sda').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'already-done',
    });
    await expect(
      step(input, 'create tier 1 array').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'already-done',
    });
    await expect(
      step(input, 'add tier 1 array to LVM').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'already-done',
    });
    await expect(
      step(input, 'create volume group').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'already-done',
    });
  });

  it('blocks the OS drive and a drive with data unless wiping was chosen', async () => {
    const { run } = fakeRunner(vmAnswers());
    const withOs: PoolCreateInput = {
      ...vmInput(),
      drives: [
        { path: '/dev/sdb', serial: null, wwn: null, sizeBytes: 20 * GIB, driveUuid: POOL_UUID },
      ],
      layout: {
        ...vmInput().layout,
        drives: [{ ...vmInput().layout.drives[0], id: '/dev/sdb' }],
      } as PoolCreateInput['layout'],
    };
    await expect(
      step(withOs, 'partition /dev/sdb').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: '/dev/sdb holds the operating system',
    });
    const { run: example } = fakeRunner(exampleShr1Answers());
    const other = {
      ...vmInput(),
      poolId: 'new',
      drives: [
        { path: '/dev/sda', serial: null, wwn: null, sizeBytes: 4e12, driveUuid: POOL_UUID },
      ],
      layout: { ...vmInput().layout, drives: [{ ...vmInput().layout.drives[0], id: '/dev/sda' }] },
    } as PoolCreateInput;
    await expect(
      step(other, 'partition /dev/sda').precondition(context(example)),
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: '/dev/sda is not empty and wiping was not chosen',
    });
    await expect(
      step({ ...other, wipe: true }, 'partition /dev/sda').precondition(context(example)),
    ).resolves.toEqual({ kind: 'ready' });
  });

  it('is ready when the array, physical volume, and group do not exist yet', async () => {
    const { run } = fakeRunner(new Map([['lsblk', ok(fixture('vm-shr1/lsblk.json'))]]));
    const input = vmInput();
    await expect(step(input, 'create tier 1 array').precondition(context(run))).resolves.toEqual({
      kind: 'ready',
    });
    await expect(
      step(input, 'add tier 1 array to LVM').precondition(context(run)),
    ).resolves.toEqual({ kind: 'ready' });
    await expect(step(input, 'create volume group').precondition(context(run))).resolves.toEqual({
      kind: 'ready',
    });
  });

  it('blocks an array with other members and a group with the wrong physical volumes', async () => {
    const answers = vmAnswers();
    answers.set('mdadm /dev/md/ohr_dev_t1', ok(fixture('vm-shr1/mdadm-detail-md124.txt')));
    const { run } = fakeRunner(answers);
    const input = vmInput();
    await expect(
      step(input, 'create tier 1 array').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: '/dev/md/ohr_dev_t1 exists with other members: /dev/sdf5, /dev/sdg5',
    });
    const fewerTiers = {
      ...input,
      layout: { ...input.layout, tiers: input.layout.tiers.slice(0, 2) },
    };
    await expect(
      step(fewerTiers, 'create volume group').precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'blocked',
    });
  });

  it('reads the label partition to decide on labels', async () => {
    const { run } = fakeRunner(new Map());
    const input = vmInput();
    const ours = new TextEncoder().encode(
      `${JSON.stringify({
        format: 'open-hr-label',
        layoutVersion: 1,
        poolId: 'dev',
        poolUuid: POOL_UUID,
        driveUuid: input.drives[0]?.driveUuid,
        redundancy: 'shr1',
        writtenAt: '2026-10-29T12:00:00.000Z',
      })}\n`,
    );
    await expect(
      step(input, 'label /dev/sda', labelIo(ours)).precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'already-done',
    });
    const theirs = new TextEncoder().encode(
      new TextDecoder().decode(ours).replace(POOL_UUID, '11111111-2222-4333-8444-555555555555'),
    );
    await expect(
      step(input, 'label /dev/sda', labelIo(theirs)).precondition(context(run)),
    ).resolves.toMatchObject({
      kind: 'blocked',
    });
    await expect(
      step(vmInput(true), 'label /dev/sda', labelIo(theirs)).precondition(context(run)),
    ).resolves.toEqual({ kind: 'ready' });
    await expect(
      step(input, 'label /dev/sda', labelIo(new Uint8Array(64))).precondition(context(run)),
    ).resolves.toEqual({ kind: 'ready' });
  });
});
