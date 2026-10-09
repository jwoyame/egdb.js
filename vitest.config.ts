import { defineConfig } from 'vitest/config';
import { DB_TEST_FILES } from './tests/db-test-files';

// DB-backed tests run separately (see vitest.db.config.ts), serialized
// against the scratch databases they share. Everything here is either a
// pure unit test or a real-server test that is a no-op without its env
// vars, so it is safe to run with normal file parallelism.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', ...DB_TEST_FILES],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
