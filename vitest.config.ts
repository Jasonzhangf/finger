import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/api/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/modules/**/*.test.ts',
      'tests/orchestration/**/*.test.ts',
      'tests/agents/**/*.test.ts',
      'tests/e2e-ui/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**']
    }
  }
});
