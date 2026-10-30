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

interface VolumeRowProps {
  readonly item: PoolVolume;
  readonly showPool: boolean;
  readonly showGrow: boolean;
}

function GrowCell({ item }: { readonly item: PoolVolume }): ReactElement {
  const { volume, poolId } = item;
  // Only a mounted filesystem can be grown online.
  if (volume.mountPoint === null) {
    return <td className={CELL}>{NONE}</td>;
  }
  return (
    <td className={CELL}>
      <Link
        to={`/pools/${encodeURIComponent(poolId)}/volumes/${encodeURIComponent(volume.name)}/grow`}
        className={LINK}
        aria-label={`Grow ${volume.name}`}
      >
        Grow
      </Link>
    </td>
  );
}

function VolumeRow({ item, showPool, showGrow }: VolumeRowProps): ReactElement {
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
  let grow: ReactElement | null = null;
  if (showGrow) {
    grow = <GrowCell item={item} />;
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
      {grow}
    </tr>
  );
}

interface VolumeTableProps {
  readonly items: readonly PoolVolume[];
  /** Adds a column linking each volume's pool. */
  readonly showPool: boolean;
  /** Adds a column with a Grow link for each mounted volume. */
  readonly showGrow: boolean;
}

export interface PoolVolume {
  readonly poolId: string;
  readonly volume: VolumeView;
}

/** Volumes with filesystem, size, mount point, and how full they are. */
export function VolumeTable({ items, showPool, showGrow }: VolumeTableProps): ReactElement {
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">No volumes yet.</p>;
  }
  const headings = ['Volume', 'Filesystem', 'Size', 'Mount point', 'Used'];
  if (showPool) {
    headings.splice(1, 0, 'Pool');
  }
  if (showGrow) {
    headings.push('Actions');
  }
  return (
    <DataTable headings={headings}>
      {items.map((item) => (
        <VolumeRow
          key={`${item.poolId}/${item.volume.name}`}
          item={item}
          showPool={showPool}
          showGrow={showGrow}
        />
      ))}
    </DataTable>
  );
}
