/**
 * A transaction must always end on the SERVER, not just in our bookkeeping.
 *
 * mssql refuses to commit or roll back while a request is still active on the
 * transaction (EREQINPROG). That refusal sends nothing to the server and never
 * hands the pooled connection back, so a caller that treats it as "rollback
 * done" leaves BEGIN TRAN open with its locks held for the life of the process.
 * A pooled login in that state blocks every other session that needs the same
 * rows - including `sde.create_version` on the SDE version tables.
 *
 * The driver's own Transaction is used here, against a fake pool and a fake
 * tedious connection, so these tests pin the real driver behavior rather than a
 * model of it.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import sql from 'mssql';
import { SqlServerConnection, CANCEL_DRAIN_MS } from '../src/connections/sqlserver';

/** Stands in for a tedious connection borrowed by a transaction. A real event
 * emitter, so the driver's own listeners (its abort handler) attach and run. */
class FakeTedious extends EventEmitter {
  closed = false;
  commits = 0;
  rollbacks = 0;
  /** Set to make the server-side commit/rollback report a failure. */
  failWith: Error | null = null;
  beginTransaction(cb: (e?: Error) => void): void { setImmediate(cb); }
  commitTransaction(cb: (e?: Error | null) => void): void { this.commits++; setImmediate(() => cb(this.failWith)); }
  rollbackTransaction(cb: (e?: Error | null) => void): void { this.rollbacks++; setImmediate(() => cb(this.failWith)); }
  close(): void { this.closed = true; }
}

interface Harness {
  conn: SqlServerConnection;
  tedious: FakeTedious;
  releasedToPool: unknown[];
  /** The live mssql Transaction the connection opened. */
  tx: sql.Transaction;
}

async function openTransaction(): Promise<Harness> {
  const conn = new SqlServerConnection({ server: 's', database: 'd', user: 'u', password: 'p' } as never);
  const tedious = new FakeTedious();
  const releasedToPool: unknown[] = [];
  (conn as unknown as { pool: unknown }).pool = {
    connected: true,
    close: async () => {},
    request: () => ({ input() { return this; }, query: async () => ({ recordset: [], rowsAffected: [0] }) }),
    // What mssql's Transaction calls to borrow and return a connection.
    acquire: (_tx: unknown, cb: (e: unknown, c: unknown, cfg: unknown) => void) => cb(null, tedious, {}),
    release: (c: unknown) => { releasedToPool.push(c); },
  };
  await conn.beginTransaction();
  const tx = (conn as unknown as { transaction: sql.Transaction }).transaction;
  return { conn, tedious, releasedToPool, tx };
}

/** Mark a request as still running on the transaction, which is what a just-
 * canceled statement looks like to the driver. */
function setRequestInProgress(tx: sql.Transaction, active: boolean): void {
  (tx as unknown as { _activeRequest: unknown })._activeRequest = active ? {} : null;
}

describe('ending a transaction whose request is still unwinding', () => {
  it('rolls back for real once the in-flight request finishes', async () => {
    const { conn, tedious } = await openTransaction();
    const tx = (conn as unknown as { transaction: sql.Transaction }).transaction;
    setRequestInProgress(tx, true);
    setTimeout(() => setRequestInProgress(tx, false), 250);

    await conn.rollbackTransaction();

    expect(tedious.rollbacks).toBe(1);
    expect(tedious.closed).toBe(false);
    expect(conn.inTransaction()).toBe(false);
  });

  it('closes the connection when the request never finishes, so the server rolls back', async () => {
    const { conn, tedious, releasedToPool, tx } = await openTransaction();
    setRequestInProgress(tx, true); // never cleared

    await expect(conn.rollbackTransaction()).rejects.toMatchObject({ code: 'EREQINPROG' });

    // The driver sent no ROLLBACK, so the only way to free the server-side locks
    // is to drop the connection.
    expect(tedious.rollbacks).toBe(0);
    expect(tedious.closed).toBe(true);
    // Handed back so the pool destroys it and opens a replacement, instead of
    // the slot being lost.
    expect(releasedToPool).toContain(tedious);
    expect(conn.inTransaction()).toBe(false);
  }, 10000);

  it('closes the connection when a commit can never be sent', async () => {
    const { conn, tedious, tx } = await openTransaction();
    setRequestInProgress(tx, true);

    await expect(conn.commitTransaction()).rejects.toMatchObject({ code: 'EREQINPROG' });

    // Nothing was committed, so ending the transaction by dropping the
    // connection loses no write.
    expect(tedious.commits).toBe(0);
    expect(tedious.closed).toBe(true);
    expect(conn.inTransaction()).toBe(false);
  }, 10000);

  it('closes the connection when a commit reaches the server and fails', async () => {
    // Here the driver DID send the commit, so it hands the connection back to
    // the pool itself - open transaction and all. Closing it is what guarantees
    // the server ends that transaction, and costs nothing if the commit landed.
    const { conn, tedious, releasedToPool } = await openTransaction();
    tedious.failWith = new Error('Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements');

    await expect(conn.commitTransaction()).rejects.toBeTruthy();

    expect(tedious.commits).toBe(1);
    expect(tedious.closed).toBe(true);
    // Released once, by the driver. A second release would corrupt the pool's
    // accounting for a connection it already took back.
    expect(releasedToPool.filter((c) => c === tedious)).toHaveLength(1);
    expect(conn.inTransaction()).toBe(false);
  });

  it('closes the connection when a rollback reaches the server and fails', async () => {
    const { conn, tedious } = await openTransaction();
    tedious.failWith = new Error('Connection lost');

    await expect(conn.rollbackTransaction()).rejects.toBeTruthy();

    expect(tedious.closed).toBe(true);
    expect(conn.inTransaction()).toBe(false);
  });

  it('leaves the connection alone when the server rolls the transaction back during the wait', async () => {
    // The in-flight request's response carries a server-side rollback (a deadlock
    // victim, say). The driver's abort handler hands the connection back to the
    // pool, which can give it to another caller right away, so closing it here
    // would kill that caller's live query - and the server has already rolled
    // back, so there is nothing left to clean up.
    const { conn, tedious, releasedToPool, tx } = await openTransaction();
    setRequestInProgress(tx, true);
    setTimeout(() => {
      tedious.emit('rollbackTransaction');
      setRequestInProgress(tx, false);
    }, 150);

    await expect(conn.rollbackTransaction()).rejects.toMatchObject({ code: 'EABORT' });
    await new Promise((resolve) => setImmediate(resolve)); // the driver releases on the next tick

    expect(tedious.closed).toBe(false);
    expect(releasedToPool.filter((c) => c === tedious)).toHaveLength(1); // by the driver only
    expect(conn.inTransaction()).toBe(false);
  });

  it('detaches the driver abort listener before dropping a connection it still holds', async () => {
    // Once the transaction lets go of the connection, a late rollback notice from
    // the half-read response must not reach the driver's abort handler: that
    // handler would dereference the missing connection and throw inside the
    // driver's token handler, which crashes the process.
    const { conn, tedious, tx } = await openTransaction();
    setRequestInProgress(tx, true);
    expect(tedious.listenerCount('rollbackTransaction')).toBe(1);

    await expect(conn.rollbackTransaction()).rejects.toMatchObject({ code: 'EREQINPROG' });

    expect(tedious.closed).toBe(true);
    expect(tedious.listenerCount('rollbackTransaction')).toBe(0);
    expect(() => tedious.emit('rollbackTransaction')).not.toThrow();
  }, 10000);

  it('frees the connection for the next transaction either way', async () => {
    const { conn, tx } = await openTransaction();
    setRequestInProgress(tx, true);
    await expect(conn.rollbackTransaction()).rejects.toBeTruthy();
    // The write lock must be released, or every later edit on this connection
    // would hang waiting for a transaction that is already gone.
    await conn.beginTransaction();
    expect(conn.inTransaction()).toBe(true);
  }, 10000);
});

describe('statement timeout cancel', () => {
  function injectTx(conn: SqlServerConnection, req: unknown): void {
    (conn as unknown as { pool: unknown }).pool = { connected: true, request: () => req, close: async () => {} };
    (conn as unknown as { transaction: unknown }).transaction = { request: () => req };
  }

  it('waits for the canceled statement to unwind before returning to the caller', async () => {
    // The caller rolls back as soon as this rejects. If the request is still
    // active then, the driver refuses the rollback and the transaction is
    // stranded open on the server.
    const conn = new SqlServerConnection({ server: 's', database: 'd', user: 'u', password: 'p' } as never);
    let requestFinished = false;
    let finish: () => void = () => {};
    const req = {
      input() { return this; },
      query: () => new Promise((resolve) => {
        finish = () => { requestFinished = true; resolve({ rowsAffected: [0] }); };
      }),
      // A real server acknowledges the attention a moment later.
      cancel: () => { setTimeout(() => finish(), 50); },
    };
    injectTx(conn, req);

    const err = await conn.withStatementTimeout(50, () => conn.execute('UPDATE x SET y=1')).catch((e) => e);

    expect((err as { code?: string }).code).toBe('ETIMEOUT');
    expect(requestFinished).toBe(true);
  });

  it('waits CANCEL_DRAIN_MS for a wedged connection, then gives up', async () => {
    const conn = new SqlServerConnection({ server: 's', database: 'd', user: 'u', password: 'p' } as never);
    const req = { input() { return this; }, query: () => new Promise(() => {}), cancel: () => {} };
    injectTx(conn, req);

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = conn
        .withStatementTimeout(50, () => conn.execute('UPDATE x SET y=1'))
        .catch((e) => e)
        .then((v) => { settled = true; return v; });

      // The statement timeout fires and the cancel goes out.
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      // Still holding the caller while the request could yet unwind.
      await vi.advanceTimersByTimeAsync(CANCEL_DRAIN_MS - 200);
      expect(settled).toBe(false);
      // Past the bound, the caller is released rather than waiting forever.
      await vi.advanceTimersByTimeAsync(400);
      expect(settled).toBe(true);
      expect((await pending as { code?: string }).code).toBe('ETIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the driver tear down a stuck request before the drain gives up', () => {
    // Both timers run on a canceled statement: the driver's cancelTimeout and
    // our drain. The driver's must fire first, because its teardown ends the
    // request properly and lets the caller's rollback through, where ours only
    // stops the waiting. Equal values would leave that to timer ordering.
    const conn = new SqlServerConnection({ server: 's', database: 'd', user: 'u', password: 'p' } as never);
    const cfg = (conn as unknown as { config: { options: { cancelTimeout: number } } }).config;
    expect(cfg.options.cancelTimeout).toBeLessThan(CANCEL_DRAIN_MS);
  });
});
