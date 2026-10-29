import type { ReactElement } from 'react';

import type { TierView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { DataTable } from './data-table.tsx';
import { StatusBadge } from './status-badge.tsx';
import { CELL, NONE } from './table-styles.ts';

const HEADINGS = ['Tier', 'Level', 'Array', 'Size', 'Members', 'Health', 'Sync'];
const KIB = 1024;

function sync(tier: TierView): string {
  if (tier.sync === null) {
    return NONE;
  }
  const parts = [tier.sync.action];
  if (tier.sync.percent !== null) {
    parts.push(`${tier.sync.percent.toFixed(1)}%`);
  }
  if (tier.sync.finishMinutes !== null) {
    parts.push(`about ${Math.ceil(tier.sync.finishMinutes)} min left`);
  }
  if (tier.sync.speedKibPerSecond !== null) {
    parts.push(`${formatSize(tier.sync.speedKibPerSecond * KIB)}/s`);
  }
  return parts.join(', ');
}

function members(tier: TierView): string {
  const active = tier.members.filter((member) => member.state === 'active').length;
  return `${active} of ${tier.expectedMembers ?? tier.members.length} active`;
}

function TierRow({ tier }: { readonly tier: TierView }): ReactElement {
  let array = tier.arrayPath;
  if (tier.kernelName !== null) {
    array += ` (${tier.kernelName})`;
  }
  let size = NONE;
  if (tier.sizeBytes !== null) {
    size = formatSize(tier.sizeBytes);
  }
  return (
    <tr>
      <th scope="row" className={`${CELL} text-left font-medium`}>
        Tier {tier.tier}
      </th>
      <td className={CELL}>{tier.level ?? NONE}</td>
      <td className={`${CELL} font-mono text-xs`}>{array}</td>
      <td className={`${CELL} text-right tabular-nums`}>{size}</td>
      <td className={CELL}>{members(tier)}</td>
      <td className={CELL}>
        <StatusBadge status={tier.health} />
      </td>
      <td className={`${CELL} tabular-nums`}>{sync(tier)}</td>
    </tr>
  );
}

/** Each tier's md array: level, size, members, health, and sync progress. */
export function TierTable({ tiers }: { readonly tiers: readonly TierView[] }): ReactElement {
  return (
    <DataTable headings={HEADINGS}>
      {tiers.map((tier) => (
        <TierRow key={tier.tier} tier={tier} />
      ))}
    </DataTable>
  );
}
