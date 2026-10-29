import type { ReactElement } from 'react';

import type { Result } from '@ohr/rpc/contract';

type PreviewStep = Result<'pools.previewCreate'>['steps'][number];

/** The steps a job will run, each with the exact commands (plan section 6, rule 4). */
export function StepsPreview({ steps }: { readonly steps: readonly PreviewStep[] }): ReactElement {
  return (
    <ol className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {steps.map((step, index) => (
        <li key={step.name} className="py-3 first:pt-0 last:pb-0">
          <p className="text-sm font-medium">
            {index + 1}. {step.name}
          </p>
          <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{step.description}</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">
            {step.commands.join('\n')}
          </pre>
        </li>
      ))}
    </ol>
  );
}
