import { configDefaults, defineConfig } from 'vitest/config';

/** Unit tests. Integration tests need root and real devices, see vitest.integration.config.ts. */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
