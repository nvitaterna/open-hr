import {
  type ChangeEvent,
  type ReactElement,
  type SubmitEvent,
  useCallback,
  useState,
} from 'react';
import { useParams, useSearchParams } from 'react-router';

import type { Result } from '@ohr/rpc/contract';
import type { DriveView, PoolView } from '@ohr/shared/pool-view';
import type { DriveReplacePreviewRequest } from '@ohr/shared/web-api';

import { useDrives, usePool, usePreviewReplace, useReplaceDrive } from '../api/queries.ts';
import { PRIMARY_BUTTON } from '../components/buttons.ts';
import { DriveChoice, WipeField } from '../components/drive-choice.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { Panel, Section } from '../components/section.tsx';
import { StepsPreview } from '../components/steps-preview.tsx';
import { useWizard } from '../components/use-wizard.ts';
import { EraseNote, ReviewFooter } from '../components/wizard.tsx';

type ReplacePlan = Result<'drives.previewReplace'>;

const MODE_NOTES = {
  live: 'copied while the old drive keeps working, so the tier stays redundant',
  rebuild: 'rebuilt, because the old drive has failed or is gone',
} as const;

function oldDriveName(oldDrive: string | null): string {
  return oldDrive ?? 'the missing drive';
}

interface ReplaceFormProps {
  readonly oldDrive: string | null;
  readonly drives: readonly DriveView[];
  readonly initial: DriveReplacePreviewRequest | null;
  readonly busy: boolean;
  readonly onPreview: (request: DriveReplacePreviewRequest) => void;
}

function ReplaceForm({
  oldDrive,
  drives,
  initial,
  busy,
  onPreview,
}: ReplaceFormProps): ReactElement {
  const [newDrive, setNewDrive] = useState(initial?.newDrive ?? '');
  const [wipe, setWipe] = useState(initial?.wipe ?? false);
  const onWipe = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setWipe(event.currentTarget.checked);
  }, []);
  const holdsSomething = drives.some((drive) => drive.path === newDrive && drive.role !== 'empty');
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      onPreview({ oldDrive, newDrive, wipe: wipe && holdsSomething });
    },
    [onPreview, oldDrive, newDrive, wipe, holdsSomething],
  );
  return (
    <form className="space-y-6" onSubmit={submit}>
      <p className="text-sm">
        Replacing <span className="font-mono">{oldDriveName(oldDrive)}</span>. The new drive needs
        room for every tier the old one was in.
      </p>
      <fieldset>
        <legend className="text-sm font-medium">New drive</legend>
        <ul className="mt-2 space-y-2">
          {drives.map((drive) => (
            <DriveChoice
              key={drive.path}
              drive={drive}
              checked={newDrive === drive.path}
              kind="radio"
              onToggle={setNewDrive}
            />
          ))}
        </ul>
      </fieldset>
      {holdsSomething && <WipeField checked={wipe} onChange={onWipe} />}
      <button type="submit" className={PRIMARY_BUTTON} disabled={busy || newDrive === ''}>
        Preview
      </button>
    </form>
  );
}

/** How each tier gets onto the new drive, what is erased, and the commands. */
function ReplaceReview({ plan }: { readonly plan: ReplacePlan }): ReactElement {
  const { input, steps } = plan;
  const newDrive = input.newDrives[0]?.path ?? '';
  return (
    <div className="space-y-8">
      <Panel>
        <p className="text-sm">
          Replace <span className="font-mono">{oldDriveName(input.oldDrive)}</span> with{' '}
          <span className="font-mono">{newDrive}</span>
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
          {input.actions.flatMap((action) => {
            if (action.kind !== 'replace-member') {
              return [];
            }
            return [
              <li key={action.tier}>
                Tier {action.tier}: {MODE_NOTES[action.mode]}
              </li>,
            ];
          })}
        </ul>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Rebuilding and copying keep the pool online, but can take hours on large drives.
          {input.oldDrive !== null &&
            ` ${input.oldDrive} is not erased. Afterwards it is no longer in the pool and can be taken out.`}
        </p>
      </Panel>
      <EraseNote>This erases everything on {newDrive}.</EraseNote>
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
  readonly oldDrive: string | null;
  readonly initial: DriveReplacePreviewRequest | null;
  readonly busy: boolean;
  readonly onPreview: (request: DriveReplacePreviewRequest) => void;
}

function Choose({ pool, oldDrive, initial, busy, onPreview }: ChooseProps): ReactElement {
  const drives = useDrives();
  if (drives.isPending) {
    return <Loading what="drives" />;
  }
  if (drives.isError) {
    return <ErrorMessage error={drives.error} />;
  }
  const own = new Set(pool.drives.map((drive) => drive.path));
  return (
    <Panel>
      <ReplaceForm
        oldDrive={oldDrive}
        drives={drives.data.drives.filter((drive) => !own.has(drive.path))}
        initial={initial}
        busy={busy}
        onPreview={onPreview}
      />
    </Panel>
  );
}

/**
 * Replaces one drive of a pool (decision 0011). `?drive=` names it; without
 * it, the wizard replaces the drive that is gone. Choose the new drive,
 * review how each tier moves onto it, and type the pool id to start.
 */
export function ReplaceDrivePage(): ReactElement {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const oldDrive = search.get('drive');
  const pool = usePool(id);
  const wizard = useWizard(usePreviewReplace(id), useReplaceDrive(id));
  const { plan } = wizard;
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
          oldDrive={oldDrive}
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
        <ReplaceReview plan={plan} />
        <ReviewFooter
          wizard={wizard}
          expected={plan.input.poolId}
          what="pool name"
          actionLabel="Replace drive"
          danger={true}
        />
      </>
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Replace a drive of {id}</h1>
      {body}
    </div>
  );
}
