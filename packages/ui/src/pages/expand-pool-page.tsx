import {
  type ChangeEvent,
  type ReactElement,
  type SubmitEvent,
  useCallback,
  useId,
  useState,
} from 'react';
import { useParams } from 'react-router';

import type { Result } from '@ohr/rpc/contract';
import type { DriveView, PoolView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';
import type { PoolExpandPreviewRequest } from '@ohr/shared/web-api';

import { useDrives, useExpandPool, usePool, usePreviewExpand } from '../api/queries.ts';
import { PRIMARY_BUTTON } from '../components/buttons.ts';
import { DriveChoice, WipeField } from '../components/drive-choice.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { Panel, Section } from '../components/section.tsx';
import { StepsPreview } from '../components/steps-preview.tsx';
import { TierDiagram } from '../components/tier-diagram.tsx';
import { useWizard } from '../components/use-wizard.ts';
import { EraseNote, Facts, ReviewFooter } from '../components/wizard.tsx';
import { layoutPlan } from '../tier-layout.ts';

type ExpandPlan = Result<'pools.previewExpand'>;

/** Drives that could join `pool`: every drive that is not already one of its drives. */
function candidates(drives: readonly DriveView[], pool: PoolView): DriveView[] {
  const own = new Set(pool.drives.map((drive) => drive.path));
  return drives.filter((drive) => !own.has(drive.path));
}

interface GrowVolumeFieldProps {
  readonly pool: PoolView;
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}

/** Optionally grows a mounted volume into all the new space once the pool has grown. */
function GrowVolumeField({ pool, value, onChange }: GrowVolumeFieldProps): ReactElement | null {
  const id = useId();
  const mounted = pool.volumes.filter((volume) => volume.mountPoint !== null);
  if (mounted.length === 0) {
    return null;
  }
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        Then grow a volume
      </label>
      <select
        id={id}
        value={value}
        onChange={onChange}
        className="mt-1 block w-64 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">No, leave the new space free</option>
        {mounted.map((volume) => (
          <option key={volume.name} value={volume.name}>
            {volume.name} ({formatSize(volume.sizeBytes)})
          </option>
        ))}
      </select>
    </div>
  );
}

interface ExpandFormProps {
  readonly pool: PoolView;
  /** Drives to choose from, or null when the wizard only uses free space. */
  readonly drives: readonly DriveView[] | null;
  readonly initial: PoolExpandPreviewRequest | null;
  readonly busy: boolean;
  readonly onPreview: (request: PoolExpandPreviewRequest) => void;
}

function ExpandForm({ pool, drives, initial, busy, onPreview }: ExpandFormProps): ReactElement {
  const [selected, setSelected] = useState<readonly string[]>(initial?.devices ?? []);
  const [wipe, setWipe] = useState(initial?.wipe ?? false);
  const [growVolume, setGrowVolume] = useState(initial?.growVolume ?? '');
  const onToggle = useCallback((path: string) => {
    setSelected((current) => {
      if (current.includes(path)) {
        return current.filter((candidate) => candidate !== path);
      }
      return [...current, path];
    });
  }, []);
  const onWipe = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setWipe(event.currentTarget.checked);
  }, []);
  const onGrowVolume = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setGrowVolume(event.currentTarget.value);
  }, []);
  const holdsSomething = (drives ?? []).some(
    (drive) => selected.includes(drive.path) && drive.role !== 'empty',
  );
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const request: PoolExpandPreviewRequest = {
        devices: [...selected],
        wipe: wipe && holdsSomething,
      };
      if (growVolume === '') {
        onPreview(request);
      } else {
        onPreview({ ...request, growVolume });
      }
    },
    [onPreview, selected, wipe, holdsSomething, growVolume],
  );
  let choice: ReactElement | null = null;
  if (drives !== null) {
    choice = (
      <fieldset>
        <legend className="text-sm font-medium">Drives to add</legend>
        <ul className="mt-2 space-y-2">
          {drives.map((drive) => (
            <DriveChoice
              key={drive.path}
              drive={drive}
              checked={selected.includes(drive.path)}
              kind="checkbox"
              onToggle={onToggle}
            />
          ))}
        </ul>
      </fieldset>
    );
  }
  return (
    <form className="space-y-6" onSubmit={submit}>
      {choice}
      {drives === null && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Uses space the pool's drives already have but no tier uses yet, such as what a larger
          replacement drive brought.
        </p>
      )}
      {holdsSomething && <WipeField checked={wipe} onChange={onWipe} />}
      <GrowVolumeField pool={pool} value={growVolume} onChange={onGrowVolume} />
      <button
        type="submit"
        className={PRIMARY_BUTTON}
        disabled={busy || (drives !== null && selected.length === 0)}
      >
        Preview
      </button>
    </form>
  );
}

/** The pool after the job: capacity, layout, what is erased, and the commands. */
function ExpandReview({ plan }: { readonly plan: ExpandPlan }): ReactElement {
  const { input, steps } = plan;
  const { target } = input;
  return (
    <div className="space-y-8">
      <Panel>
        <Facts
          facts={[
            ['Usable now', formatSize(input.usableBytesBefore)],
            ['Usable after', formatSize(target.usableBytes)],
          ]}
        />
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Reshaping keeps the pool and its volumes online, but can take hours or days on large
          drives.
        </p>
        {input.growVolume !== null && input.growVolume !== undefined && (
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Volume {input.growVolume.name} then grows into all the new space, online.
          </p>
        )}
      </Panel>
      <Section title="Planned layout">
        <Panel>
          <TierDiagram
            diagram={layoutPlan(target)}
            title={`Pool ${input.poolId} after: ${target.drives.length} drives, ${target.tiers.length} tiers`}
          />
        </Panel>
      </Section>
      {input.newDrives.length > 0 && (
        <EraseNote>
          This erases everything on {input.newDrives.map((drive) => drive.path).join(', ')}.
        </EraseNote>
      )}
      <Section title="What will run">
        <Panel>
          <StepsPreview steps={steps} />
        </Panel>
      </Section>
    </div>
  );
}

interface ChooseProps {
  readonly pool: PoolView;
  readonly addDrives: boolean;
  readonly initial: PoolExpandPreviewRequest | null;
  readonly busy: boolean;
  readonly onPreview: (request: PoolExpandPreviewRequest) => void;
}

function Choose({ pool, addDrives, initial, busy, onPreview }: ChooseProps): ReactElement {
  const drives = useDrives();
  if (!addDrives) {
    return (
      <Panel>
        <ExpandForm pool={pool} drives={null} initial={initial} busy={busy} onPreview={onPreview} />
      </Panel>
    );
  }
  if (drives.isPending) {
    return <Loading what="drives" />;
  }
  if (drives.isError) {
    return <ErrorMessage error={drives.error} />;
  }
  return (
    <Panel>
      <ExpandForm
        pool={pool}
        drives={candidates(drives.data.drives, pool)}
        initial={initial}
        busy={busy}
        onPreview={onPreview}
      />
    </Panel>
  );
}

/**
 * Grows a pool (decision 0011): with `addDrives`, the Add drives wizard;
 * without, Use free space. Choose, review the new layout and the commands,
 * and type the pool id to start.
 */
export function ExpandPoolPage({ addDrives }: { readonly addDrives: boolean }): ReactElement {
  const { id = '' } = useParams();
  const pool = usePool(id);
  const wizard = useWizard(usePreviewExpand(id), useExpandPool(id));
  const { plan } = wizard;
  let title = `Use free space in ${id}`;
  let actionLabel = 'Use free space';
  if (addDrives) {
    title = `Add drives to ${id}`;
    actionLabel = 'Add drives';
  }
  let body: ReactElement;
  if (pool.isPending) {
    body = <Loading what={`pool ${id}`} />;
  } else if (pool.isError) {
    body = <ErrorMessage error={pool.error} />;
  } else if (plan === undefined) {
    body = (
      <>
        <Choose
          pool={pool.data.pool}
          addDrives={addDrives}
          initial={wizard.request}
          busy={wizard.previewing}
          onPreview={wizard.preview}
        />
        {wizard.previewError !== null && <ErrorMessage error={wizard.previewError} />}
      </>
    );
  } else {
    body = (
      <>
        <ExpandReview plan={plan} />
        <ReviewFooter
          wizard={wizard}
          expected={plan.input.poolId}
          what="pool name"
          actionLabel={actionLabel}
          danger={plan.input.newDrives.length > 0}
        />
      </>
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {body}
    </div>
  );
}
