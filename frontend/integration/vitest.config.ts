import { defineConfig } from 'vitest/config';

// Separate from browser/jsdom tests: only the optional local process harness.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/submission-reth.integration.ts'],
    testTimeout: 30_000,
    hookTimeout: 45_000,
    fileParallelism: false,
  },
});
