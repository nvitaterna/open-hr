/**
 * readPoolLayout from @ohr/shared/pool-layout, checked against snapshots of
 * the worked example. It lives here because building a snapshot from the
 * fixtures needs core's reader, as in pool-views.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { type LayoutReadResult, readPoolLayout } from '@ohr/shared/pool-layout';

import {
  exampleShr1Answers,
  exampleShr1Labels,
  fakeFiles,
  fakeRunner,
  fixture,
  ok,
} from './fake-system-test-helpers.ts';
import { readSystemState } from './system-state.ts';

const MIB = 1024 * 1024;
const TIER1_SLICE = 4_000_701_218_816;
const TIER2_SLICE = 4_000_776_716_288;
const SDC2_START = /(?<before>"name": "sdc2",[\s\S]*?"start": )34816/u;
const SDA2_MDSTAT =
  /md127 : active raid5 sdc2\[2\] sdb2\[1\] sda2\[0\]\n(?<blocks>.*)\[3\/3\] \[UUU\]/u;

interface Edits {
  readonly lsblk?: (text: string) => string;
  readonly mdstat?: (text: string) => string;
}

async function layout(poolId: string, edits: Edits = {}): Promise<LayoutReadResult> {
  const answers = exampleShr1Answers();
  const lsblk = edits.lsblk ?? ((text: string) => text);
  const mdstat = edits.mdstat ?? ((text: string) => text);
  answers.set('lsblk', ok(lsblk(fixture('example-shr1/lsblk.json'))));
  const snapshot = await readSystemState({
    run: fakeRunner(answers).run,
    readFile: fakeFiles(new Map([['/proc/mdstat', mdstat(fixture('example-shr1/mdstat.txt'))]])),
    includeSmart: false,
    labelIo: exampleShr1Labels(),
  });
  return readPoolLayout(snapshot, poolId);
}

describe('readPoolLayout: the worked example', () => {
  it('reads each tier where it sits, with its level, members, and first extent', async () => {
    const result = await layout('p1');
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.layout.redundancy).toBe('shr1');
    expect(result.layout.drives.map((drive) => [drive.id, drive.partitions.length])).toEqual([
      ['/dev/sda', 2],
      ['/dev/sdb', 3],
      ['/dev/sdc', 3],
    ]);
    expect(
      result.layout.tiers.map((tier) => ({
        tier: tier.tier,
        level: tier.level,
        offset: tier.offsetBytes,
        slice: tier.sliceBytes,
        members: tier.members.map((member) => member.drive),
        missing: tier.missingMembers,
        firstExtent: tier.firstExtentBytes,
      })),
    ).toEqual([
      {
        tier: 1,
        level: 'raid5',
        offset: 0,
        slice: TIER1_SLICE,
        members: ['/dev/sda', '/dev/sdb', '/dev/sdc'],
        missing: 0,
        firstExtent: MIB,
      },
      {
        tier: 2,
        level: 'raid1',
        offset: TIER1_SLICE,
        slice: TIER2_SLICE,
        members: ['/dev/sdb', '/dev/sdc'],
        missing: 0,
        firstExtent: MIB,
      },
    ]);
  });

  it('counts a slot no partition fills when a drive is gone', async () => {
    const result = await layout('p1', {
      mdstat: (text) =>
        text.replace(SDA2_MDSTAT, 'md127 : active raid5 sdc2[2] sdb2[1]\n$<blocks>[3/2] [_UU]'),
    });
    expect(result.ok && result.layout.tiers.map((tier) => tier.missingMembers)).toEqual([1, 0]);
  });

  it('refuses a tier whose partitions differ between drives', async () => {
    const result = await layout('p1', {
      lsblk: (text) => text.replace(SDC2_START, '$<before>35840'),
    });
    expect(result).toEqual({
      ok: false,
      reason: "Tier 1's partitions are not the same on every drive.",
    });
  });

  it('refuses when lsblk gives no partition starts', async () => {
    const result = await layout('p1', {
      lsblk: (text) => text.replaceAll('"start": 34816', '"start": null'),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'lsblk did not report the number and start of /dev/sda2.',
    });
  });

  it('refuses a pool that is not there', async () => {
    expect(await layout('nope')).toEqual({ ok: false, reason: 'There is no pool nope.' });
  });
});
