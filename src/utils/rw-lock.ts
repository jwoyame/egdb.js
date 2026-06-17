/**
 * A small async readers-writer lock.
 *
 * Why this exists: a connection wraps ONE driver-level transaction slot (mssql
 * `this.transaction`, pg `this.transactionClient`). While a transaction is open,
 * every statement on that connection routes through it, so two overlapping
 * operations collide on a single physical request. A server that shares one
 * connection across many users (e.g. one SDE login for all app users) therefore
 * needs to guarantee that a transaction has the connection to itself.
 *
 * Reads can run together (they go to the pool, not the transaction), so they
 * take the lock in SHARED mode; a transaction takes it EXCLUSIVELY for its whole
 * lifetime (begin..commit/rollback). Streaming reads run on their own dedicated
 * pooled connection and don't take the lock at all.
 *
 * Fairness: a waiting writer blocks newly-arriving readers (no writer
 * starvation), while consecutive queued readers are granted together.
 *
 * Not reentrant: the transaction owner must NOT re-acquire while holding the
 * write lock (that would self-deadlock on the non-reentrant exclusive grant).
 * Callers already guard begin with an `inTransaction()` check, and the owner's
 * own statements bypass the lock because they detect the open transaction.
 */

interface Waiter {
  isWrite: boolean;
  grant: () => void;
}

export class RwLock {
  private readers = 0;
  private writer = false;
  private queue: Waiter[] = [];

  /** Run `fn` holding the shared (read) lock. */
  async read<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.releaseRead();
    }
  }

  /** Run `fn` holding the exclusive (write) lock. */
  async write<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.releaseWrite();
    }
  }

  acquireRead(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ isWrite: false, grant: resolve });
      this.drain();
    });
  }

  acquireWrite(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ isWrite: true, grant: resolve });
      this.drain();
    });
  }

  releaseRead(): void {
    if (this.readers <= 0) throw new Error('RwLock: releaseRead with no active reader');
    this.readers--;
    this.drain();
  }

  releaseWrite(): void {
    if (!this.writer) throw new Error('RwLock: releaseWrite with no active writer');
    this.writer = false;
    this.drain();
  }

  /** Grant queued waiters in FIFO order, batching consecutive readers. */
  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (next.isWrite) {
        // A writer can only proceed with the connection entirely to itself.
        // Leave it at the head (blocking later readers) until it can run.
        if (this.readers === 0 && !this.writer) {
          this.queue.shift();
          this.writer = true;
          next.grant();
        }
        return;
      }
      // Reader: proceed unless a writer holds the lock. A writer at the head
      // was handled above, so readers never jump ahead of a waiting writer.
      if (this.writer) return;
      this.queue.shift();
      this.readers++;
      next.grant();
    }
  }
}
