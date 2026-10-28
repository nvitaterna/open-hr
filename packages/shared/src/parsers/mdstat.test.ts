import { describe, expect, it } from 'vitest';

import { readFixture } from './fixtures-test-helpers.ts';
import { isDegraded, type MdstatArray, parseMdstat } from './mdstat.ts';
import { ParseError } from './parse-error.ts';

function byName(arrays: readonly MdstatArray[], name: string): MdstatArray {
  const array = arrays.find((candidate) => candidate.name === name);
  if (array === undefined) {
    throw new Error(`No array named ${name}`);
  }
  return array;
}

describe('parseMdstat: healthy pool', () => {
  const arrays = parseMdstat(readFixture('example-shr1/mdstat.txt'));

  it('finds both arrays with their members in slot order', () => {
    expect(arrays.map((array) => [array.name, array.level])).toEqual([
      ['md126', 'raid1'],
      ['md127', 'raid5'],
    ]);
    const md127 = byName(arrays, 'md127');
    expect(md127.members.map((member) => [member.device, member.slot])).toEqual([
      ['sdc2', 2],
      ['sdb2', 1],
      ['sda2', 0],
    ]);
    expect(md127.health).toEqual({ expectedDevices: 3, workingDevices: 3, memberMap: 'UUU' });
    expect(md127.sync).toBeNull();
    expect(isDegraded(md127)).toBe(false);
  });

  it('converts 1 KiB blocks to bytes', () => {
    expect(byName(arrays, 'md127').sizeBytes).toBe(8_001_134_002_176);
  });
});

describe('parseMdstat: every state', () => {
  const arrays = parseMdstat(readFixture('mdstat/states.txt'));

  it('reads a degraded array that is recovering onto a new member', () => {
    const md127 = byName(arrays, 'md127');
    expect(isDegraded(md127)).toBe(true);
    expect(md127.health?.memberMap).toBe('_UU');
    expect(md127.members.find((member) => member.device === 'sda2')?.faulty).toBe(true);
    expect(md127.sync).toEqual({
      action: 'recovery',
      state: 'running',
      percent: 8.5,
      doneBlocks: 332_211_200,
      totalBlocks: 3_906_886_144,
      finishMinutes: 301.2,
      speedKibPerSecond: 197_800,
    });
  });

  it('reads a delayed resync', () => {
    expect(byName(arrays, 'md126').sync).toMatchObject({ action: 'resync', state: 'delayed' });
  });

  it('reads a reshape and a check', () => {
    expect(byName(arrays, 'md125').sync).toMatchObject({ action: 'reshape', percent: 17.3 });
    expect(byName(arrays, 'md124').sync).toMatchObject({ action: 'check', percent: 50 });
  });

  it('reads a spare', () => {
    const spare = byName(arrays, 'md124').members.find((member) => member.device === 'sdf2');
    expect(spare).toMatchObject({ spare: true, faulty: false });
  });

  it('reads an inactive array with no level', () => {
    const md123 = byName(arrays, 'md123');
    expect(md123).toMatchObject({ active: false, level: null, health: null });
    expect(md123.members.every((member) => member.spare)).toBe(true);
  });

  it('reads read-only states and write-mostly members', () => {
    const md122 = byName(arrays, 'md122');
    expect(md122).toMatchObject({ autoReadOnly: true, readOnly: false, level: 'raid1' });
    expect(md122.members.find((member) => member.device === 'sdj1')?.writeMostly).toBe(true);
    const md121 = byName(arrays, 'md121');
    expect(md121).toMatchObject({ readOnly: true, autoReadOnly: false });
    expect(isDegraded(md121)).toBe(true);
  });

  it('finds every array in the file', () => {
    expect(arrays).toHaveLength(7);
  });
});

describe('parseMdstat: edge cases', () => {
  it('returns no arrays when there are none', () => {
    expect(parseMdstat('Personalities : \nunused devices: <none>\n')).toEqual([]);
  });

  it('rejects a malformed member', () => {
    expect(() => parseMdstat('md0 : active raid1 sda1[0] sdb1[x]\n')).toThrow(ParseError);
  });
});
