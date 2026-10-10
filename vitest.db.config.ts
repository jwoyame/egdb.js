import { defineConfig } from 'vitest/config';
import { DB_TEST_FILES } from './tests/db-test-files';

// Real-server tests (SQL Server / PostgreSQL), run with file parallelism
// off: several of these files share one scratch database and step on
// each other's data when run as separate concurrent workers. Each file
// still skips cleanly on its own when its EGDB_* env vars are unset.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: DB_TEST_FILES,
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
  },
});
