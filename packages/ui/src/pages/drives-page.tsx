import { type ReactElement, useCallback } from 'react';

import { type DriveView, deriveDrives } from '@ohr/shared/pool-view';
import { formatSize } from '@ohr/shared/sizes';

import { useDrives, useSmartRead } from '../api/queries.ts';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { formatTime, ROLE_LABELS } from '../labels.ts';

const NONE = '—';

function smart(drive: DriveView): string {
  if (drive.smartPassed === null) {
    return NONE;
  }
  if (drive.smartPassed) {
    return 'Passed';
  }
  return 'Failed';
}

function temperature(drive: DriveView): string {
  if (drive.temperatureCelsius === null) {
    return NONE;
  }
  return `${drive.temperatureCelsius} °C`;
}

function kind(drive: DriveView): string {
  let media = 'SSD';
  if (drive.rotational) {
    media = 'HDD';
  }
  if (drive.transport === null) {
    return media;
  }
  return `${media}, ${drive.transport.toUpperCase()}`;
}

const HEADINGS = ['Drive', 'Model', 'Serial', 'Size', 'Type', 'Role', 'Temperature', 'SMART'];
const CELL = 'px-3 py-2.5 whitespace-nowrap';

function DriveRow({ drive }: { readonly drive: DriveView }): ReactElement {
  let role = ROLE_LABELS[drive.role];
  if (drive.poolId !== null) {
    role += ` (${drive.poolId})`;
  }
  return (
    <tr>
      <th scope="row" className={`${CELL} text-left font-medium`}>
        {drive.path}
      </th>
      <td className={CELL}>{drive.model ?? NONE}</td>
      <td className={`${CELL} font-mono text-xs`}>{drive.serial ?? NONE}</td>
      <td className={`${CELL} text-right tabular-nums`}>{formatSize(drive.sizeBytes)}</td>
      <td className={CELL}>{kind(drive)}</td>
      <td className={CELL}>{role}</td>
      <td className={`${CELL} text-right tabular-nums`}>{temperature(drive)}</td>
      <td className={CELL}>{smart(drive)}</td>
    </tr>
  );
}

const BUTTON =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900';

function DriveTable({ drives }: { readonly drives: readonly DriveView[] }): ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            {HEADINGS.map((heading) => (
              <th key={heading} scope="col" className={`${CELL} text-left font-medium`}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {drives.map((drive) => (
            <DriveRow key={drive.path} drive={drive} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Every drive with its model, serial, size, role, and health (plan section
 * 5.6). SMART is slow to read, so it is read only when asked for.
 */
export function DrivesPage(): ReactElement {
  const drives = useDrives();
  const smartRead = useSmartRead();
  const { mutate: readSmart } = smartRead;
  const onReadSmart = useCallback(() => readSmart(), [readSmart]);
  let failure: ReactElement | null = null;
  if (smartRead.isError) {
    failure = <ErrorMessage error={smartRead.error} />;
  }
  let body: ReactElement;
  if (smartRead.isSuccess) {
    body = <DriveTable drives={deriveDrives(smartRead.data.snapshot)} />;
  } else if (drives.isPending) {
    body = <Loading what="drives" />;
  } else if (drives.isError) {
    body = <ErrorMessage error={drives.error} />;
  } else {
    body = <DriveTable drives={drives.data.drives} />;
  }
  let buttonLabel = 'Read SMART data';
  if (smartRead.isPending) {
    buttonLabel = 'Reading SMART…';
  }
  let note = 'Temperature and SMART are read only on request, because reading them is slow.';
  if (smartRead.isSuccess) {
    note = `SMART read at ${formatTime(smartRead.data.readAt)}.`;
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Drives</h1>
        <button
          type="button"
          className={BUTTON}
          disabled={smartRead.isPending}
          onClick={onReadSmart}
        >
          {buttonLabel}
        </button>
      </div>
      {failure}
      {body}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{note}</p>
    </div>
  );
}
