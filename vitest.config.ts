import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
  },
});
