import { type ReactElement, useCallback, useState } from 'react';

import { MIN_PASSWORD_LENGTH } from '@ohr/shared/web-api';

import { useSetup } from '../api/queries.ts';
import { AuthCard } from '../components/auth-card.tsx';
import { FormField } from '../components/form-field.tsx';
import { ErrorMessage } from '../components/page-states.tsx';

/** Creates the admin account with the token the installer printed (decision 0008). */
export function SetupPage(): ReactElement {
  const setup = useSetup();
  const [mismatch, setMismatch] = useState(false);
  const { mutate } = setup;
  const submit = useCallback(
    (form: FormData): void => {
      const password = String(form.get('password'));
      if (password !== String(form.get('confirm'))) {
        setMismatch(true);
        return;
      }
      setMismatch(false);
      mutate({
        token: String(form.get('token')).trim(),
        username: String(form.get('username')),
        password,
      });
    },
    [mutate],
  );
  let failure: ReactElement | null = null;
  if (mismatch) {
    failure = <ErrorMessage error={new Error('The passwords do not match.')} />;
  } else if (setup.isError) {
    failure = <ErrorMessage error={setup.error} />;
  }
  return (
    <AuthCard
      title="Create the admin account"
      intro={
        <p>
          Enter the setup token the installer printed. To get a new one, run{' '}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            sudo ohr-web setup-token
          </code>{' '}
          on the server.
        </p>
      }
      submitLabel="Create account"
      busy={setup.isPending}
      onSubmit={submit}
    >
      <FormField label="Setup token" name="token" autoComplete="off" />
      <FormField
        label="Username"
        name="username"
        autoComplete="username"
        hint="Lowercase letters, digits, dots, dashes, or underscores."
      />
      <FormField
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
      />
      <FormField
        label="Confirm password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
      />
      {failure}
    </AuthCard>
  );
}
