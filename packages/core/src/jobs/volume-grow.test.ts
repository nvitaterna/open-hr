import { describe, expect, it } from 'vitest';

import type { VolumeGrowInput } from '@ohr/shared/volume-grow-input';

import type { CommandResult } from '../command-runner.ts';
import { fakeRunner, fixture, ok } from '../fake-system-test-helpers.ts';
import type { StepContext } from './engine.ts';
import { buildVolumeGrowJob } from './volume-grow.ts';

const GIB = 1024 ** 3;
const DEVICE = '/dev/ohr-p1/data';

const INPUT: VolumeGrowInput = {
  poolId: 'p1',
  name: 'data',
  filesystem: 'btrfs',
  mountPoint: '/mnt/ohr/data',
  size: { kind: 'bytes', bytes: 20 * GIB },
};

function lvs(sizeBytes: number): string {
  return `{"report":[{"lv":[{"lv_name":"data","vg_name":"ohr-p1","lv_uuid":"Rt6Yu1-Io9P-a4Sd-F8gH-j2Kl-Z7xC-v3Bn5M","lv_size":"${sizeBytes}","lv_path":"${DEVICE}","lv_attr":"-wi-ao----","lv_layout":"linear"}]}]}`;
}

function vgs(freeBytes: number): string {
  return fixture('example-shr1/vgs.json').replace('"vg_free": "0"', `"vg_free": "${freeBytes}"`);
}

function context(answers: ReadonlyMap<string, CommandResult>): StepContext {
  return { run: fakeRunner(answers).run, log: () => undefined };
}

function job(input: VolumeGrowInput = INPUT) {
  return buildVolumeGrowJob(input, { resolvePath: (path) => Promise.resolve(path) });
}

describe('buildVolumeGrowJob', () => {
  it('extends the volume to its new size, then grows the filesystem through its mount point', () => {
    expect(job().steps.map((step) => [step.name, step.commands])).toEqual([
      ['extend volume data', [`lvextend --size ${20 * GIB}b ${DEVICE}`]],
      ['grow filesystem of data', ['btrfs filesystem resize max /mnt/ohr/data']],
    ]);
  });

  it('extends once: done at the planned size, refused past it', async () => {
    const [extend] = job().steps;
    const at = (size: number) => extend?.precondition(context(new Map([['lvs', ok(lvs(size))]])));
    expect(await at(10 * GIB)).toEqual({ kind: 'ready' });
    expect(await at(20 * GIB)).toMatchObject({ kind: 'already-done' });
    expect(await at(30 * GIB)).toMatchObject({ kind: 'blocked' });
  });

  it('counts all free space as done once the pool has none left', async () => {
    const [extend] = job({ ...INPUT, size: { kind: 'all-free' } }).steps;
    const answers = (free: number) =>
      new Map([
        ['lvs', ok(lvs(10 * GIB))],
        ['vgs', ok(vgs(free))],
      ]);
    expect(await extend?.precondition(context(answers(GIB)))).toEqual({ kind: 'ready' });
    expect(await extend?.precondition(context(answers(0)))).toMatchObject({ kind: 'already-done' });
  });

  it('grows the filesystem only while the volume is mounted where it was', async () => {
    const [, grow] = job().steps;
    const findmnt = (source: string) =>
      new Map([
        [
          'findmnt',
          ok(
            `{"filesystems":[{"target":"/mnt/ohr/data","source":"${source}","fstype":"btrfs","options":"rw","size":1,"used":0,"avail":1}]}`,
          ),
        ],
      ]);
    expect(await grow?.precondition(context(findmnt(DEVICE)))).toEqual({ kind: 'ready' });
    expect(await grow?.precondition(context(findmnt('/dev/sdz1')))).toMatchObject({
      kind: 'blocked',
    });
  });
});
