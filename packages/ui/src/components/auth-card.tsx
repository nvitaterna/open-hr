import { type ReactElement, type ReactNode, type SubmitEvent, useCallback } from 'react';

interface AuthCardProps {
  readonly title: string;
  readonly intro: ReactNode;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (form: FormData) => void;
  readonly children: ReactNode;
}

/** The centred card the setup and sign-in pages share. */
export function AuthCard({
  title,
  intro,
  submitLabel,
  busy,
  onSubmit,
  children,
}: AuthCardProps): ReactElement {
  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>): void => {
      event.preventDefault();
      onSubmit(new FormData(event.currentTarget));
    },
    [onSubmit],
  );
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="text-sm font-semibold tracking-tight text-emerald-700 dark:text-emerald-400">
          Open HR
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{intro}</div>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          {children}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-60"
          >
            {submitLabel}
          </button>
        </form>
      </div>
    </main>
  );
}
