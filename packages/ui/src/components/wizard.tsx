/** The review end of the expansion wizards (see use-wizard.ts). */

import type { ReactElement, ReactNode } from 'react';

import { isStateChanged } from '../api/queries.ts';
import { SECONDARY_BUTTON } from './buttons.ts';
import { ConfirmByTyping } from './confirm-by-typing.tsx';
import { ErrorMessage } from './page-states.tsx';
import { Panel } from './section.tsx';
import type { Plan, Wizard } from './use-wizard.ts';

/** The parts of a wizard the review's footer uses; they do not depend on the request type. */
type ReviewControls = Pick<
  Wizard<unknown, Plan>,
  'submitting' | 'submitError' | 'again' | 'back' | 'confirm'
>;

interface ReviewFooterProps {
  readonly wizard: ReviewControls;
  /** What the user types to confirm, such as the pool id. */
  readonly expected: string;
  readonly what: string;
  readonly actionLabel: string;
  readonly danger: boolean;
}

/** The end of the review: type to confirm, what went wrong, and Back. */
export function ReviewFooter({
  wizard,
  expected,
  what,
  actionLabel,
  danger,
}: ReviewFooterProps): ReactElement {
  let failure: ReactElement | null = null;
  if (isStateChanged(wizard.submitError)) {
    failure = (
      <div className="space-y-2">
        <ErrorMessage
          error={new Error('The pool changed since this preview. Preview again before starting.')}
        />
        <button type="button" className={SECONDARY_BUTTON} onClick={wizard.again}>
          Preview again
        </button>
      </div>
    );
  } else if (wizard.submitError !== null) {
    failure = <ErrorMessage error={wizard.submitError} />;
  }
  return (
    <>
      <Panel>
        <ConfirmByTyping
          expected={expected}
          what={what}
          actionLabel={actionLabel}
          danger={danger}
          busy={wizard.submitting}
          onConfirm={wizard.confirm}
        />
      </Panel>
      {failure}
      <button type="button" className={SECONDARY_BUTTON} onClick={wizard.back}>
        Back
      </button>
    </>
  );
}

/** Labelled values at the top of a review. */
export function Facts({ facts }: { readonly facts: readonly [string, string][] }): ReactElement {
  return (
    <dl className="flex flex-wrap gap-x-10 gap-y-3">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
          <dd className="text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A red note about what a job erases. */
export function EraseNote({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div
      className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      role="note"
    >
      {children}
    </div>
  );
}
