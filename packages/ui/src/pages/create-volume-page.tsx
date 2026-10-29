import {
  type ChangeEvent,
  type ReactElement,
  type SubmitEvent,
  useCallback,
  useId,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router';

import type { Result } from '@ohr/rpc/contract';
import { formatSize, parseSize, SizeParseError } from '@ohr/shared/sizes';
import { isValidVolumeName } from '@ohr/shared/volume-name';
import type { VolumePreviewRequest } from '@ohr/shared/web-api';

import { isStateChanged, useCreateVolume, usePool, usePreviewVolume } from '../api/queries.ts';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../components/buttons.ts';
import { ConfirmByTyping } from '../components/confirm-by-typing.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { Panel, Section } from '../components/section.tsx';
import { StepsPreview } from '../components/steps-preview.tsx';

const INPUT =
  'mt-1 block w-64 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const FILESYSTEMS = ['btrfs', 'ext4'] as const;
const FILESYSTEM_NOTES: Record<(typeof FILESYSTEMS)[number], string> = {
  btrfs: 'btrfs: checksums and snapshots (recommended)',
  ext4: 'ext4: simple and widely supported',
};

type Filesystem = (typeof FILESYSTEMS)[number];

interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly mono: boolean;
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono,
}: TextFieldProps): ReactElement {
  const id = useId();
  let className = INPUT;
  if (mono) {
    className += ' font-mono';
  }
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={className}
      />
      {hint !== undefined && (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
    </div>
  );
}

interface FilesystemFieldProps {
  readonly value: Filesystem;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function FilesystemField({ value, onChange }: FilesystemFieldProps): ReactElement {
  return (
    <fieldset>
      <legend className="text-sm font-medium">Filesystem</legend>
      <div className="mt-2 space-y-1">
        {FILESYSTEMS.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="filesystem"
              value={option}
              checked={value === option}
              onChange={onChange}
              className="size-4 accent-emerald-700"
            />
            {FILESYSTEM_NOTES[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface VolumeFormProps {
  readonly freeBytes: number | null;
  readonly busy: boolean;
  readonly onPreview: (request: VolumePreviewRequest) => void;
}

/** Reads the size field: empty means all free space. */
function sizeFrom(text: string): VolumePreviewRequest['size'] | string {
  if (text.trim() === '') {
    return { kind: 'all-free' };
  }
  try {
    return { kind: 'bytes', bytes: parseSize(text) };
  } catch (error) {
    if (error instanceof SizeParseError) {
      return error.message;
    }
    throw error;
  }
}

function VolumeForm({ freeBytes, busy, onPreview }: VolumeFormProps): ReactElement {
  const [name, setName] = useState('');
  const [filesystem, setFilesystem] = useState<Filesystem>('btrfs');
  const [size, setSize] = useState('');
  const [mountPoint, setMountPoint] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const onName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setName(event.currentTarget.value.trim());
  }, []);
  const onFilesystem = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setFilesystem(event.currentTarget.value as Filesystem);
  }, []);
  const onSize = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSize(event.currentTarget.value);
  }, []);
  const onMount = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setMountPoint(event.currentTarget.value.trim());
  }, []);
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = sizeFrom(size);
      if (typeof parsed === 'string') {
        setProblem(parsed);
        return;
      }
      setProblem(null);
      const request: VolumePreviewRequest = { name, filesystem, size: parsed };
      if (mountPoint === '') {
        onPreview(request);
      } else {
        onPreview({ ...request, mountPoint });
      }
    },
    [name, filesystem, size, mountPoint, onPreview],
  );
  let free = 'all free space';
  if (freeBytes !== null) {
    free = `all ${formatSize(freeBytes)} free`;
  }
  return (
    <form className="space-y-6" onSubmit={submit}>
      <TextField label="Volume name" value={name} onChange={onName} mono={true} />
      <FilesystemField value={filesystem} onChange={onFilesystem} />
      <TextField
        label="Size"
        value={size}
        onChange={onSize}
        placeholder={free}
        hint={`Leave empty to use ${free}, or write a size such as 500 GB or 2 TiB.`}
        mono={false}
      />
      <TextField
        label="Mount point"
        value={mountPoint}
        onChange={onMount}
        placeholder={`/mnt/ohr/${name || 'name'}`}
        mono={true}
      />
      {problem !== null && <ErrorMessage error={new Error(problem)} />}
      <button type="submit" className={PRIMARY_BUTTON} disabled={busy || !isValidVolumeName(name)}>
        Preview
      </button>
    </form>
  );
}

function VolumeReview({
  preview,
}: {
  readonly preview: Result<'volumes.previewCreate'>;
}): ReactElement {
  const { input } = preview;
  const facts: [string, string][] = [
    ['Name', input.name],
    ['Filesystem', input.filesystem],
    ['Size', formatSize(preview.sizeBytes)],
    ['Mount point', input.mountPoint],
  ];
  return (
    <div className="space-y-8">
      <Panel>
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="font-mono text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Section title="What will run">
        <Panel>
          <StepsPreview steps={preview.steps} />
        </Panel>
      </Section>
    </div>
  );
}

interface ReviewStepProps {
  readonly plan: Result<'volumes.previewCreate'>;
  readonly busy: boolean;
  readonly error: Error | null;
  readonly onCreate: () => void;
  readonly onBack: () => void;
}

function ReviewStep({ plan, busy, error, onCreate, onBack }: ReviewStepProps): ReactElement {
  let failure: ReactElement | null = null;
  if (isStateChanged(error)) {
    failure = (
      <ErrorMessage
        error={new Error('The pool changed since this preview. Go back and preview again.')}
      />
    );
  } else if (error !== null) {
    failure = <ErrorMessage error={error} />;
  }
  return (
    <>
      <VolumeReview preview={plan} />
      <Panel>
        <ConfirmByTyping
          expected={plan.input.name}
          what="volume name"
          actionLabel="Create volume"
          danger={false}
          busy={busy}
          onConfirm={onCreate}
        />
      </Panel>
      {failure}
      <button type="button" className={SECONDARY_BUTTON} onClick={onBack}>
        Back
      </button>
    </>
  );
}

/** Creates a volume on a pool: choose, review the commands, type the name to start. */
export function CreateVolumePage(): ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const pool = usePool(id);
  const preview = usePreviewVolume(id);
  const create = useCreateVolume(id);
  const { mutate: runPreview, reset: resetPreview } = preview;
  const { mutate: submit, reset: resetCreate } = create;
  const plan = preview.data;
  const onPreview = useCallback(
    (request: VolumePreviewRequest) => {
      resetCreate();
      runPreview(request);
    },
    [runPreview, resetCreate],
  );
  const back = useCallback(() => {
    resetPreview();
    resetCreate();
  }, [resetPreview, resetCreate]);
  const onCreate = useCallback(() => {
    if (plan !== undefined) {
      submit(
        { input: plan.input, stateHash: plan.stateHash },
        { onSuccess: ({ job }) => navigate(`/jobs/${job.id}`) },
      );
    }
  }, [plan, submit, navigate]);
  let body: ReactElement;
  if (pool.isPending) {
    body = <Loading what={`pool ${id}`} />;
  } else if (pool.isError) {
    body = <ErrorMessage error={pool.error} />;
  } else if (plan === undefined) {
    let failure: ReactElement | null = null;
    if (preview.isError) {
      failure = <ErrorMessage error={preview.error} />;
    }
    body = (
      <>
        <Panel>
          <VolumeForm
            freeBytes={pool.data.pool.freeBytes}
            busy={preview.isPending}
            onPreview={onPreview}
          />
        </Panel>
        {failure}
      </>
    );
  } else {
    body = (
      <ReviewStep
        plan={plan}
        busy={create.isPending}
        error={create.error}
        onCreate={onCreate}
        onBack={back}
      />
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create a volume on {id}</h1>
      {body}
    </div>
  );
}
