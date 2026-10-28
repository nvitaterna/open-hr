import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOUNT_ROOT,
  DEFAULT_WEB_PORT,
  END_OF_DRIVE_RESERVE_BYTES,
  FAULT_TOLERANCE,
  LABEL_PARTITION_BYTES,
  MIN_DRIVES,
  PARTITION_ALIGNMENT_BYTES,
  SHORT_NAME,
} from './constants.ts';

describe('constants', () => {
  it('matches the decisions recorded in the plan', () => {
    expect(SHORT_NAME).toBe('ohr');
    expect(DEFAULT_WEB_PORT).toBe(7700);
    expect(DEFAULT_MOUNT_ROOT).toBe('/mnt/ohr');
    expect(MIN_DRIVES).toEqual({ shr1: 2, shr2: 4 });
  });

  it('requires more drives than the number of failures tolerated', () => {
    for (const level of ['shr1', 'shr2'] as const) {
      expect(MIN_DRIVES[level]).toBeGreaterThan(FAULT_TOLERANCE[level]);
    }
  });

  it('keeps reserved regions aligned', () => {
    expect(END_OF_DRIVE_RESERVE_BYTES % PARTITION_ALIGNMENT_BYTES).toBe(0);
    expect(LABEL_PARTITION_BYTES % PARTITION_ALIGNMENT_BYTES).toBe(0);
  });
});
