import { type ReactElement, useId } from 'react';

interface FormFieldProps {
  readonly label: string;
  readonly name: string;
  readonly type?: 'text' | 'password';
  readonly autoComplete: string;
  readonly hint?: string;
  readonly minLength?: number;
}

/** A labelled, required text input. Forms read the values from FormData. */
export function FormField({
  label,
  name,
  type = 'text',
  autoComplete,
  hint,
  minLength,
}: FormFieldProps): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  let describedBy: string | undefined;
  if (hint !== undefined) {
    describedBy = hintId;
  }
  return (
    <div>
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        minLength={minLength}
        required={true}
        aria-describedby={describedBy}
        className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/30 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
      />
      {hint !== undefined && (
        <p id={hintId} className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      )}
    </div>
  );
}
