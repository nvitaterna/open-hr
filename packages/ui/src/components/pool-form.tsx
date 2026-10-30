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

import { REDUNDANCY_LABELS } from '../labels.ts';
import { PRIMARY_BUTTON } from './buttons.ts';
import { DriveChoice, WipeField } from './drive-choice.tsx';

const INPUT =
  'mt-1 block w-48 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900';
const REDUNDANCIES: readonly Redundancy[] = ['shr1', 'shr2'];

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
              kind="checkbox"
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
