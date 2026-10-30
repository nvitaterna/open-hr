import { type ChangeEvent, type ReactElement, useCallback, useId } from 'react';

import type { DriveView } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { ROLE_LABELS } from '../labels.ts';

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
  /** Checkboxes pick several drives, radio buttons one. */
  readonly kind: 'checkbox' | 'radio';
  readonly onToggle: (path: string) => void;
}

interface WipeFieldProps {
  readonly checked: boolean;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

/** One drive to pick for a pool. The system drive is shown but cannot be picked. */
export function DriveChoice({ drive, checked, kind, onToggle }: DriveChoiceProps): ReactElement {
  const id = useId();
  const system = drive.role === 'system';
  const toggle = useCallback(() => onToggle(drive.path), [onToggle, drive.path]);
  return (
    <li className="flex items-start gap-2">
      <input
        id={id}
        type={kind}
        name="drive"
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

/** Shown once a chosen drive holds something: the user agrees to erase it. */
export function WipeField({ checked, onChange }: WipeFieldProps): ReactElement {
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
