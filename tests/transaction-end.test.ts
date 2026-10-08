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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import sql from 'mssql';
import { SqlServerConnection, CANCEL_DRAIN_MS } from '../src/connections/sqlserver';
import { runAsOwner } from '../src/connections/tx-ownership';

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
  /** A statement sent here never gets a response: a wedged request. */
  execSql(): void {}
  execSqlBatch(): void {}
  cancel(): void {}
  close(): void { this.closed = true; }
}

const CALLBACK_FAILED = new Error('callback failed');

interface Harness {
  conn: SqlServerConnection;
  tedious: FakeTedious;
  releasedToPool: unknown[];
  /** The live mssql Transaction the connection opened. */
  tx: sql.Transaction;
  /** Run `fn` as the transaction's owner (inside its callback's call tree). */
  asOwner: <T>(fn: () => Promise<T>) => Promise<T>;
  /** End the callback successfully; resolves or rejects with the commit. */
  commit: () => Promise<void>;
  /** Fail the callback; settles once withTransaction has rolled back. */
  fail: () => Promise<unknown>;
}

async function openTransaction(): Promise<Harness> {
  const conn = new SqlServerConnection({ server: 's', database: 'd', user: 'u', password: 'p' } as never);
  const tedious = new FakeTedious();
  const releasedToPool: unknown[] = [];
  (conn as unknown as { pool: unknown }).pool = {
    connected: true,
    config: {},
    close: async () => {},
    request: () => ({ input() { return this; }, query: async () => ({ recordset: [], rowsAffected: [0] }) }),
    // What mssql's Transaction calls to borrow and return a connection.
    acquire: (_tx: unknown, cb: (e: unknown, c: unknown, cfg: unknown) => void) => cb(null, tedious, {}),
    release: (c: unknown) => { releasedToPool.push(c); },
  };
  let finish!: (ok: boolean) => void;
  const body = new Promise<void>((resolve, reject) => {
    finish = (ok) => (ok ? resolve() : reject(CALLBACK_FAILED));
  });
  let token!: object;
  const ended = conn.withTransaction(async () => {
    token = (conn as unknown as { txToken: object }).txToken;
    await body;
  });
  ended.catch(() => { /* observed through commit() / fail() */ });
  while (!token) await new Promise((resolve) => setImmediate(resolve));
  const tx = (conn as unknown as { transaction: sql.Transaction }).transaction;
  return {
    conn, tedious, releasedToPool, tx,
    asOwner: (fn) => runAsOwner(token, fn),
    commit: () => { finish(true); return ended; },
    fail: () => { finish(false); return ended.catch((e: unknown) => e); },
  };
}

/** Mark a request as still running on the transaction, which is what a just-
 * canceled statement looks like to the driver. */
function setRequestInProgress(tx: sql.Transaction, active: boolean): void {
  (tx as unknown as { _activeRequest: unknown })._activeRequest = active ? {} : null;
}

function isOpen(conn: SqlServerConnection): boolean {
  return (conn as unknown as { transaction: unknown }).transaction !== null;
}

describe('ending a transaction whose request is still unwinding', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('rolls back for real once the in-flight request finishes', async () => {
    const { conn, tedious, tx, fail } = await openTransaction();
    setRequestInProgress(tx, true);
    setTimeout(() => setRequestInProgress(tx, false), 250);

    expect(await fail()).toBe(CALLBACK_FAILED);

    expect(tedious.rollbacks).toBe(1);
    expect(tedious.closed).toBe(false);
    expect(isOpen(conn)).toBe(false);
  });

  it('closes the connection when the request never finishes, so the server rolls back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { conn, tedious, releasedToPool, tx, fail } = await openTransaction();
    setRequestInProgress(tx, true); // never cleared

    // The caller sees its own error; the failed rollback is logged, not lost.
    expect(await fail()).toBe(CALLBACK_FAILED);
    expect(logged.mock.calls.some((args) => (args[1] as { code?: string })?.code === 'EREQINPROG')).toBe(true);

    // The driver sent no ROLLBACK, so the only way to free the server-side locks
    // is to drop the connection.
    expect(tedious.rollbacks).toBe(0);
    expect(tedious.closed).toBe(true);
    // Handed back so the pool destroys it and opens a replacement, instead of
    // the slot being lost.
    expect(releasedToPool).toContain(tedious);
    expect(isOpen(conn)).toBe(false);
  }, 10000);

  it('closes the connection when a commit can never be sent', async () => {
    const { conn, tedious, tx, commit } = await openTransaction();
    setRequestInProgress(tx, true);

    await expect(commit()).rejects.toMatchObject({ code: 'EREQINPROG' });

    // Nothing was committed, so ending the transaction by dropping the
    // connection loses no write.
    expect(tedious.commits).toBe(0);
    expect(tedious.closed).toBe(true);
    expect(isOpen(conn)).toBe(false);
  }, 10000);

  it('closes the connection when a commit reaches the server and fails', async () => {
    // Here the driver DID send the commit, so it hands the connection back to
    // the pool itself - open transaction and all. Closing it is what guarantees
    // the server ends that transaction, and costs nothing if the commit landed.
    const { conn, tedious, releasedToPool, commit } = await openTransaction();
    tedious.failWith = new Error('Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements');

    await expect(commit()).rejects.toBeTruthy();

    expect(tedious.commits).toBe(1);
    expect(tedious.closed).toBe(true);
    // Released once, by the driver. A second release would corrupt the pool's
    // accounting for a connection it already took back.
    expect(releasedToPool.filter((c) => c === tedious)).toHaveLength(1);
    expect(isOpen(conn)).toBe(false);
  });

  it('closes the connection when a rollback reaches the server and fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { conn, tedious, fail } = await openTransaction();
    tedious.failWith = new Error('Connection lost');

    expect(await fail()).toBe(CALLBACK_FAILED);

    expect(tedious.closed).toBe(true);
    expect(isOpen(conn)).toBe(false);
  });

  it('leaves the connection alone when the server rolls the transaction back during the wait', async () => {
    // The in-flight request's response carries a server-side rollback (a deadlock
    // victim, say). The driver's abort handler hands the connection back to the
    // pool, which can give it to another caller right away, so closing it here
    // would kill that caller's live query - and the server has already rolled
    // back, so there is nothing left to clean up.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { conn, tedious, releasedToPool, tx, fail } = await openTransaction();
    setRequestInProgress(tx, true);
    setTimeout(() => {
      tedious.emit('rollbackTransaction');
      setRequestInProgress(tx, false);
    }, 150);

    expect(await fail()).toBe(CALLBACK_FAILED);
    expect(logged.mock.calls.some((args) => (args[1] as { code?: string })?.code === 'EABORT')).toBe(true);
    await new Promise((resolve) => setImmediate(resolve)); // the driver releases on the next tick

    expect(tedious.closed).toBe(false);
    expect(releasedToPool.filter((c) => c === tedious)).toHaveLength(1); // by the driver only
    expect(isOpen(conn)).toBe(false);
  });

  it('detaches the driver abort listener before dropping a connection it still holds', async () => {
    // Once the transaction lets go of the connection, a late rollback notice from
    // the half-read response must not reach the driver's abort handler: that
    // handler would dereference the missing connection and throw inside the
    // driver's token handler, which crashes the process.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tedious, tx, fail } = await openTransaction();
    setRequestInProgress(tx, true);
    expect(tedious.listenerCount('rollbackTransaction')).toBe(1);

    await fail();

    expect(tedious.closed).toBe(true);
    expect(tedious.listenerCount('rollbackTransaction')).toBe(0);
    expect(() => tedious.emit('rollbackTransaction')).not.toThrow();
  }, 10000);

  it('frees the connection for the next transaction either way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { conn, tx, fail } = await openTransaction();
    setRequestInProgress(tx, true);
    await fail();
    // The lock must be released, or every later edit on this connection would
    // hang waiting for a transaction that is already gone.
    const inside = await conn.withTransaction(async () => conn.inTransaction());
    expect(inside).toBe(true);
  }, 10000);

  it('does not wait forever behind a statement that never finishes', async () => {
    // A statement the owner started is still running when its callback fails
    // (a Promise.all sibling, say), and the server never answers it. The
    // rollback waits for it only up to CANCEL_DRAIN_MS, then drops the
    // connection, so the transaction slot is not held for the life of the process.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { conn, tedious, asOwner, fail } = await openTransaction();
    const stuck = asOwner(() => conn.execute('UPDATE x SET y = 1'));
    stuck.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    const started = Date.now();
    expect(await fail()).toBe(CALLBACK_FAILED);
    const waited = Date.now() - started;

    expect(waited).toBeGreaterThanOrEqual(CANCEL_DRAIN_MS - 100);
    expect(waited).toBeLessThan(CANCEL_DRAIN_MS + 3000);
    expect(logged.mock.calls.some((args) => (args[1] as { code?: string })?.code === 'EREQINPROG')).toBe(true);
    expect(tedious.rollbacks).toBe(0);
    expect(tedious.closed).toBe(true);
    expect(isOpen(conn)).toBe(false);
  }, CANCEL_DRAIN_MS + 8000);
});

describe('statement timeout cancel', () => {
  /** Give `conn` an open transaction whose requests are all `req`, and return a
   * runner that executes a callback as that transaction's owner. */
  function injectTx(conn: SqlServerConnection, req: unknown): <T>(fn: () => Promise<T>) => Promise<T> {
    const token = {};
    (conn as unknown as { pool: unknown }).pool = { connected: true, request: () => req, close: async () => {} };
    (conn as unknown as { transaction: unknown }).transaction = { request: () => req };
    (conn as unknown as { txToken: unknown }).txToken = token;
    return (fn) => runAsOwner(token, fn);
  }

  it('waits for the canceled statement to unwind before returning to the caller', async () => {
    // The caller rolls back as soon as this rejects, so it should see the
    // transaction idle by then.
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
    const asOwner = injectTx(conn, req);

    const err = await asOwner(() => conn.withStatementTimeout(50, () => conn.execute('UPDATE x SET y=1'))).catch((e) => e);

    expect((err as { code?: string }).code).toBe('ETIMEOUT');
    expect(requestFinished).toBe(true);
  });

  it('waits CANCEL_DRAIN_MS for a wedged connection, then gives up', async () => {
    const conn = new SqlServerConnection({ server: 's', database: 'd', user: 'u', password: 'p' } as never);
    const req = { input() { return this; }, query: () => new Promise(() => {}), cancel: () => {} };
    const asOwner = injectTx(conn, req);

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = asOwner(() => conn.withStatementTimeout(50, () => conn.execute('UPDATE x SET y=1')))
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
