import { describe, expect, it } from 'vitest';

import {
  assertPoolId,
  isValidPoolId,
  labelPartitionLabel,
  mdArrayName,
  PoolIdError,
  tierPartitionLabel,
  volumeGroupName,
} from './naming.ts';

describe('naming', () => {
  it('builds the names described in the plan', () => {
    expect(mdArrayName('p1', 2)).toBe('ohr_p1_t2');
    expect(volumeGroupName('p1')).toBe('ohr-p1');
    expect(tierPartitionLabel('p1', 1)).toBe('ohr:p1:t1');
    expect(labelPartitionLabel('p1')).toBe('ohr:p1:label');
  });

  it.each(['', 'P1', 'pool_1', 'abcdefghi', 'a-b'])('rejects pool id %j', (poolId) => {
    expect(isValidPoolId(poolId)).toBe(false);
    expect(() => assertPoolId(poolId)).toThrow(PoolIdError);
    expect(() => mdArrayName(poolId, 1)).toThrow(PoolIdError);
  });
});
