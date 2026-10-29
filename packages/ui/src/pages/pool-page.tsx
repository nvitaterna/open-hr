import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router';

import type { PoolView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { isNotFound, usePool } from '../api/queries.ts';
import { CapacityBar } from '../components/capacity-bar.tsx';
import { DataTable } from '../components/data-table.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { Panel, Section } from '../components/section.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { CELL, NONE } from '../components/table-styles.ts';
import { TierDiagram } from '../components/tier-diagram.tsx';
import { TierTable } from '../components/tier-table.tsx';
import { VolumeTable } from '../components/volume-table.tsx';
import { REDUNDANCY_LABELS } from '../labels.ts';
import { layoutTiers } from '../tier-layout.ts';

const DRIVE_HEADINGS = ['Drive', 'Model', 'Serial', 'Size', 'Label'];

function Drives({ pool }: { readonly pool: PoolView }): ReactElement {
  return (
    <DataTable headings={DRIVE_HEADINGS}>
      {pool.drives.map((drive) => (
        <tr key={drive.path}>
          <th scope="row" className={`${CELL} text-left font-medium`}>
            {drive.path}
          </th>
          <td className={CELL}>{drive.model ?? NONE}</td>
          <td className={`${CELL} font-mono text-xs`}>{drive.serial ?? NONE}</td>
          <td className={`${CELL} text-right tabular-nums`}>{formatSize(drive.sizeBytes)}</td>
          <td className={CELL}>{drive.label}</td>
        </tr>
      ))}
    </DataTable>
  );
}

function Summary({ pool }: { readonly pool: PoolView }): ReactElement {
  let redundancy = 'Redundancy unknown';
  if (pool.redundancy !== null) {
    redundancy = REDUNDANCY_LABELS[pool.redundancy];
  }
  const allocated = (pool.sizeBytes ?? 0) - (pool.freeBytes ?? 0);
  return (
    <Panel>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{redundancy}</p>
      <div className="mt-3">
        <CapacityBar sizeBytes={pool.sizeBytes} allocatedBytes={allocated} />
      </div>
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

function PoolDetail({ pool }: { readonly pool: PoolView }): ReactElement {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Pool {pool.id}</h1>
        <StatusBadge status={pool.health} />
      </div>
      <Summary pool={pool} />
      <Section title="Layout">
        <Panel>
          <TierDiagram
            diagram={layoutTiers(pool)}
            title={`Pool ${pool.id}: ${pool.drives.length} drives, ${pool.tiers.length} tiers`}
          />
        </Panel>
        <TierTable tiers={pool.tiers} />
      </Section>
      <Section
        title="Volumes"
        aside={
          <Link
            to={`/pools/${encodeURIComponent(pool.id)}/volumes/new`}
            className="text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
          >
            Create volume
          </Link>
        }
      >
        <VolumeTable
          items={pool.volumes.map((volume) => ({ poolId: pool.id, volume }))}
          showPool={false}
        />
      </Section>
      <Section title="Drives">
        <Drives pool={pool} />
      </Section>
    </div>
  );
}

/** One pool: its health, capacity, tier layout, volumes, and drives (plan section 5.6). */
export function PoolPage(): ReactElement {
  const { id = '' } = useParams();
  const pool = usePool(id);
  if (pool.isPending) {
    return <Loading what={`pool ${id}`} />;
  }
  if (pool.isError) {
    if (isNotFound(pool.error)) {
      return <ErrorMessage error={new Error(`There is no pool named ${id}.`)} />;
    }
    return <ErrorMessage error={pool.error} />;
  }
  return <PoolDetail pool={pool.data.pool} />;
}
