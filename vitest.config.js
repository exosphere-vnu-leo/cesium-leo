import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**']
  }
});
