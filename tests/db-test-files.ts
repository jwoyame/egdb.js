/**
 * Test files that connect to a real SQL Server or PostgreSQL instance,
 * gated at runtime by env vars such as EGDB_HOST, EGDB_COMPRESS_DB, or
 * EGDB_PG_HOST (each file skips cleanly when its vars are unset). They
 * share scratch databases/tables across files, so running them in the
 * same worker pool concurrently can make one file's setup or teardown
 * collide with another's in-flight data. vitest.config.ts excludes
 * them from the default (parallel) run; vitest.db.config.ts runs them
 * with file parallelism turned off.
 */
export const DB_TEST_FILES = [
  'tests/compress/applock.test.ts',
  'tests/compress/closure-gate.test.ts',
  'tests/compress/crash.test.ts',
  'tests/compress/e2e.test.ts',
  'tests/compress/graduate-collapse.test.ts',
  'tests/compress/n11.test.ts',
  'tests/compress/preconditions.test.ts',
  'tests/compress/property.test.ts',
  'tests/compress/rootfix.test.ts',
  'tests/compress/structural-bugs.test.ts',
  'tests/integration.test.ts',
  'tests/integration-concurrency.test.ts',
  'tests/post-base-shadow.test.ts',
  'tests/post/trim-post.test.ts',
  'tests/rebase/rebase.test.ts',
  'tests/shared-connection-db.test.ts',
];
