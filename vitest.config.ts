import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ["./tests/setup/test-isolation.ts"],
    include: [
      'src/**/__tests__/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/api/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
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
