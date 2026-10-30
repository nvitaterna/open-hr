import type { ReactElement } from 'react';

import type { JobProgress } from '../api/queries.ts';

const PERCENT = 100;
/** The percentage is shown in tenths, rounded down so it reads 100 only when done. */
const TENTHS = 10;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** Time left as minutes, or hours and minutes past the first hour. */
function formatEta(seconds: number): string {
  const minutes = Math.ceil(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `about ${minutes} min left`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `about ${hours} h ${minutes % MINUTES_PER_HOUR} min left`;
}

function summary(progress: JobProgress, percent: number | null): string {
  const parts: string[] = [progress.operation];
  if (percent === null) {
    parts.push('waiting for another array on the same drives');
  } else {
    parts.push(`${percent.toFixed(1)}%`);
  }
  if (progress.etaSeconds !== null) {
    parts.push(formatEta(progress.etaSeconds));
  }
  return parts.join(', ');
}

/** How far a running step's md work is, from the last `job.progress` event (decision 0011). */
export function StepProgress({ progress }: { readonly progress: JobProgress }): ReactElement {
  let percent: number | null = null;
  if (progress.fraction !== null) {
    percent = Math.floor(progress.fraction * PERCENT * TENTHS) / TENTHS;
  }
  const text = summary(progress, percent);
  return (
    <div className="mt-2">
      <meter
        className="sr-only"
        aria-label={`${progress.operation} progress`}
        min={0}
        max={PERCENT}
        value={percent ?? 0}
      />
      {/* Drawn as SVG: the strict CSP (decision 0010) rules out an inline style for the width. */}
      <svg
        className="block h-2 w-full overflow-hidden rounded-full"
        aria-hidden={true}
        preserveAspectRatio="none"
        viewBox={`0 0 ${PERCENT} 1`}
      >
        <rect className="fill-zinc-200 dark:fill-zinc-800" width={PERCENT} height={1} />
        <rect className="fill-emerald-600" width={percent ?? 0} height={1} />
      </svg>
      <p className="mt-1.5 text-sm tabular-nums text-zinc-600 dark:text-zinc-400">{text}</p>
    </div>
  );
}
