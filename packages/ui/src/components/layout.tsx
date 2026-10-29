import { type ReactElement, useCallback } from 'react';
import { NavLink, Outlet } from 'react-router';

import { type LiveStatus, useLiveEvents } from '../api/live-events.ts';
import { useLogout } from '../api/queries.ts';
import { type Theme, useTheme } from '../theme.ts';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/drives', label: 'Drives' },
  { to: '/volumes', label: 'Volumes' },
  { to: '/jobs', label: 'Jobs' },
] as const;

const LIVE_LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  offline: 'Offline',
};

const LIVE_DOTS: Record<LiveStatus, string> = {
  connecting: 'bg-amber-500',
  live: 'bg-emerald-500',
  offline: 'bg-red-500',
};

const THEME_LABELS: Record<Theme, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function navClass({ isActive }: { readonly isActive: boolean }): string {
  const base = 'rounded-md px-3 py-1.5 text-sm font-medium';
  if (isActive) {
    return `${base} bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50`;
  }
  return `${base} text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50`;
}

function LiveIndicator({ status }: { readonly status: LiveStatus }): ReactElement {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400"
      title="Whether this page gets updates as they happen"
    >
      <span className={`size-2 rounded-full ${LIVE_DOTS[status]}`} aria-hidden={true} />
      {LIVE_LABELS[status]}
    </span>
  );
}

const SMALL_BUTTON =
  'rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50';

/** The signed-in frame around every page: navigation, live status, theme, and sign-out. */
export function Layout({ username }: { readonly username: string }): ReactElement {
  const live = useLiveEvents();
  const { theme, cycle } = useTheme();
  const logout = useLogout();
  const { mutate: signOut } = logout;
  const onSignOut = useCallback(() => signOut(), [signOut]);
  return (
    <div className="min-h-dvh">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold tracking-tight">Open HR</span>
          <nav aria-label="Main" className="flex flex-wrap gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LiveIndicator status={live} />
            <button type="button" className={SMALL_BUTTON} onClick={cycle}>
              {THEME_LABELS[theme]}
            </button>
            <button
              type="button"
              className={SMALL_BUTTON}
              disabled={logout.isPending}
              onClick={onSignOut}
            >
              Sign out {username}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
