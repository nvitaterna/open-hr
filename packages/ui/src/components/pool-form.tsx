import {
  type ChangeEvent,
  type ReactElement,
  type SubmitEvent,
  useCallback,
  useId,
  useState,
} from 'react';

import type { Redundancy } from '@ohr/shared/constants';
import { isValidPoolId } from '@ohr/shared/naming';
import type { PoolCreateRequest } from '@ohr/shared/pool-create-request';
import type { DriveView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { REDUNDANCY_LABELS, ROLE_LABELS } from '../labels.ts';
import { PRIMARY_BUTTON } from './buttons.ts';

const INPUT =
  'mt-1 block w-48 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900';
const REDUNDANCIES: readonly Redundancy[] = ['shr1', 'shr2'];

function driveLabel(drive: DriveView): string {
  let role = ROLE_LABELS[drive.role];
  if (drive.poolId !== null) {
    role += ` of pool ${drive.poolId}`;
  }
  return `${drive.path} · ${formatSize(drive.sizeBytes)} · ${drive.model ?? 'unknown model'} · ${role}`;
}

interface DriveChoiceProps {
  readonly drive: DriveView;
  readonly checked: boolean;
  readonly onToggle: (path: string) => void;
}

function DriveChoice({ drive, checked, onToggle }: DriveChoiceProps): ReactElement {
  const id = useId();
  const system = drive.role === 'system';
  const toggle = useCallback(() => onToggle(drive.path), [onToggle, drive.path]);
  return (
    <li className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 accent-emerald-700"
        checked={checked}
        disabled={system}
        onChange={toggle}
      />
      <label htmlFor={id} className="text-sm">
        {driveLabel(drive)}
        {system && (
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Holds the operating system, so it cannot join a pool.
          </span>
        )}
      </label>
    </li>
  );
}

interface NameFieldProps {
  readonly poolId: string;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function NameField({ poolId, onChange }: NameFieldProps): ReactElement {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        Pool name
      </label>
      <input
        id={id}
        value={poolId}
        onChange={onChange}
        autoComplete="off"
        spellCheck={false}
        maxLength={8}
        className={INPUT}
      />
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        1 to 8 lowercase letters or digits. It names the volume group ohr-{poolId || 'name'}.
      </p>
    </div>
  );
}

interface RedundancyFieldProps {
  readonly value: Redundancy;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function RedundancyField({ value, onChange }: RedundancyFieldProps): ReactElement {
  return (
    <fieldset>
      <legend className="text-sm font-medium">Redundancy</legend>
      <div className="mt-2 space-y-1">
        {REDUNDANCIES.map((level) => (
          <label key={level} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="redundancy"
              value={level}
              checked={value === level}
              onChange={onChange}
              className="size-4 accent-emerald-700"
            />
            {REDUNDANCY_LABELS[level]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface WipeFieldProps {
  readonly checked: boolean;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function WipeField({ checked, onChange }: WipeFieldProps): ReactElement {
  return (
    <label className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 accent-red-700"
      />
      Some chosen drives hold partitions, a filesystem, or a pool. Erase them.
    </label>
  );
}

interface PoolFormProps {
  readonly drives: readonly DriveView[];
  /** What the user chose last time, when they came back from the preview. */
  readonly initial: PoolCreateRequest | null;
  readonly busy: boolean;
  readonly onPreview: (request: PoolCreateRequest) => void;
}

/** The first step of creating a pool: its name, redundancy, and drives. */
export function PoolForm({ drives, initial, busy, onPreview }: PoolFormProps): ReactElement {
  const [poolId, setPoolId] = useState(initial?.poolId ?? '');
  const [redundancy, setRedundancy] = useState<Redundancy>(initial?.redundancy ?? 'shr1');
  const [selected, setSelected] = useState<readonly string[]>(initial?.devices ?? []);
  const [wipe, setWipe] = useState(initial?.wipe ?? false);
  const onName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPoolId(event.currentTarget.value.trim());
  }, []);
  const onRedundancy = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setRedundancy(event.currentTarget.value as Redundancy);
  }, []);
  const onWipe = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setWipe(event.currentTarget.checked);
  }, []);
  const onToggle = useCallback((path: string) => {
    setSelected((current) => {
      if (current.includes(path)) {
        return current.filter((candidate) => candidate !== path);
      }
      return [...current, path];
    });
  }, []);
  const holdsSomething = drives.some(
    (drive) => selected.includes(drive.path) && drive.role !== 'empty',
  );
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      // A wipe ticked for a drive that was unticked again does not count.
      onPreview({ poolId, redundancy, devices: [...selected], wipe: wipe && holdsSomething });
    },
    [onPreview, poolId, redundancy, selected, wipe, holdsSomething],
  );
  const nameValid = isValidPoolId(poolId);
  return (
    <form className="space-y-6" onSubmit={submit}>
      <NameField poolId={poolId} onChange={onName} />
      <RedundancyField value={redundancy} onChange={onRedundancy} />
      <fieldset>
        <legend className="text-sm font-medium">Drives</legend>
        <ul className="mt-2 space-y-2">
          {drives.map((drive) => (
            <DriveChoice
              key={drive.path}
              drive={drive}
              checked={selected.includes(drive.path)}
              onToggle={onToggle}
            />
          ))}
        </ul>
      </fieldset>
      {holdsSomething && <WipeField checked={wipe} onChange={onWipe} />}
      <button
        type="submit"
        className={PRIMARY_BUTTON}
        disabled={busy || !nameValid || selected.length === 0}
      >
        Preview
      </button>
    </form>
  );
}
