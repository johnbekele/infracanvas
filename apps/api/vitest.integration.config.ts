import { defineConfig } from 'vitest/config';

// Integration tests run against a real Postgres with the migrations applied.
// They share a database, so they run in a single process: parallel workers
// would truncate each other's tables between a write and its assertion.
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['src/test/setup-integration.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
  },
});
