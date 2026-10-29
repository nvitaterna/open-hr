import type { ReactElement } from 'react';
import { Link } from 'react-router';

import type { VolumeView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { DataTable } from './data-table.tsx';
import { CELL, NONE } from './table-styles.ts';

const PERCENT = 100;
const LINK = 'font-medium text-emerald-700 hover:underline dark:text-emerald-400';

function usage(volume: VolumeView): string {
  if (volume.usedBytes === null || volume.availableBytes === null) {
    return NONE;
  }
  const total = volume.usedBytes + volume.availableBytes;
  let percent = 0;
  if (total > 0) {
    percent = Math.round((volume.usedBytes / total) * PERCENT);
  }
  return `${formatSize(volume.usedBytes)} of ${formatSize(total)} (${percent}%)`;
}

function VolumeRow({ item, showPool }: { item: PoolVolume; showPool: boolean }): ReactElement {
  const { volume, poolId } = item;
  let pool: ReactElement | null = null;
  if (showPool) {
    pool = (
      <td className={CELL}>
        <Link to={`/pools/${encodeURIComponent(poolId)}`} className={LINK}>
          {poolId}
        </Link>
      </td>
    );
  }
  return (
    <tr>
      <th scope="row" className={`${CELL} text-left font-medium`}>
        {volume.name}
      </th>
      {pool}
      <td className={CELL}>{volume.filesystem ?? NONE}</td>
      <td className={`${CELL} text-right tabular-nums`}>{formatSize(volume.sizeBytes)}</td>
      <td className={`${CELL} font-mono text-xs`}>{volume.mountPoint ?? 'not mounted'}</td>
      <td className={`${CELL} tabular-nums`}>{usage(volume)}</td>
    </tr>
  );
}

interface VolumeTableProps {
  readonly items: readonly PoolVolume[];
  /** Adds a column linking each volume's pool. */
  readonly showPool: boolean;
}

export interface PoolVolume {
  readonly poolId: string;
  readonly volume: VolumeView;
}

/** Volumes with filesystem, size, mount point, and how full they are. */
export function VolumeTable({ items, showPool }: VolumeTableProps): ReactElement {
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">No volumes yet.</p>;
  }
  const headings = ['Volume', 'Filesystem', 'Size', 'Mount point', 'Used'];
  if (showPool) {
    headings.splice(1, 0, 'Pool');
  }
  return (
    <DataTable headings={headings}>
      {items.map((item) => (
        <VolumeRow key={`${item.poolId}/${item.volume.name}`} item={item} showPool={showPool} />
      ))}
    </DataTable>
  );
}
