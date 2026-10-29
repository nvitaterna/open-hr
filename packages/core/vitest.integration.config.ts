import { defineConfig } from 'vitest/config';

/** Integration tests on loop devices. Run as root: they partition and write to the devices. */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
