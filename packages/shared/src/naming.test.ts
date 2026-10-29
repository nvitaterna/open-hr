import { describe, expect, it } from 'vitest';

import {
  assertPoolId,
  isOhrPartitionLabel,
  isValidPoolId,
  labelPartitionLabel,
  mdArrayName,
  PoolIdError,
  parseMdArrayName,
  parsePartitionLabel,
  tierPartitionLabel,
  volumeGroupName,
} from './naming.ts';

describe('naming', () => {
  it('builds the names described in the plan', () => {
    expect(mdArrayName('p1', 2)).toBe('ohr_p1_t2');
    expect(volumeGroupName('p1')).toBe('ohr-p1');
    expect(tierPartitionLabel('p1', 1)).toBe('ohr-p1-t1');
    expect(labelPartitionLabel('p1')).toBe('ohr-p1-label');
  });

  it.each(['ohr-p1-t1', 'ohr-p1-t12', 'ohr-abcdefgh-label'])('recognises %j', (label) => {
    expect(isOhrPartitionLabel(label)).toBe(true);
  });

  it.each(['ohr:p1:t1', 'ohr-p1-t0', 'ohr-p1', 'ohr-P1-t1', 'ohr-p1-t1-old', 'xohr-p1-t1'])(
    'does not recognise %j',
    (label) => {
      expect(isOhrPartitionLabel(label)).toBe(false);
    },
  );

  it.each(['', 'P1', 'pool_1', 'abcdefghi', 'a-b'])('rejects pool id %j', (poolId) => {
    expect(isValidPoolId(poolId)).toBe(false);
    expect(() => assertPoolId(poolId)).toThrow(PoolIdError);
    expect(() => mdArrayName(poolId, 1)).toThrow(PoolIdError);
  });
});

describe('parsePartitionLabel and parseMdArrayName', () => {
  it('split the names Open HR writes back into pool and tier', () => {
    expect(parsePartitionLabel(labelPartitionLabel('p1'))).toEqual({ poolId: 'p1', kind: 'label' });
    expect(parsePartitionLabel(tierPartitionLabel('p1', 12))).toEqual({
      poolId: 'p1',
      kind: 'tier',
      tier: 12,
    });
    expect(parseMdArrayName(mdArrayName('dev', 3))).toEqual({ poolId: 'dev', tier: 3 });
  });

  it.each(['', 'ohr-p1-t0', 'ohr-P1-label', 'ohr-p1-data', 'EFI system partition', 'ohr_p1_t1'])(
    'returns null for the partition name "%s"',
    (label) => {
      expect(parsePartitionLabel(label)).toBeNull();
    },
  );

  it.each(['', 'md127', 'ohr-p1-t1', 'ohr_p1_t0', 'ohr_toolongid_t1'])(
    'returns null for the array name "%s"',
    (name) => {
      expect(parseMdArrayName(name)).toBeNull();
    },
  );
});
