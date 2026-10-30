/**
 * What the expansion wizards share (decision 0011, "Interfaces"): choose,
 * preview, review the plan and its commands, type a name to confirm, and
 * go to the job page, as the create wizards do (decision 0010).
 */

import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import type { Result } from '@ohr/rpc/contract';

interface Submission<P extends Plan> {
  readonly input: P['input'];
  readonly stateHash: string;
}

/** What every preview answers with: the job input and the state hash it was made from. */
export interface Plan {
  readonly input: unknown;
  readonly stateHash: string;
}

export interface Wizard<R, P extends Plan> {
  /** What the user chose last, so going back keeps it. */
  readonly request: R | null;
  /** The preview to review, or undefined while choosing. */
  readonly plan: P | undefined;
  readonly previewing: boolean;
  readonly previewError: Error | null;
  readonly submitting: boolean;
  readonly submitError: Error | null;
  readonly preview: (request: R) => void;
  /** Previews the same request again, after the machine changed. */
  readonly again: () => void;
  /** Back to choosing. */
  readonly back: () => void;
  /** Starts the job from the plan and opens its page. */
  readonly confirm: () => void;
}

/** Ties a preview mutation and a submit mutation into the wizard's steps. */
export function useWizard<R, P extends Plan>(
  previewMutation: UseMutationResult<P, Error, R>,
  submitMutation: UseMutationResult<Result<'jobs.submit'>, Error, Submission<P>>,
): Wizard<R, P> {
  const navigate = useNavigate();
  const [request, setRequest] = useState<R | null>(null);
  const { mutate: runPreview, reset: resetPreview } = previewMutation;
  const { mutate: submit, reset: resetSubmit } = submitMutation;
  const plan = previewMutation.data;
  const preview = useCallback(
    (next: R) => {
      setRequest(next);
      resetSubmit();
      runPreview(next);
    },
    [runPreview, resetSubmit],
  );
  const again = useCallback(() => {
    if (request !== null) {
      preview(request);
    }
  }, [request, preview]);
  const back = useCallback(() => {
    resetPreview();
    resetSubmit();
  }, [resetPreview, resetSubmit]);
  const confirm = useCallback(() => {
    if (plan !== undefined) {
      submit(
        { input: plan.input, stateHash: plan.stateHash },
        { onSuccess: ({ job }) => navigate(`/jobs/${job.id}`) },
      );
    }
  }, [plan, submit, navigate]);
  return {
    request,
    plan,
    previewing: previewMutation.isPending,
    previewError: previewMutation.error,
    submitting: submitMutation.isPending,
    submitError: submitMutation.error,
    preview,
    again,
    back,
    confirm,
  };
}
