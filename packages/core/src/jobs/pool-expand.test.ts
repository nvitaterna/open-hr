import { describe, expect, it } from 'vitest';

import type { PoolExpandInput } from '@ohr/shared/pool-expand-input';

import type { CommandResult, FileReader } from '../command-runner.ts';
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
import type { Precondition, StepContext, StepDefinition } from './engine.ts';
import { buildPoolExpandJob, type PoolExpandDeps } from './pool-expand.ts';
import { previewPoolExpand } from './pool-expand-preview.ts';

const EIGHT_TB = 8_001_563_222_016;
const TIER2 = '/dev/md/ohr_p1_t2';
const SYSFS = '/sys/block/md126/md';

/** mdadm --detail --export for tier 2 with the given level, member count, and members. */
function tier2Detail(level: string, raidDevices: number, members: Record<string, string>): string {
  const lines = [
    `MD_LEVEL=${level}`,
    `MD_DEVICES=${raidDevices}`,
    'MD_METADATA=1.2',
    'MD_UUID=0c1a2b3d:4e5f6a7b:8c9d0e1f:2a3b4c5d',
    'MD_DEVNAME=ohr_p1_t2',
    'MD_NAME=any:ohr_p1_t2',
  ];
  for (const [device, role] of Object.entries(members)) {
    const id = device.replaceAll('/', '_').slice(1);
    lines.push(`MD_DEVICE_${id}_ROLE=${role}`, `MD_DEVICE_${id}_DEV=${device}`);
  }
  return `${lines.join('\n')}\n`;
}

interface Sysfs {
  readonly action?: string;
  readonly degraded?: string;
  readonly chunk?: string;
}

function sysfs(state: Sysfs = {}): FileReader {
  return fakeFiles(
    new Map([
      ['/proc/mdstat', fixture('example-shr1/mdstat.txt')],
      [`${SYSFS}/sync_action`, state.action ?? 'idle'],
      [`${SYSFS}/reshape_position`, 'none'],
      [`${SYSFS}/sync_completed`, 'none'],
      [`${SYSFS}/degraded`, state.degraded ?? '0'],
      [`${SYSFS}/chunk_size`, state.chunk ?? '65536'],
    ]),
  );
}

async function exampleInput(): Promise<PoolExpandInput> {
  const answers = exampleShr1Answers();
  answers.set('lsblk', ok(exampleLsblkWithEmptyDrive('sdd', EIGHT_TB)));
  const snapshot = await readSystemState({
    run: fakeRunner(answers).run,
    readFile: sysfs(),
    includeSmart: false,
    labelIo: exampleShr1Labels(),
  });
  const result = previewPoolExpand(
    { poolId: 'p1', devices: ['/dev/sdd'], wipe: false },
    snapshot,
    snapshot.drives,
  );
  if (!result.ok) {
    throw new Error(result.reasons.join('; '));
  }
  return result.value;
}

function deps(files: FileReader): PoolExpandDeps {
  return {
    labelIo: exampleShr1Labels(),
    mdadmConfDir: '/nonexistent',
    files,
    kernelName: () => Promise.resolve('md126'),
    pollIntervalMs: 1,
    delay: () => Promise.resolve(),
  };
}

async function step(name: string, files: FileReader = sysfs()): Promise<StepDefinition> {
  const job = buildPoolExpandJob(await exampleInput(), deps(files));
  const found = job.steps.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no step ${name}`);
  }
  return found;
}

function context(answers: ReadonlyMap<string, CommandResult>): StepContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    run: fakeRunner(answers).run,
    log: (line) => lines.push(line),
    progress: () => undefined,
    lines,
  };
}

function detailAnswers(detail: string): Map<string, CommandResult> {
  return new Map([[`mdadm ${TIER2}`, ok(detail)]]);
}

async function precondition(
  name: string,
  detail: string,
  files: FileReader = sysfs(),
): Promise<Precondition> {
  return (await step(name, files)).precondition(context(detailAnswers(detail)));
}

describe('buildPoolExpandJob', () => {
  it('converts tier 2, grows it, and only then sets its chunk', async () => {
    const job = buildPoolExpandJob(await exampleInput(), deps(sysfs()));
    expect(job).toMatchObject({ kind: 'pool-expand', poolId: 'p1' });
    expect(job.steps.map((candidate) => candidate.name)).toEqual([
      'partition /dev/sdd',
      'label /dev/sdd',
      'add members to tier 1',
      'grow tier 1 to 4 members',
      'wait for tier 1 reshape',
      'convert tier 2 to RAID5',
      'add members to tier 2',
      'grow tier 2 to 3 members',
      'wait for tier 2 reshape',
      'set tier 2 chunk',
      'wait for tier 2 chunk change',
      'resize tier 1 physical volume',
      'resize tier 2 physical volume',
      'write mdadm config',
    ]);
  });

  it('grows a named volume into the new space after everything else', async () => {
    const input = await exampleInput();
    const job = buildPoolExpandJob(
      {
        ...input,
        growVolume: {
          name: 'data',
          filesystem: 'btrfs',
          mountPoint: '/mnt/ohr/data',
          size: { kind: 'all-free' },
        },
      },
      deps(sysfs()),
    );
    expect(job.steps.slice(-3).map((candidate) => candidate.name)).toEqual([
      'write mdadm config',
      'extend volume data',
      'grow filesystem of data',
    ]);
    expect(job.steps.at(-2)?.commands).toEqual(['lvextend --extents +100%FREE /dev/ohr-p1/data']);
  });

  it('shows the exact commands, without a backup file', async () => {
    const job = buildPoolExpandJob(await exampleInput(), deps(sysfs()));
    const commands = job.steps.flatMap((candidate) => candidate.commands);
    expect(commands).toContain('mdadm --manage /dev/md/ohr_p1_t2 --add /dev/sdd3');
    expect(commands).toContain('mdadm --grow /dev/md/ohr_p1_t2 --level=5');
    expect(commands).toContain('mdadm --grow /dev/md/ohr_p1_t2 --raid-devices=3');
    expect(commands).toContain('mdadm --grow /dev/md/ohr_p1_t2 --chunk=512');
    expect(commands).toContain('pvresize /dev/md/ohr_p1_t2');
    expect(commands.some((command) => command.includes('backup-file'))).toBe(false);
  });
});

describe('pool-expand md steps', () => {
  const raid1 = tier2Detail('raid1', 2, { '/dev/sdb3': '0', '/dev/sdc3': '1' });
  const raid5Two = tier2Detail('raid5', 2, { '/dev/sdb3': '0', '/dev/sdc3': '1' });
  const raid5Spare = tier2Detail('raid5', 2, {
    '/dev/sdb3': '0',
    '/dev/sdc3': '1',
    '/dev/sdd3': 'spare',
  });
  const raid5Three = tier2Detail('raid5', 3, {
    '/dev/sdb3': '0',
    '/dev/sdc3': '1',
    '/dev/sdd3': '2',
  });

  it('converts a two-member RAID1 once, and refuses while it is busy', async () => {
    expect(await precondition('convert tier 2 to RAID5', raid1)).toEqual({ kind: 'ready' });
    expect(await precondition('convert tier 2 to RAID5', raid5Two)).toMatchObject({
      kind: 'already-done',
    });
    expect(
      await precondition('convert tier 2 to RAID5', raid1, sysfs({ action: 'resync' })),
    ).toEqual({ kind: 'blocked', reason: `${TIER2} is running a resync` });
  });

  it('adds members once, and never to a degraded array', async () => {
    expect(await precondition('add members to tier 2', raid5Two)).toEqual({ kind: 'ready' });
    expect(await precondition('add members to tier 2', raid5Spare)).toMatchObject({
      kind: 'already-done',
    });
    expect(await precondition('add members to tier 2', raid5Two, sysfs({ degraded: '1' }))).toEqual(
      {
        kind: 'blocked',
        reason: `${TIER2} is degraded. Replace the missing drive first`,
      },
    );
  });

  it('grows once there are enough spares, and skips a grow that already happened', async () => {
    expect(await precondition('grow tier 2 to 3 members', raid5Spare)).toEqual({ kind: 'ready' });
    expect(await precondition('grow tier 2 to 3 members', raid5Three)).toMatchObject({
      kind: 'already-done',
    });
    expect(await precondition('grow tier 2 to 3 members', raid5Two)).toEqual({
      kind: 'blocked',
      reason: `${TIER2} has 0 spares, too few to grow to 3`,
    });
  });

  it('sets the chunk only with three members, and counts a change under way as done', async () => {
    expect(await precondition('set tier 2 chunk', raid5Three)).toEqual({ kind: 'ready' });
    expect(await precondition('set tier 2 chunk', raid5Two)).toEqual({
      kind: 'blocked',
      reason: `${TIER2} has 2 members; its chunk changes after it grows`,
    });
    expect(
      await precondition('set tier 2 chunk', raid5Three, sysfs({ chunk: '524288 (65536)' })),
    ).toMatchObject({ kind: 'already-done' });
    // Changing away from 512 KiB, to 64 KiB: not this step's work.
    expect(
      await precondition('set tier 2 chunk', raid5Three, sysfs({ chunk: '65536 (524288)' })),
    ).toEqual({ kind: 'ready' });
    expect(
      await precondition('set tier 2 chunk', raid5Three, sysfs({ chunk: '524288' })),
    ).toMatchObject({ kind: 'already-done' });
  });

  it('waits until the array is idle', async () => {
    let reads = 0;
    const files: FileReader = (path) => {
      if (path.endsWith('sync_action')) {
        reads += 1;
        if (reads < 3) {
          return Promise.resolve('reshape');
        }
        return Promise.resolve('idle');
      }
      return sysfs()(path);
    };
    const wait = await step('wait for tier 2 reshape', files);
    const ctx = context(new Map());
    await wait.action(ctx);
    await wait.postcondition(ctx);
    expect(reads).toBeGreaterThanOrEqual(4);
  });
});
