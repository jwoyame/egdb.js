/**
 * Transaction ownership on a shared SqlServerConnection, under real concurrent
 * execution. Each test drives the actual withTransaction/query/execute code from
 * two or more genuinely concurrent async call chains (Promise.all with real
 * timers in between), against a fake driver that throws EREQINPROG whenever two
 * requests overlap on one transaction, exactly like mssql does.
 */
import { describe, it, expect, vi } from 'vitest';
import { FakeDb, attachFakePool, sleep, type StatementHandler } from './helpers/fake-mssql';

vi.mock('mssql', async () => (await import('./helpers/fake-mssql')).mockModule);

const { SqlServerConnection } = await import('../src/connections/sqlserver');
const { CompressLockHolder } = await import('../src/reconcile/applock');
type Conn = InstanceType<typeof SqlServerConnection>;

// Statements may carry "WAIT <ms>" to take that long on the server, and the
// compress applock is always granted.
const handler: StatementHandler = async (sqlText) => {
  if (/sp_getapplock/.test(sqlText)) return { recordset: [{ code: 0 }], rowsAffected: [1] };
  const wait = /WAIT (\d+)/.exec(sqlText);
  if (wait) await sleep(Number(wait[1]));
  return { recordset: [{ sql: sqlText }], rowsAffected: [1] };
};

function makeConn(db: FakeDb, opts: { dedicatedPool?: boolean } = {}): Conn {
  const conn = new SqlServerConnection({
    driver: 'sqlserver', server: 's', database: 'd', user: 'u', password: 'p',
    options: { dedicatedPool: opts.dedicatedPool },
  } as never);
  attachFakePool(conn, db);
  return conn;
}

/** Fail the test instead of hanging if `p` doesn't settle in time. */
function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => { throw new Error(`${what} did not finish within ${ms}ms (deadlock?)`); }),
  ]);
}

/** Transaction id each statement whose text includes `tag` ran on (null = pool). */
function routes(db: FakeDb, tag: string): (number | null)[] {
  return db.log.filter((e) => e.sql.includes(tag)).map((e) => e.tx);
}

describe('SqlServerConnection transaction ownership (concurrent call chains)', () => {
  it('two concurrent transactions each run only on their own transaction', async () => {
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    const chain = (tag: string) => conn.withTransaction(async () => {
      expect(conn.inTransaction()).toBe(true);
      await conn.query(`SELECT '${tag}-1' WAIT 15`);
      await sleep(10);
      await conn.execute(`UPDATE t SET x = '${tag}-2' WAIT 15`);
      await conn.query(`SELECT '${tag}-3'`);
      return tag;
    });

    const results = await within(2000, Promise.all([chain('A'), chain('B')]), 'two transactions');

    expect(results).toEqual(['A', 'B']);
    expect(db.overlaps).toBe(0);
    expect(db.transactions).toHaveLength(2);
    expect(db.transactions.every((t) => t.state === 'committed')).toBe(true);
    const [txA, txB] = db.transactions.map((t) => t.id);
    expect(routes(db, "'A-")).toEqual([txA, txA, txA]);
    expect(routes(db, "'B-")).toEqual([txB, txB, txB]);
    expect(conn.inTransaction()).toBe(false);
  });

  it('a transaction started while another is open waits for it instead of joining it', async () => {
    // The usual request shape: B arrives while A's transaction is open.
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    const chain = (tag: string) => conn.withTransaction(async () => {
      await conn.query(`SELECT '${tag}-1' WAIT 15`);
      await sleep(10);
      await conn.execute(`UPDATE t SET x = '${tag}-2' WAIT 15`);
    });
    const a = chain('A');
    await sleep(5);
    const b = chain('B');

    await within(2000, Promise.all([a, b]), 'overlapping transactions');

    expect(db.overlaps).toBe(0);
    expect(db.transactions).toHaveLength(2);
    expect(db.transactions.every((t) => t.state === 'committed')).toBe(true);
    const [txA, txB] = db.transactions.map((t) => t.id);
    expect(routes(db, "'A-")).toEqual([txA, txA]);
    expect(routes(db, "'B-")).toEqual([txB, txB]);
  });

  it("a concurrent non-owner never runs on the owner's transaction and does not wait for it", async () => {
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    let ownerCommitted = false;
    let readerDoneBeforeCommit = false;

    const owner = (async () => {
      await conn.withTransaction(async () => {
        await conn.query(`SELECT 'OWN-1' WAIT 20`);
        await sleep(30);
        await conn.execute(`UPDATE t SET x = 'OWN-2' WAIT 20`);
      });
      ownerCommitted = true;
    })();
    const reader = (async () => {
      await sleep(5); // the owner's transaction is open from here on
      expect(conn.inTransaction()).toBe(false);
      await conn.query(`SELECT 'READ-1' WAIT 10`);
      await conn.execute(`UPDATE t SET x = 'READ-2'`);
      await conn.executeInsert(`INSERT INTO t OUTPUT INSERTED.OBJECTID VALUES ('READ-3')`);
      readerDoneBeforeCommit = !ownerCommitted;
    })();

    await within(2000, Promise.all([owner, reader]), 'owner + reader');

    expect(db.overlaps).toBe(0);
    const txId = db.transactions[0]!.id;
    expect(routes(db, 'OWN-')).toEqual([txId, txId]);
    expect(routes(db, 'READ-')).toEqual([null, null, null]);
    expect(readerDoneBeforeCommit).toBe(true);
  });

  it('a Promise.all sibling of the opener does not inherit ownership', async () => {
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    let siblingSawTx: boolean | undefined;

    // `a` reaches withTransaction before its first await, from the same
    // synchronous frame that starts `b`.
    const a = () => conn.withTransaction(async () => {
      await conn.query(`SELECT 'A-1' WAIT 20`);
      await sleep(20);
      await conn.query(`SELECT 'A-2' WAIT 20`);
    });
    const b = async () => {
      await sleep(10);
      siblingSawTx = conn.inTransaction();
      await conn.query(`SELECT 'B-1' WAIT 20`);
      await conn.query(`SELECT 'B-2' WAIT 20`);
    };

    await within(2000, Promise.all([a(), b()]), 'siblings');

    expect(siblingSawTx).toBe(false);
    expect(db.overlaps).toBe(0);
    const txId = db.transactions[0]!.id;
    expect(routes(db, "'A-")).toEqual([txId, txId]);
    expect(routes(db, "'B-")).toEqual([null, null]);
  });

  it("ownership does not leak to the opener's caller after the callback returns", async () => {
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    let holdOpen!: () => void;
    const held = new Promise<void>((resolve) => { holdOpen = resolve; });
    // The transaction stays open (another chain holds it), yet the code that
    // started that chain is not its owner.
    const opener = conn.withTransaction(async () => {
      await conn.query(`SELECT 'IN-1'`);
      await held;
    });
    await sleep(10);
    expect(conn.inTransaction()).toBe(false);
    await conn.query(`SELECT 'OUT-1'`);
    holdOpen();
    await opener;
    expect(routes(db, 'OUT-')).toEqual([null]);
    expect(db.overlaps).toBe(0);
  });

  it("the owner's own concurrent statements are queued, not overlapped", async () => {
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    await within(2000, conn.withTransaction(async () => {
      await Promise.all([
        conn.query(`SELECT 'P-1' WAIT 15`),
        conn.query(`SELECT 'P-2' WAIT 5`),
        conn.execute(`UPDATE t SET x = 'P-3' WAIT 10`),
        conn.executeInsert(`INSERT INTO t OUTPUT INSERTED.OBJECTID VALUES ('P-4')`),
      ]);
    }), 'parallel owner statements');
    expect(db.overlaps).toBe(0);
    const txId = db.transactions[0]!.id;
    expect(routes(db, "'P-")).toEqual([txId, txId, txId, txId]);
    expect(db.transactions[0]!.state).toBe('committed');
  });

  it('a nested call joins the open transaction instead of deadlocking', async () => {
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    await within(2000, conn.withTransaction(async () => {
      await conn.withTransaction(async () => {
        expect(conn.inTransaction()).toBe(true);
        await conn.query(`SELECT 'N-1'`);
      });
      await conn.query(`SELECT 'N-2'`);
    }), 'nested withTransaction');
    expect(db.transactions).toHaveLength(1);
    expect(routes(db, 'N-')).toEqual([db.transactions[0]!.id, db.transactions[0]!.id]);
  });

  it('a failing transaction rolls back only itself; a concurrent one still commits', async () => {
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    const good = conn.withTransaction(async () => {
      await conn.query(`SELECT 'G-1' WAIT 20`);
      await sleep(10);
      await conn.query(`SELECT 'G-2'`);
    });
    const bad = conn.withTransaction(async () => {
      await conn.query(`SELECT 'X-1' WAIT 5`);
      throw new Error('boom');
    });
    const outcome = await within(2000, Promise.allSettled([good, bad]), 'good + bad');
    expect(outcome.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    expect(db.transactions.map((t) => t.state)).toEqual(['committed', 'rolledback']);
    expect(db.overlaps).toBe(0);
  });

  it('keeps ownership of an outer transaction while the caller opens one on another connection', async () => {
    // Two connections, each with its own transaction slot. Opening B's
    // transaction from inside A's must not cost A its ownership.
    const db = new FakeDb(handler);
    const connA = makeConn(db);
    const connB = makeConn(db);
    let inner: { aOwned: boolean; bOwned: boolean } | undefined;
    let afterInner: boolean | undefined;

    const work = connA.withTransaction(async () => {
      await connA.query(`SELECT 'A-1' WAIT 10`);
      await connB.withTransaction(async () => {
        await connB.query(`SELECT 'B-1' WAIT 10`);
        await connA.query(`SELECT 'A-2' WAIT 10`);
        inner = { aOwned: connA.inTransaction(), bOwned: connB.inTransaction() };
      });
      afterInner = connA.inTransaction();
      await connA.query(`SELECT 'A-3'`);
    });
    // Meanwhile an unrelated chain uses both connections.
    const other = (async () => {
      await sleep(5);
      await connA.query(`SELECT 'O-1' WAIT 10`);
      await connB.withTransaction(async () => { await connB.query(`SELECT 'O-2' WAIT 10`); });
    })();

    await within(2000, Promise.all([work, other]), 'cross-connection nesting');

    expect(inner).toEqual({ aOwned: true, bOwned: true });
    expect(afterInner).toBe(true);
    expect(db.overlaps).toBe(0);
    const txA = db.log.find((e) => e.sql.includes("'A-1'"))!.tx!;
    const txB = db.log.find((e) => e.sql.includes("'B-1'"))!.tx!;
    expect(routes(db, "'A-")).toEqual([txA, txA, txA]);
    expect(routes(db, "'O-1'")).toEqual([null]);
    const txO = db.log.find((e) => e.sql.includes("'O-2'"))!.tx!;
    expect(txO).not.toBe(txB);
    expect(db.transactions.every((t) => t.state === 'committed')).toBe(true);
  });

  it('an owner can await work a non-owner started (shared, memoized load) without deadlock', async () => {
    // The openTable() cache shape: a non-owner starts a multi-statement load,
    // then a transaction owner awaits the same promise.
    const db = new FakeDb(handler);
    const conn = makeConn(db);
    let shared: Promise<string> | null = null;
    const load = () => (shared ??= (async () => {
      await conn.query(`SELECT 'LOAD-1' WAIT 10`);
      await sleep(15);
      await conn.query(`SELECT 'LOAD-2' WAIT 10`);
      return 'loaded';
    })());

    const reader = load();
    await sleep(2);
    const owner = conn.withTransaction(async () => {
      await conn.query(`SELECT 'OWN-1'`);
      return load();
    });
    const [r, o] = await within(2000, Promise.all([reader, owner]), 'memoized load');
    expect([r, o]).toEqual(['loaded', 'loaded']);
    expect(routes(db, 'LOAD-')).toEqual([null, null]);
    expect(db.overlaps).toBe(0);
  });

  it('a statement timeout cancels only its own call tree, and rollback waits for the canceled request', async () => {
    const db = new FakeDb(async (sqlText, { request }) => {
      if (sqlText.includes('HANG')) {
        // Never finishes on its own; a cancel makes it reject shortly after.
        return request.cancelable(new Promise(() => {}));
      }
      return handler(sqlText, { tx: null, request });
    });
    const conn = makeConn(db);

    const timed = conn.withStatementTimeout(30, () =>
      conn.withTransaction(async () => { await conn.execute(`UPDATE t SET x = 'HANG'`); }),
    ).then(() => 'resolved', (e: { code?: string }) => e.code);
    // Another caller's slow statement in its own transaction, with no timeout.
    const untimed = (async () => {
      await sleep(5);
      return conn.withTransaction(async () => {
        await conn.query(`SELECT 'SLOW' WAIT 60`);
        return 'ok';
      });
    })();

    const [timedResult, untimedResult] = await within(3000, Promise.all([timed, untimed]), 'timeout scenario');
    expect(timedResult).toBe('ETIMEOUT');
    expect(untimedResult).toBe('ok');
    // Rolled back cleanly: no EREQINPROG from rolling back over the canceled request.
    expect(db.overlaps).toBe(0);
    expect(db.transactions.map((t) => t.state)).toEqual(['rolledback', 'committed']);
  });
});

describe('CompressLockHolder with a concurrent main-connection transaction', () => {
  it('releases (rolls back, then closes) promptly while another connection holds a transaction', async () => {
    const lockDb = new FakeDb(handler);
    const mainDb = new FakeDb(handler);
    const lockConn = makeConn(lockDb, { dedicatedPool: true });
    const main = makeConn(mainDb);

    // Keep-alive every 5ms so pings interleave with everything below.
    const holder = await within(2000, CompressLockHolder.acquire(lockConn, 1000, 5), 'acquire');

    // A graduate-shaped transaction on the main connection, plus a concurrent
    // editor read, while the lock is held.
    const graduate = main.withTransaction(async () => {
      await main.query(`SELECT 'GRAD-1' WAIT 15`);
      await sleep(20);
      holder.assertHeld();
      await main.execute(`UPDATE base SET x = 'GRAD-2' WAIT 15`);
    }, { isolation: 'serializable' });
    const editorRead = (async () => {
      await sleep(5);
      await main.query(`SELECT 'ED-1' WAIT 10`);
    })();
    await within(2000, Promise.all([graduate, editorRead]), 'main work');

    // Release while another main transaction is still open.
    let releaseMain!: () => void;
    const mainOpen = main.withTransaction(async () => {
      await main.query(`SELECT 'LATE-1'`);
      await new Promise<void>((resolve) => { releaseMain = resolve; });
    });
    await sleep(5);
    await within(1000, holder.release(), 'holder.release()');
    releaseMain();
    await mainOpen;

    const lockTx = lockDb.transactions[0]!;
    expect(lockDb.transactions).toHaveLength(1);
    expect(lockTx.state).toBe('rolledback');
    expect(lockDb.closed).toBe(true);
    // The applock and every ping ran on the held session, never on the pool.
    const pings = lockDb.log.filter((e) => e.sql.includes('SELECT 1 AS ka'));
    expect(pings.length).toBeGreaterThan(0);
    expect(lockDb.log.every((e) => e.tx === lockTx.id)).toBe(true);
    expect(lockDb.overlaps + mainDb.overlaps).toBe(0);
    expect(routes(mainDb, 'ED-1')).toEqual([null]);
    expect(mainDb.transactions[0]!.isolation).toBe(4); // SERIALIZABLE
  });

  it("the holder's transaction is not owned by the code that acquired it", async () => {
    const lockDb = new FakeDb(handler);
    const lockConn = makeConn(lockDb, { dedicatedPool: true });
    const holder = await CompressLockHolder.acquire(lockConn, 1000, 5);
    try {
      expect(lockConn.inTransaction()).toBe(false);
      await lockConn.query(`SELECT 'CALLER-1'`);
      expect(routes(lockDb, 'CALLER-1')).toEqual([null]);
    } finally {
      await within(1000, holder.release(), 'holder.release()');
    }
  });

  it('closes the connection and rethrows when the lock cannot be acquired', async () => {
    const lockDb = new FakeDb(async (sqlText) => {
      if (/sp_getapplock/.test(sqlText)) return { recordset: [{ code: -1 }], rowsAffected: [1] };
      return { recordset: [], rowsAffected: [0] };
    });
    const lockConn = makeConn(lockDb, { dedicatedPool: true });
    await expect(CompressLockHolder.acquire(lockConn, 100, 5)).rejects.toThrow(/Timed out acquiring Exclusive/);
    expect(lockDb.transactions[0]!.state).toBe('rolledback');
    expect(lockDb.closed).toBe(true);
  });
});
