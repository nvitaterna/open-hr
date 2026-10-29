import type { ReactElement } from 'react';

import type { JobStatus } from '@ohr/shared/jobs';
import type { PoolHealth } from '@ohr/shared/pool-view';

type Tone = 'good' | 'busy' | 'bad' | 'quiet';

const TONE_CLASSES: Record<Tone, string> = {
  good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  busy: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  quiet: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

const STATUS_TONES: Record<PoolHealth | JobStatus, Tone> = {
  healthy: 'good',
  done: 'good',
  syncing: 'busy',
  rebuilding: 'busy',
  running: 'busy',
  pending: 'quiet',
  degraded: 'bad',
  unavailable: 'bad',
  failed: 'bad',
};

/** A pool's health or a job's status as a coloured label. The word carries the meaning, not the colour. */
export function StatusBadge({ status }: { readonly status: PoolHealth | JobStatus }): ReactElement {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[STATUS_TONES[status]]}`}
    >
      {status}
    </span>
  );
}
