import { describe, expect, it } from 'vitest';

import { systemSnapshotSchema } from '@ohr/shared/system-snapshot';

import {
  exampleShr1Answers,
  exampleShr1Files,
  fakeFiles,
  fakeRunner,
  fixture,
  ok,
} from './fake-system-test-helpers.ts';
import { readDrives, readSystemState, SystemStateError } from './system-state.ts';

async function snapshot() {
  const answers = exampleShr1Answers();
  answers.set('smartctl /dev/sdc', {
    kind: 'exited',
    exitCode: 2,
    stdout: fixture('example-shr1/smartctl-sdc-standby.json'),
    stderr: '',
  });
  const { run, calls } = fakeRunner(answers);
  const state = await readSystemState({ run, readFile: exampleShr1Files(), includeSmart: true });
  return { state, calls };
}

describe('readSystemState: the worked example', () => {
  it('produces a snapshot the shared schema accepts unchanged, SMART included', async () => {
    const { state } = await snapshot();
    expect(systemSnapshotSchema.parse(state)).toEqual(state);
  });

  it('finds every physical drive and its role', async () => {
    const { state } = await snapshot();
    expect(state.drives.map((drive) => [drive.device.name, drive.role])).toEqual([
      ['nvme0n1', 'system'],
      ['sda', 'ohr'],
      ['sdb', 'ohr'],
      ['sdc', 'ohr'],
    ]);
  });

  it('joins mdstat with mdadm detail for each array', async () => {
    const { state } = await snapshot();
    expect(
      state.mdArrays.map((array) => [array.path, array.status.level, array.detail?.devName]),
    ).toEqual([
      ['/dev/md126', 'raid1', 'ohr_p1_t2'],
      ['/dev/md127', 'raid5', 'ohr_p1_t1'],
    ]);
  });

  it('reads LVM and mounts', async () => {
    const { state } = await snapshot();
    expect(state.volumeGroups.map((vg) => vg.name)).toEqual(['ohr-p1']);
    expect(state.logicalVolumes.map((lv) => lv.path)).toEqual(['/dev/ohr-p1/data']);
    expect(state.mounts.some((mount) => mount.target === '/mnt/ohr/data')).toBe(true);
  });
});

describe('readSystemState: SMART and command arguments', () => {
  it('keeps SMART reports with health findings and skips sleeping drives', async () => {
    const { state } = await snapshot();
    const smart = new Map(state.drives.map((drive) => [drive.device.name, drive.smart]));
    expect(smart.get('sda')?.passed).toBe(true);
    expect(smart.get('sdb')?.passed).toBe(false);
    expect(smart.get('sdc')).toBeNull();
    expect(state.warnings).toEqual([
      'SMART data unavailable for /dev/sdc: Device is in STANDBY mode, exit(2)',
    ]);
  });

  it('never wakes a sleeping drive for SMART', async () => {
    const { calls } = await snapshot();
    const smartCalls = calls.filter((call) => call.command === 'smartctl');
    expect(smartCalls).toHaveLength(4);
    for (const call of smartCalls) {
      expect(call.args).toContain('--nocheck=standby');
    }
  });

  it('asks lsblk for exactly the columns the parser reads', async () => {
    const { calls } = await snapshot();
    const lsblk = calls.find((call) => call.command === 'lsblk');
    expect(lsblk?.args).toEqual([
      '--json',
      '--bytes',
      '--output',
      'NAME,PATH,PKNAME,TYPE,SIZE,MODEL,SERIAL,WWN,TRAN,ROTA,RM,RO,FSTYPE,UUID,PARTUUID,PARTLABEL,PARTTYPE,START,MOUNTPOINTS',
    ]);
  });
});

describe('readSystemState: partial and failed reads', () => {
  it('skips SMART unless asked', async () => {
    const { run, calls } = fakeRunner(exampleShr1Answers());
    const state = await readSystemState({ run, readFile: exampleShr1Files(), includeSmart: false });
    expect(state.drives.every((drive) => drive.smart === null)).toBe(true);
    expect(calls.some((call) => call.command === 'smartctl')).toBe(false);
  });

  it('carries on with warnings when mdadm and LVM are missing', async () => {
    const answers = exampleShr1Answers();
    for (const key of ['pvs', 'vgs', 'lvs', 'mdadm /dev/md126', 'mdadm /dev/md127']) {
      answers.delete(key);
    }
    const { run } = fakeRunner(answers);
    const state = await readSystemState({ run, readFile: exampleShr1Files(), includeSmart: false });
    expect(state.mdArrays.map((array) => array.detail)).toEqual([null, null]);
    expect(state.volumeGroups).toEqual([]);
    expect(state.warnings).toContain('mdadm is not installed');
    expect(state.warnings).toContain('pvs is not installed');
  });

  it('reports no arrays when the md driver is not loaded', async () => {
    const { run } = fakeRunner(exampleShr1Answers());
    const state = await readSystemState({
      run,
      readFile: fakeFiles(new Map()),
      includeSmart: false,
    });
    expect(state.mdArrays).toEqual([]);
    expect(state.warnings).toEqual([]);
  });

  it('turns unparseable output into a warning', async () => {
    const answers = exampleShr1Answers();
    answers.set('vgs', ok('not json'));
    const { run } = fakeRunner(answers);
    const state = await readSystemState({ run, readFile: exampleShr1Files(), includeSmart: false });
    expect(state.volumeGroups).toEqual([]);
    expect(state.warnings).toEqual([
      'ParseError: Could not parse vgs output: output is not valid JSON',
    ]);
  });

  it('fails when lsblk fails, because nothing else is meaningful without it', async () => {
    const answers = exampleShr1Answers();
    answers.set('lsblk', { kind: 'exited', exitCode: 1, stdout: '', stderr: 'lsblk: boom' });
    const { run } = fakeRunner(answers);
    await expect(
      readSystemState({ run, readFile: exampleShr1Files(), includeSmart: false }),
    ).rejects.toThrow(SystemStateError);
  });
});

describe('readDrives', () => {
  it('reads real VM output with only lsblk', async () => {
    const { run, calls } = fakeRunner(new Map([['lsblk', ok(fixture('virtio-vm/lsblk.json'))]]));
    const drives = await readDrives(run);
    expect(calls.map((call) => call.command)).toEqual(['lsblk']);
    expect(drives.map((drive) => [drive.device.name, drive.role])).toEqual([
      ['vda', 'system'],
      ['vdb', 'in-use'],
      ['vdc', 'in-use'],
      ['vdd', 'in-use'],
      ['vde', 'in-use'],
      ['vdf', 'in-use'],
    ]);
  });
});
