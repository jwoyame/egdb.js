import type { IDatabaseConnection } from '../connections/connection';

/**
 * Roll back the current transaction, if one is still open, without letting the
 * rollback's own failure replace the error being handled.
 *
 * Two things go wrong when a catch block rolls back blindly. A commit that
 * failed has already closed the transaction, so an unguarded rollback throws
 * "No transaction in progress" over the real cause. And a rollback that
 * genuinely fails hides both that failure and the cause. So the rollback is
 * guarded, and its failure is reported instead of dropped: a silently failed
 * rollback can leave a pooled connection holding an open transaction, and
 * nothing else in the system will say so.
 *
 * Only call this for a transaction the caller opened - check `wasInTx` first, or
 * a caller-owned transaction gets rolled back underneath them.
 *
 * @param operation Name of the calling operation, for the log line.
 */
export async function rollbackQuietly(
  connection: IDatabaseConnection,
  operation: string,
): Promise<void> {
  if (!connection.inTransaction()) return;
  try {
    await connection.rollbackTransaction();
  } catch (rollbackError) {
    console.error(
      `[egdb] ${operation}: rollback failed while handling an error; ` +
      `the connection may still hold an open transaction:`,
      rollbackError,
    );
  }
}
