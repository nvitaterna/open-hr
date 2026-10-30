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
import type { PoolView } from '@ohr/shared/pool-view';
import { formatSize, parseSize, SizeParseError } from '@ohr/shared/sizes';
import type { VolumeGrowPreviewRequest } from '@ohr/shared/web-api';

import { useGrowVolume, usePool, usePreviewGrow } from '../api/queries.ts';
import { PRIMARY_BUTTON } from '../components/buttons.ts';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { Panel, Section } from '../components/section.tsx';
import { StepsPreview } from '../components/steps-preview.tsx';
import { useWizard } from '../components/use-wizard.ts';
import { Facts, ReviewFooter } from '../components/wizard.tsx';

type GrowPlan = Result<'volumes.previewGrow'>;

/** Reads the amount field: empty means all free space. */
function sizeFrom(text: string): VolumeGrowPreviewRequest['size'] | string {
  if (text.trim() === '') {
    return { kind: 'all-free' };
  }
  try {
    return { kind: 'add-bytes', bytes: parseSize(text) };
  } catch (error) {
    if (error instanceof SizeParseError) {
      return error.message;
    }
    throw error;
  }
}

function initialText(initial: VolumeGrowPreviewRequest | null): string {
  if (initial?.size.kind === 'add-bytes') {
    return formatSize(initial.size.bytes);
  }
  return '';
}

interface GrowFormProps {
  readonly freeBytes: number | null;
  readonly initial: VolumeGrowPreviewRequest | null;
  readonly busy: boolean;
  readonly onPreview: (request: VolumeGrowPreviewRequest) => void;
}

function GrowForm({ freeBytes, initial, busy, onPreview }: GrowFormProps): ReactElement {
  const id = useId();
  const [text, setText] = useState(() => initialText(initial));
  const [problem, setProblem] = useState<string | null>(null);
  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setText(event.currentTarget.value);
  }, []);
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const size = sizeFrom(text);
      if (typeof size === 'string') {
        setProblem(size);
        return;
      }
      setProblem(null);
      onPreview({ size });
    },
    [text, onPreview],
  );
  let free = 'all free space';
  if (freeBytes !== null) {
    free = `all ${formatSize(freeBytes)} free`;
  }
  return (
    <form className="space-y-6" onSubmit={submit}>
      <div>
        <label htmlFor={id} className="block text-sm font-medium">
          How much to add
        </label>
        <input
          id={id}
          value={text}
          onChange={onChange}
          placeholder={free}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 block w-64 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Leave empty to use {free}, or write a size such as 500 GB or 2 TiB.
        </p>
      </div>
      {problem !== null && <ErrorMessage error={new Error(problem)} />}
      <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>
        Preview
      </button>
    </form>
  );
}

function GrowReview({ plan }: { readonly plan: GrowPlan }): ReactElement {
  const { input } = plan;
  let target = formatSize(plan.sizeBytes);
  if (input.size.kind === 'all-free') {
    target += ", all the pool's free space";
  }
  return (
    <div className="space-y-8">
      <Panel>
        <Facts
          facts={[
            ['Volume', input.name],
            ['Grows to', target],
            ['Filesystem', `${input.filesystem}, grown online`],
            ['Mount point', input.mountPoint],
          ]}
        />
      </Panel>
      <Section title="What will run">
        <Panel>
          <StepsPreview steps={plan.steps} />
        </Panel>
      </Section>
    </div>
  );
}

function CurrentSize({
  pool,
  name,
}: {
  readonly pool: PoolView;
  readonly name: string;
}): ReactElement | null {
  const volume = pool.volumes.find((candidate) => candidate.name === name);
  if (volume === undefined) {
    return null;
  }
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      {name} is {formatSize(volume.sizeBytes)}, mounted at {volume.mountPoint ?? 'nowhere'}.
    </p>
  );
}

/**
 * Grows a mounted volume and its filesystem online (decision 0011): choose
 * how much, review the commands, and type the volume name to start.
 */
export function GrowVolumePage(): ReactElement {
  const { id = '', name = '' } = useParams();
  const pool = usePool(id);
  const wizard = useWizard(usePreviewGrow(id, name), useGrowVolume(id, name));
  const { plan } = wizard;
  let body: ReactElement;
  if (pool.isPending) {
    body = <Loading what={`pool ${id}`} />;
  } else if (pool.isError) {
    body = <ErrorMessage error={pool.error} />;
  } else if (plan === undefined) {
    body = (
      <>
        <CurrentSize pool={pool.data.pool} name={name} />
        <Panel>
          <GrowForm
            freeBytes={pool.data.pool.freeBytes}
            initial={wizard.request}
            busy={wizard.previewing}
            onPreview={wizard.preview}
          />
        </Panel>
        {wizard.previewError !== null && <ErrorMessage error={wizard.previewError} />}
      </>
    );
  } else {
    body = (
      <>
        <GrowReview plan={plan} />
        <ReviewFooter
          wizard={wizard}
          expected={plan.input.name}
          what="volume name"
          actionLabel="Grow volume"
          danger={false}
        />
      </>
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Grow volume {name} on {id}
      </h1>
      {body}
    </div>
  );
}
