import { defineConfig } from 'vitest/config';

// Database-backed tests (see README.md here). One Postgres for the whole run
// (global-setup.ts); each test file provisions its own tenant schema, so files
// run in parallel without seeing each other's rows.
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    globalSetup: ['./src/global-setup.ts'],
    setupFiles: ['./src/setup.ts'],
    // Provisioning a tenant runs all ~45 tenant migrations.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
