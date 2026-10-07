/**
 * A small async readers-writer lock.
 *
 * The connections use only the exclusive (write) mode, to allow one open
 * transaction at a time in their single transaction slot (see
 * SqlServerConnection.txLock). Statements that don't own the transaction run on
 * the pool and don't take the lock.
 *
 * Fairness: a waiting writer blocks newly-arriving readers (no writer
 * starvation), while consecutive queued readers are granted together.
 *
 * Not reentrant: a holder must NOT re-acquire while holding the write lock
 * (that would self-deadlock on the non-reentrant exclusive grant).
 * withTransaction() avoids this by joining a transaction the caller already
 * owns instead of acquiring again.
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
