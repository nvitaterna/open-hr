import type { ReactElement } from 'react';
import { Link } from 'react-router';

export function NotFoundPage(): ReactElement {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        There is nothing at this address.{' '}
        <Link to="/" className="font-medium text-emerald-700 hover:underline dark:text-emerald-400">
          Go to the dashboard
        </Link>
        .
      </p>
    </div>
  );
}
