import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// The first render of a page can take over a second on a busy CI runner.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  // jsdom has no matchMedia. The tests run in light mode.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
