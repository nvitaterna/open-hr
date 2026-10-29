import { type ReactElement, useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import type { Result } from '@ohr/rpc/contract';
import type { PoolCreateRequest } from '@ohr/shared/pool-create-request';

import { isStateChanged, useCreatePool, useDrives, usePreviewPool } from '../api/queries.ts';
import { SECONDARY_BUTTON } from '../components/buttons.ts';
import { ConfirmByTyping } from '../components/confirm-by-typing.tsx';
import { ErrorMessage, Loading } from '../components/page-states.tsx';
import { PlanReview } from '../components/plan-review.tsx';
import { PoolForm } from '../components/pool-form.tsx';
import { Panel } from '../components/section.tsx';

interface ChooseProps {
  readonly initial: PoolCreateRequest | null;
  readonly busy: boolean;
  readonly onPreview: (request: PoolCreateRequest) => void;
}

function Choose({ initial, busy, onPreview }: ChooseProps): ReactElement {
  const drives = useDrives();
  if (drives.isPending) {
    return <Loading what="drives" />;
  }
  if (drives.isError) {
    return <ErrorMessage error={drives.error} />;
  }
  return (
    <Panel>
      <PoolForm drives={drives.data.drives} initial={initial} busy={busy} onPreview={onPreview} />
    </Panel>
  );
}

interface ReviewStepProps {
  readonly plan: Result<'pools.previewCreate'>;
  readonly busy: boolean;
  readonly error: Error | null;
  readonly onCreate: () => void;
  readonly onAgain: () => void;
  readonly onBack: () => void;
}

function ReviewStep({
  plan,
  busy,
  error,
  onCreate,
  onAgain,
  onBack,
}: ReviewStepProps): ReactElement {
  let failure: ReactElement | null = null;
  if (isStateChanged(error)) {
    failure = (
      <div className="space-y-2">
        <ErrorMessage
          error={
            new Error(
              'The drives changed since this preview. Preview again before creating the pool.',
            )
          }
        />
        <button type="button" className={SECONDARY_BUTTON} onClick={onAgain}>
          Preview again
        </button>
      </div>
    );
  } else if (error !== null) {
    failure = <ErrorMessage error={error} />;
  }
  return (
    <>
      <PlanReview preview={plan} />
      <Panel>
        <ConfirmByTyping
          expected={plan.input.poolId}
          what="pool name"
          actionLabel="Create pool"
          danger={true}
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

/**
 * Creates a pool in two steps (plan section 5.6): choose the drives, then
 * review the plan and the exact commands, and type the pool name to start.
 */
export function CreatePoolPage(): ReactElement {
  const navigate = useNavigate();
  const preview = usePreviewPool();
  const create = useCreatePool();
  const { mutate: runPreview, reset: resetPreview } = preview;
  const { mutate: submit, reset: resetCreate } = create;
  const [request, setRequest] = useState<PoolCreateRequest | null>(null);
  const onPreview = useCallback(
    (next: PoolCreateRequest) => {
      setRequest(next);
      resetCreate();
      runPreview(next);
    },
    [runPreview, resetCreate],
  );
  const back = useCallback(() => {
    resetPreview();
    resetCreate();
  }, [resetPreview, resetCreate]);
  const plan = preview.data;
  const onCreate = useCallback(() => {
    if (plan === undefined) {
      return;
    }
    submit(
      { input: plan.input, stateHash: plan.stateHash },
      { onSuccess: ({ job }) => navigate(`/jobs/${job.id}`) },
    );
  }, [plan, submit, navigate]);
  const again = useCallback(() => {
    if (request !== null) {
      onPreview(request);
    }
  }, [request, onPreview]);
  let body: ReactElement;
  if (plan === undefined) {
    let failure: ReactElement | null = null;
    if (preview.isError) {
      failure = <ErrorMessage error={preview.error} />;
    }
    body = (
      <>
        <Choose initial={request} busy={preview.isPending} onPreview={onPreview} />
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
        onAgain={again}
        onBack={back}
      />
    );
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create a pool</h1>
      {body}
    </div>
  );
}
