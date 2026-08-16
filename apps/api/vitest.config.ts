import { defineConfig } from 'vitest/config';

// Unit tests only. Anything ending in .integration.test.ts needs a live
// Postgres and runs from vitest.integration.config.ts instead, so that the
// default `pnpm test` stays runnable on a laptop with nothing installed.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['cobertura', 'text-summary'],
      reportsDirectory: './coverage',
      enabled: true,
    },
  },
});
