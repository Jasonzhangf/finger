import { defineConfig } from 'vitest/config';

export default defineConfig({
 test: {
   globals: true,
   environment: 'node',
    include: ['tests/integration/**/*.test.ts', 'tests/e2e/**/*.spec.ts'],
   testTimeout: 0, // No timeout for E2E tests
   hookTimeout: 120000, // 2 minutes for setup/teardown
   reporters: ['verbose'],
 }
});
