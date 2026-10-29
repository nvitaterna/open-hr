import { type ChangeEvent, type ReactElement, useCallback, useId, useState } from 'react';

import { DANGER_BUTTON, PRIMARY_BUTTON } from './buttons.ts';

interface ConfirmByTypingProps {
  /** What the user types, such as the pool name. */
  readonly expected: string;
  /** What it is, for the label: "pool name". */
  readonly what: string;
  readonly actionLabel: string;
  /** A destructive action gets a red button. */
  readonly danger: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}

/**
 * The last step before a job runs: the user types the name back (plan
 * section 5.6), so a wrong pool or a stray click cannot start it.
 */
export function ConfirmByTyping({
  expected,
  what,
  actionLabel,
  danger,
  busy,
  onConfirm,
}: ConfirmByTypingProps): ReactElement {
  const id = useId();
  const [typed, setTyped] = useState('');
  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTyped(event.currentTarget.value);
  }, []);
  let buttonClass = PRIMARY_BUTTON;
  if (danger) {
    buttonClass = DANGER_BUTTON;
  }
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        Type the {what}, <span className="font-mono">{expected}</span>, to continue
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          value={typed}
          onChange={onChange}
          autoComplete="off"
          spellCheck={false}
          className="w-48 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          className={buttonClass}
          disabled={typed.trim() !== expected || busy}
          onClick={onConfirm}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
