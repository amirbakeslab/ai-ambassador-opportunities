import { defineConfig } from 'vitest/config';

// Live tests call real services. They skip themselves unless the matching
// environment variables are set. Never point them at the published catalog.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
