import { hostname } from 'node:os';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/** Where `pnpm dev` runs ohr-web (decision 0010), unless OHR_WEB_URL says otherwise. */
const DEFAULT_WEB_URL = 'http://127.0.0.1:7700';
const DEV_PORT = 5173;

export default defineConfig(({ mode }) => {
  const { OHR_WEB_URL: webUrl = DEFAULT_WEB_URL } = loadEnv(mode, import.meta.dirname, 'OHR_');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: DEV_PORT,
      strictPort: true,
      // With --host, browsing from another computer by this machine's name, such as http://ohr-dev:5173.
      allowedHosts: [hostname()],
      // changeOrigin stays false: web checks Origin against the Host the browser used.
      proxy: { '/api': { target: webUrl } },
    },
    build: { outDir: 'dist', emptyOutDir: true },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});
