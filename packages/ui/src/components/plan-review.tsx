import type { ReactElement } from 'react';

import type { Result } from '@ohr/rpc/contract';
import { formatSize } from '@ohr/shared/sizes';

import { REDUNDANCY_LABELS } from '../labels.ts';
import { layoutPlan } from '../tier-layout.ts';
import { Panel, Section } from './section.tsx';
import { StepsPreview } from './steps-preview.tsx';
import { TierDiagram } from './tier-diagram.tsx';

const PERCENT = 100;

/** What a pool preview shows before anything is written: layout, capacity, steps, and what is erased. */
export function PlanReview({
  preview,
}: {
  readonly preview: Result<'pools.previewCreate'>;
}): ReactElement {
  const { input, steps } = preview;
  const { layout } = input;
  let efficiency = 0;
  if (layout.rawBytes > 0) {
    efficiency = Math.round((layout.usableBytes / layout.rawBytes) * PERCENT);
  }
  const unused = layout.drives.reduce((total, drive) => total + drive.unusedBytes, 0);
  return (
    <div className="space-y-8">
      <Panel>
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Raw capacity</dt>
            <dd className="text-xl font-semibold">{formatSize(layout.rawBytes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Usable capacity</dt>
            <dd className="text-xl font-semibold">
              {formatSize(layout.usableBytes)}{' '}
              <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
                ({efficiency}%)
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Redundancy</dt>
            <dd className="text-sm">{REDUNDANCY_LABELS[layout.redundancy]}</dd>
          </div>
        </dl>
        {unused > 0 && (
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            {formatSize(unused)} stays unused until a drive as large as the largest one joins.
          </p>
        )}
      </Panel>
      <Section title="Planned layout">
        <Panel>
          <TierDiagram
            diagram={layoutPlan(layout)}
            title={`Planned pool ${input.poolId}: ${layout.drives.length} drives, ${layout.tiers.length} tiers`}
          />
        </Panel>
      </Section>
      <div
        className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        role="note"
      >
        This erases everything on {input.drives.map((drive) => drive.path).join(', ')}.
      </div>
      <Section title="What will run">
        <Panel>
          <StepsPreview steps={steps} />
        </Panel>
      </Section>
    </div>
  );
}
