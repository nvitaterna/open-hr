import { type ReactElement, useCallback } from 'react';

import { useLogin } from '../api/queries.ts';
import { AuthCard } from '../components/auth-card.tsx';
import { FormField } from '../components/form-field.tsx';
import { ErrorMessage } from '../components/page-states.tsx';

export function LoginPage(): ReactElement {
  const login = useLogin();
  const { mutate } = login;
  const submit = useCallback(
    (form: FormData): void => {
      mutate({
        username: String(form.get('username')),
        password: String(form.get('password')),
      });
    },
    [mutate],
  );
  let failure: ReactElement | null = null;
  if (login.isError) {
    failure = <ErrorMessage error={login.error} />;
  }
  return (
    <AuthCard
      title="Sign in"
      intro={<p>Sign in with the admin account.</p>}
      submitLabel="Sign in"
      busy={login.isPending}
      onSubmit={submit}
    >
      <FormField label="Username" name="username" autoComplete="username" />
      <FormField label="Password" name="password" type="password" autoComplete="current-password" />
      {failure}
    </AuthCard>
  );
}
