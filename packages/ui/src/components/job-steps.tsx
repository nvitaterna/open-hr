import type { ReactElement } from 'react';

import type { LogLine, StepRecord } from '@ohr/shared/jobs';

import type { JobProgress } from '../api/queries.ts';
import { StatusBadge } from './status-badge.tsx';
import { StepProgress } from './step-progress.tsx';

const LOG_BOX =
  'mt-2 max-h-64 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100';

interface StepProps {
  readonly step: StepRecord;
  readonly log: readonly LogLine[];
  /** Shown only while this step runs. */
  readonly progress: JobProgress | null;
}

function Step({ step, log, progress }: StepProps): ReactElement {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          {step.index + 1}. {step.name}
        </span>
        <StatusBadge status={step.status} />
      </div>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{step.description}</p>
      {step.status === 'running' && progress?.step === step.index && (
        <StepProgress progress={progress} />
      )}
      {step.error !== null && (
        <p className="mt-1 text-sm text-red-700 dark:text-red-400">{step.error}</p>
      )}
      {step.commands.length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
            Commands ({step.commands.length})
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">
            {step.commands.join('\n')}
          </pre>
        </details>
      )}
      <LogBox lines={log} />
    </li>
  );
}

interface JobStepsProps {
  readonly steps: readonly StepRecord[];
  readonly log: readonly LogLine[];
  /** The job's last progress event, drawn on the step it came from. */
  readonly progress: JobProgress | null;
}

/** Log lines as a terminal-like box. Nothing when there are none. */
export function LogBox({ lines }: { readonly lines: readonly LogLine[] }): ReactElement | null {
  if (lines.length === 0) {
    return null;
  }
  return (
    <pre className={LOG_BOX}>
      {lines.map((line, index) => (
        // Lines can repeat, so their position is the key; the list only grows.
        // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
        <span key={index} className="block">
          {line.line}
        </span>
      ))}
    </pre>
  );
}

/** Each step with its status, commands, error, log lines, and progress while it runs. */
export function JobSteps({ steps, log, progress }: JobStepsProps): ReactElement {
  return (
    <ol className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {steps.map((step) => (
        <Step
          key={step.index}
          step={step}
          log={log.filter((line) => line.step === step.index)}
          progress={progress}
        />
      ))}
    </ol>
  );
}
