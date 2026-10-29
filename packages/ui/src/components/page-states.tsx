import type { ReactElement } from 'react';

import { ApiRequestError } from '../api/api-request-error.ts';

export function Loading({ what }: { readonly what: string }): ReactElement {
  return (
    <p className="text-sm text-zinc-500 dark:text-zinc-400" role="status">
      Loading {what}…
    </p>
  );
}

/** An error with the API's message and, for a refusal, each reason. */
export function ErrorMessage({ error }: { readonly error: unknown }): ReactElement {
  let message = 'Something went wrong.';
  let reasons: readonly string[] = [];
  if (error instanceof ApiRequestError) {
    ({ message, reasons } = error);
  } else if (error instanceof Error) {
    ({ message } = error);
  }
  return (
    <div
      className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      role="alert"
    >
      <p>{message}</p>
      {reasons.length > 0 && (
        <ul className="mt-2 list-disc pl-5">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
