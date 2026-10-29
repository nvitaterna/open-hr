import type { ReactElement } from 'react';

import { formatSize } from '@ohr/shared/sizes';

const PERCENT = 100;

interface CapacityBarProps {
  /** The pool's size, or null when its volume group is not active. */
  readonly sizeBytes: number | null;
  /** Space volumes have taken from the pool. */
  readonly allocatedBytes: number;
}

/** How much of a pool its volumes take. */
export function CapacityBar({ sizeBytes, allocatedBytes }: CapacityBarProps): ReactElement {
  if (sizeBytes === null || sizeBytes === 0) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Capacity unknown</p>;
  }
  const percent = Math.min(PERCENT, Math.round((allocatedBytes / sizeBytes) * PERCENT));
  return (
    <div>
      <meter className="sr-only" min={0} max={PERCENT} value={percent}>
        {percent}% given to volumes
      </meter>
      {/* Drawn as SVG: the strict CSP (decision 0010) rules out an inline style for the width. */}
      <svg
        className="block h-2 w-full overflow-hidden rounded-full"
        aria-hidden={true}
        preserveAspectRatio="none"
        viewBox={`0 0 ${PERCENT} 1`}
      >
        <rect className="fill-zinc-200 dark:fill-zinc-800" width={PERCENT} height={1} />
        <rect className="fill-emerald-600" width={percent} height={1} />
      </svg>
      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
        {formatSize(allocatedBytes)} of {formatSize(sizeBytes)} given to volumes
      </p>
    </div>
  );
}
