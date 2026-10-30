/** Words the UI shows for values from the API. */

import type { JobKind } from '@ohr/shared/jobs';
import type { DriveRole } from '@ohr/shared/system-snapshot';

export const ROLE_LABELS: Record<DriveRole, string> = {
  ohr: 'Pool member',
  empty: 'Unused',
  'in-use': 'In use',
  system: 'Operating system',
};

export const REDUNDANCY_LABELS: Record<'shr1' | 'shr2', string> = {
  shr1: 'SHR-1, survives one drive failure',
  shr2: 'SHR-2, survives two drive failures',
};

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  'pool-create': 'Create pool',
  'volume-create': 'Create volume',
  'pool-expand': 'Grow pool',
  'drive-replace': 'Replace drive',
};

/** A date and time in the browser's locale. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
