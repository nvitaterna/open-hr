import { describe, expect, it } from 'vitest';

import type { DriveReplaceInput } from '@ohr/shared/drive-replace-input';

import type { FileReader } from '../command-runner.ts';
import {
  exampleLsblkWithEmptyDrive,
  exampleShr1Answers,
  exampleShr1Labels,
  fakeFiles,
  fakeRunner,
  fixture,
  ok,
} from '../fake-system-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { buildDriveReplaceJob } from './drive-replace.ts';
import { previewDriveReplace } from './drive-replace-preview.ts';
import type { Precondition, StepDefinition } from './engine.ts';

const EIGHT_TB = 8_001_563_222_016;
const TIER1 = '/dev/md/ohr_p1_t1';
const MD127_HEALTHY =
  /md127 : active raid5 sdc2\[2\] sdb2\[1\] sda2\[0\]\n(?<blocks>.*)\[3\/3\] \[UUU\]/u;
const BLOCKS = '      7813607424 blocks super 1.2 level 5, 512k chunk, algorithm 2';

/** /proc/mdstat with tier 1 (md127) showing these members and this health. */
function tier1(members: string, health: string, extra = ''): string {
  return fixture('example-shr1/mdstat.txt').replace(
    MD127_HEALTHY,
    `md127 : active raid5 ${members}\n${BLOCKS} ${health}${extra}`,
  );
}

interface Md {
  readonly mdstat: string;
  readonly action?: string;
  readonly degraded?: string;
  readonly wantReplacement?: string;
}

function files(md: Md): FileReader {
  const sysfs = '/sys/block/md127/md';
  const entries: [string, string][] = [
    ['/proc/mdstat', md.mdstat],
    [`${sysfs}/sync_action`, md.action ?? 'idle'],
    [`${sysfs}/reshape_position`, 'none'],
    [`${sysfs}/sync_completed`, 'none'],
    [`${sysfs}/degraded`, md.degraded ?? '0'],
  ];
  if (md.wantReplacement !== undefined) {
    entries.push([`${sysfs}/dev-${md.wantReplacement}/state`, 'in_sync,want_replacement']);
  }
  return fakeFiles(new Map(entries));
}

async function input(oldDrive: string | null, mdstat: string): Promise<DriveReplaceInput> {
  const answers = exampleShr1Answers();
  answers.set('lsblk', ok(exampleLsblkWithEmptyDrive('sdd', EIGHT_TB)));
  const snapshot = await readSystemState({
    run: fakeRunner(answers).run,
    readFile: fakeFiles(new Map([['/proc/mdstat', mdstat]])),
    includeSmart: false,
    labelIo: exampleShr1Labels(),
  });
  const result = previewDriveReplace(
    { poolId: 'p1', oldDrive, newDrive: '/dev/sdd', wipe: false },
    snapshot,
    snapshot.drives,
  );
  if (!result.ok) {
    throw new Error(result.reasons.join('; '));
  }
  return result.value;
}

async function steps(oldDrive: string | null, mdstat: string, md: Md): Promise<StepDefinition[]> {
  const job = buildDriveReplaceJob(await input(oldDrive, mdstat), {
    labelIo: exampleShr1Labels(),
    mdadmConfDir: '/nonexistent',
    files: files(md),
    kernelName: () => Promise.resolve('md127'),
    pollIntervalMs: 1,
    delay: () => Promise.resolve(),
  });
  return [...job.steps];
}

async function precondition(
  name: string,
  md: Md,
  oldDrive: string | null = '/dev/sdb',
): Promise<Precondition> {
  const healthy = fixture('example-shr1/mdstat.txt');
  const found = (await steps(oldDrive, healthy, md)).find((step) => step.name === name);
  if (found === undefined) {
    throw new Error(`no step ${name}`);
  }
  return found.precondition({
    run: fakeRunner(new Map()).run,
    log: () => undefined,
    progress: () => undefined,
  });
}

describe('buildDriveReplaceJob', () => {
  it('copies a healthy drive tier by tier and takes the old members out afterwards', async () => {
    const healthy = fixture('example-shr1/mdstat.txt');
    const names = (await steps('/dev/sdb', healthy, { mdstat: healthy })).map((step) => step.name);
    expect(names).toEqual([
      'partition /dev/sdd',
      'label /dev/sdd',
      'add members to tier 1',
      'replace /dev/sdb2 in tier 1',
      'wait for tier 1 copy',
      'remove /dev/sdb2 from tier 1',
      'add members to tier 2',
      'replace /dev/sdb3 in tier 2',
      'wait for tier 2 copy',
      'remove /dev/sdb3 from tier 2',
      'write mdadm config',
    ]);
  });

  it('rebuilds a drive that is gone, after clearing failed members', async () => {
    const mdstat = tier1('sdc2[2] sdb2[1]', '[3/2] [_UU]');
    const names = (await steps(null, mdstat, { mdstat })).map((step) => step.name);
    expect(names).toEqual([
      'partition /dev/sdd',
      'label /dev/sdd',
      'remove failed members from tier 1',
      'rebuild tier 1 onto /dev/sdd2',
      'wait for tier 1 rebuild',
      'write mdadm config',
    ]);
  });
});

describe('drive-replace md steps', () => {
  const healthy = fixture('example-shr1/mdstat.txt');
  const withSpare = tier1('sdd2[3](S) sdc2[2] sdb2[1] sda2[0]', '[3/3] [UUU]');
  const copying = tier1('sdd2[3](R) sdc2[2] sdb2[1] sda2[0]', '[3/3] [UUU]');
  const swapped = tier1('sdd2[3] sdc2[2] sdb2[1](F) sda2[0]', '[3/3] [UUU]');
  const done = tier1('sdd2[3] sdc2[2] sda2[0]', '[3/3] [UUU]');
  const degraded = tier1('sdc2[2] sda2[0]', '[3/2] [U_U]');
  const replace = 'replace /dev/sdb2 in tier 1';
  const remove = 'remove /dev/sdb2 from tier 1';

  it('replaces only once the new partition is a spare, and not twice', async () => {
    expect(await precondition(replace, { mdstat: withSpare })).toEqual({ kind: 'ready' });
    expect(await precondition(replace, { mdstat: healthy })).toEqual({
      kind: 'blocked',
      reason: `/dev/sdd2 is not in ${TIER1}`,
    });
    expect(await precondition(replace, { mdstat: copying })).toMatchObject({
      kind: 'already-done',
    });
    expect(await precondition(replace, { mdstat: swapped })).toMatchObject({
      kind: 'already-done',
    });
    expect(
      await precondition(replace, { mdstat: withSpare, wantReplacement: 'sdb2' }),
    ).toMatchObject({ kind: 'already-done' });
  });

  it('removes the old member only once it no longer holds data', async () => {
    expect(await precondition(remove, { mdstat: swapped })).toEqual({ kind: 'ready' });
    expect(await precondition(remove, { mdstat: done })).toMatchObject({ kind: 'already-done' });
    expect(await precondition(remove, { mdstat: copying })).toEqual({
      kind: 'blocked',
      reason: `/dev/sdb2 still holds data in ${TIER1}`,
    });
  });

  it('rebuilds only onto a degraded array', async () => {
    const rebuild = 'rebuild tier 1 onto /dev/sdd2';
    const failed = tier1('sdc2[2] sdb2[1](F) sda2[0]', '[3/2] [U_U]');
    const job = await steps('/dev/sdb', failed, { mdstat: degraded, degraded: '1' });
    const step = job.find((candidate) => candidate.name === rebuild);
    const context = {
      run: fakeRunner(new Map()).run,
      log: () => undefined,
      progress: () => undefined,
    };
    expect(await step?.precondition(context)).toEqual({ kind: 'ready' });
    const notDegraded = await steps('/dev/sdb', failed, { mdstat: healthy });
    expect(
      await notDegraded.find((candidate) => candidate.name === rebuild)?.precondition(context),
    ).toMatchObject({ kind: 'blocked' });
  });
});
