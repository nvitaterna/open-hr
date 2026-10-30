import type { ReactElement } from 'react';
import { Link } from 'react-router';

import type { PoolView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { REDUNDANCY_LABELS } from '../labels.ts';
import { CapacityBar } from './capacity-bar.tsx';
import { Panel } from './section.tsx';
import { StatusBadge } from './status-badge.tsx';

function VolumeLine({ volume }: { readonly volume: PoolView['volumes'][number] }): ReactElement {
  let usage = 'not mounted';
  if (volume.mountPoint !== null) {
    usage = volume.mountPoint;
    if (volume.usedBytes !== null) {
      usage += `, ${formatSize(volume.usedBytes)} used`;
    }
  }
  return (
    <li className="flex flex-wrap justify-between gap-x-4 text-sm">
      <span className="font-medium">{volume.name}</span>
      <span className="text-zinc-600 dark:text-zinc-400">
        {formatSize(volume.sizeBytes)} {volume.filesystem ?? ''}, {usage}
      </span>
    </li>
  );
}

/** A pool on the dashboard: health, redundancy, capacity, volumes, and warnings. */
export function PoolCard({ pool }: { readonly pool: PoolView }): ReactElement {
  let redundancy = 'Redundancy unknown';
  if (pool.redundancy !== null) {
    redundancy = REDUNDANCY_LABELS[pool.redundancy];
  }
  const allocated = (pool.sizeBytes ?? 0) - (pool.freeBytes ?? 0);
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold">
          <Link
            to={`/pools/${encodeURIComponent(pool.id)}`}
            className="text-emerald-700 hover:underline dark:text-emerald-400"
          >
            {pool.id}
          </Link>
        </h3>
        <StatusBadge status={pool.health} />
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          {redundancy} · {pool.drives.filter((drive) => drive.membership === 'member').length}{' '}
          drives · {pool.tiers.length} tiers
        </span>
      </div>
      <div className="mt-4">
        <CapacityBar sizeBytes={pool.sizeBytes} allocatedBytes={allocated} />
      </div>
      {pool.volumes.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          {pool.volumes.map((volume) => (
            <VolumeLine key={volume.name} volume={volume} />
          ))}
        </ul>
      )}
      {pool.warnings.length > 0 && (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-300">
          {pool.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
