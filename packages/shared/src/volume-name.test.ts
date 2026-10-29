import { describe, expect, it } from 'vitest';

import { assertVolumeName, isValidVolumeName, VolumeNameError } from './volume-name.ts';

describe('volume names', () => {
  it.each(['data', 'media-2', 'a', 'backup_old', 'x'.repeat(32)])('accepts %j', (name) => {
    expect(isValidVolumeName(name)).toBe(true);
    expect(() => assertVolumeName(name)).not.toThrow();
  });

  it.each([
    '',
    'Data',
    '-data',
    '_data',
    'my data',
    'data.old',
    'x'.repeat(33),
    'snapshot',
    'pvmove',
    'data_rimage',
    'x_tmeta_y',
  ])('rejects %j', (name) => {
    expect(isValidVolumeName(name)).toBe(false);
    expect(() => assertVolumeName(name)).toThrow(VolumeNameError);
  });
});
