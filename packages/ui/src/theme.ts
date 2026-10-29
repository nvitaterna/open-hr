/**
 * Dark mode (decision 0010): follows the system unless the user picked light
 * or dark, which is remembered in this browser. The `dark` class on <html>
 * switches Tailwind's dark variant.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'ohr-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const THEMES = ['system', 'light', 'dark'] as const;

type Theme = (typeof THEMES)[number];

function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme);
}

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (isTheme(value)) {
      return value;
    }
  } catch {
    // Storage can be blocked; the system setting still applies.
  }
  return 'system';
}

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not remembered, but still applied for this visit.
  }
}

/** Sets the `dark` class for `theme`, asking the system when it is "system". */
function applyTheme(theme: Theme): void {
  let dark = theme === 'dark';
  if (theme === 'system') {
    dark = globalThis.matchMedia(DARK_QUERY).matches;
  }
  document.documentElement.classList.toggle('dark', dark);
}

/** The current theme and a function that moves to the next one. */
export function useTheme(): { theme: Theme; cycle: () => void } {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') {
      return;
    }
    const media = globalThis.matchMedia(DARK_QUERY);
    const follow = (): void => applyTheme('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [theme]);
  const cycle = useCallback(() => {
    setTheme((current) => {
      const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length] ?? 'system';
      storeTheme(next);
      return next;
    });
  }, []);
  return { theme, cycle };
}

export { THEMES, type Theme };
