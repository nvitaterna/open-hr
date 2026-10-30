import type { ReactElement } from 'react';

import { usePools } from '../api/queries.ts';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { VolumeTable } from '../components/volume-table.tsx';

/** Every volume on every pool (plan section 5.6). */
export function VolumesPage(): ReactElement {
  const pools = usePools();
  let body: ReactElement;
  if (pools.isPending) {
    body = <Loading what="volumes" />;
  } else if (pools.isError) {
    body = <ErrorMessage error={pools.error} />;
  } else {
    const items = pools.data.pools.flatMap((pool) =>
      pool.volumes.map((volume) => ({ poolId: pool.id, volume })),
    );
    body = <VolumeTable items={items} showPool={true} showGrow={false} />;
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Volumes</h1>
      {body}
    </div>
  );
}
