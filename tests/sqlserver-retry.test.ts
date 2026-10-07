import { describe, it, expect, vi } from 'vitest';
import { classifyConnError, SqlServerConnection } from '../src/connections/sqlserver';
import { FakeDb, attachFakePool, sleep } from './helpers/fake-mssql';

// Transactions go through the real withTransaction code on a fake driver.
vi.mock('mssql', async () => (await import('./helpers/fake-mssql')).mockModule);

// A live pool/request is faked so we can exercise the retry routing without a
// real SQL Server. `connected: true` keeps reestablishIfDown a no-op (it won't
// call sql.connect), isolating the retry-vs-no-retry decision.
function makeConn(): SqlServerConnection {
  return new SqlServerConnection({ server: 's', database: 'd', user: 'u', password: 'p' } as never);
}
function makeRequest(onQuery: () => Promise<unknown>) {
  const req = { input: () => req, query: onQuery };
  return req;
}
function injectPool(conn: SqlServerConnection, onQuery: () => Promise<unknown>) {
  (conn as unknown as { pool: unknown }).pool = {
    connected: true,
    request: () => makeRequest(onQuery),
    close: async () => {},
  };
}
const connErr = { name: 'ConnectionError', code: 'ETIMEOUT' };

// The classifier decides whether a failed statement can be safely retried. The
// safety-critical rule: a WRITE may only retry when the statement provably never
// reached the server ('connection'); a request-timeout ('request-timeout') might
// have committed, so a write must never retry it.
describe('classifyConnError', () => {
  it('treats an mssql ConnectionError as connection-level (never ran)', () => {
    expect(classifyConnError({ name: 'ConnectionError', code: 'ETIMEOUT' })).toBe('connection');
    expect(classifyConnError({ name: 'ConnectionError', code: 'ESOCKET' })).toBe('connection');
  });

  it('treats socket-level codes as connection-level', () => {
    for (const code of ['ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'EPIPE', 'ENOTOPEN', 'ENOCONN']) {
      expect(classifyConnError({ code })).toBe('connection');
    }
  });

  it('treats a bare timeout with no RequestError name as a connect/acquire timeout', () => {
    // This is the shape of the ETIMEOUT that hit version-create: code ETIMEOUT,
    // no server context, no RequestError name.
    expect(classifyConnError({ code: 'ETIMEOUT', number: 'ETIMEOUT', serverName: undefined })).toBe('connection');
    expect(classifyConnError({ code: 'ETIMEDOUT' })).toBe('connection');
  });

  it('treats a RequestError timeout as request-timeout, NOT connection', () => {
    // Same ETIMEOUT code, but it reached the server and may have committed.
    // A write must not retry this.
    expect(classifyConnError({ name: 'RequestError', code: 'ETIMEOUT' })).toBe('request-timeout');
    expect(classifyConnError({ name: 'RequestError', code: 'ETIMEDOUT' })).toBe('request-timeout');
  });

  it('matches connection-loss messages', () => {
    expect(classifyConnError({ message: 'Failed to connect to pa-parcels:1433 in 15000ms' })).toBe('connection');
    expect(classifyConnError({ message: 'Connection is closed.' })).toBe('connection');
    expect(classifyConnError({ message: 'Connection lost - socket hang up' })).toBe('connection');
  });

  it('never retries a real SQL/logic error', () => {
    expect(classifyConnError({ name: 'RequestError', code: 'EREQUEST', message: 'Invalid column name' })).toBe('other');
    expect(classifyConnError(new Error('some app error'))).toBe('other');
    expect(classifyConnError(null)).toBe('other');
    expect(classifyConnError(undefined)).toBe('other');
  });
});

describe('SqlServerConnection retry routing', () => {
  it('retries a READ once through a connection blip and succeeds', async () => {
    const conn = makeConn();
    let calls = 0;
    injectPool(conn, async () => {
      calls++;
      if (calls === 1) throw connErr;
      return { recordset: [{ ok: 1 }] };
    });
    const rows = await conn.query('SELECT 1');
    expect(rows).toEqual([{ ok: 1 }]);
    expect(calls).toBe(2); // one retry
  });

  it("retries a READ on a request-timeout too", async () => {
    const conn = makeConn();
    let calls = 0;
    injectPool(conn, async () => {
      calls++;
      if (calls === 1) throw { name: "RequestError", code: "ETIMEOUT" };
      return { recordset: [{ ok: 1 }] };
    });
    const rows = await conn.query("SELECT 1");
    expect(rows).toEqual([{ ok: 1 }]);
    expect(calls).toBe(2);
  });

  it('does NOT retry a mutating query (the create_version/double-apply guard)', async () => {
    const conn = makeConn();
    let calls = 0;
    injectPool(conn, async () => { calls++; throw connErr; });
    await expect(conn.query('EXEC sde.create_version', [], { mutating: true })).rejects.toBeTruthy();
    expect(calls).toBe(1); // no retry
  });

  it('does NOT retry a write (execute)', async () => {
    const conn = makeConn();
    let calls = 0;
    injectPool(conn, async () => { calls++; throw { name: 'ConnectionError', code: 'ESOCKET' }; });
    await expect(conn.execute('UPDATE x SET y = 1')).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('does NOT retry a write (executeInsert)', async () => {
    const conn = makeConn();
    let calls = 0;
    injectPool(conn, async () => { calls++; throw connErr; });
    await expect(conn.executeInsert('INSERT INTO x OUTPUT INSERTED.OBJECTID VALUES (1)')).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it("does NOT retry the owner's read on its open transaction", async () => {
    const conn = makeConn();
    let calls = 0;
    attachFakePool(conn, new FakeDb(async () => { calls++; throw connErr; }));
    await expect(conn.withTransaction(() => conn.query('SELECT 1'))).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it("retries a non-owner's pooled read while another caller's transaction is open", async () => {
    const conn = makeConn();
    let pooledCalls = 0;
    attachFakePool(conn, new FakeDb(async (sqlText, { tx }) => {
      if (tx || sqlText !== 'SELECT pooled') return { recordset: [] };
      pooledCalls++;
      if (pooledCalls === 1) throw connErr;
      return { recordset: [{ ok: 1 }] };
    }));
    let release!: () => void;
    const open = conn.withTransaction(async () => {
      await conn.query('SELECT in_tx');
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await sleep(5);
    const rows = await conn.query('SELECT pooled');
    release();
    await open;
    expect(rows).toEqual([{ ok: 1 }]);
    expect(pooledCalls).toBe(2);
  });

  it('does NOT retry a read on a real SQL error', async () => {
    const conn = makeConn();
    let calls = 0;
    injectPool(conn, async () => { calls++; throw { name: 'RequestError', code: 'EREQUEST', message: 'Invalid column' }; });
    await expect(conn.query('SELECT bad')).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });
});

describe('withStatementTimeout (edit fast-fail)', () => {
  // The timeout only applies to statements the caller runs on its OWN open
  // transaction, so these tests run them inside withTransaction on the fake
  // driver -- matching how a merge runs its writes.
  function hangingDb(onRequest?: (canceled: () => boolean) => void): FakeDb {
    return new FakeDb(async (sqlText, { request }) => {
      onRequest?.(() => request.canceled);
      if (sqlText.includes('HANG')) return request.cancelable(new Promise(() => {}));
      return { recordset: [], rowsAffected: [1] };
    });
  }

  it('cancels a slow in-transaction statement and rejects ~timeout with ETIMEOUT', async () => {
    const conn = makeConn();
    let canceled = () => false;
    const db = hangingDb((c) => { canceled = c; });
    attachFakePool(conn, db);
    const t = Date.now();
    const err = await conn.withStatementTimeout(150, () =>
      conn.withTransaction(() => conn.execute('UPDATE x SET y=1 HANG')),
    ).catch((e) => e);
    const elapsed = Date.now() - t;
    expect(canceled()).toBe(true);
    expect((err as { code?: string }).code).toBe('ETIMEOUT');
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1000);
    expect(db.transactions[0]!.state).toBe('rolledback');
  });

  it('does NOT time out a fast statement, and applies only inside its callback', async () => {
    const conn = makeConn();
    let canceled = () => false;
    attachFakePool(conn, hangingDb((c) => { canceled = c; }));
    const r = await conn.withStatementTimeout(150, () =>
      conn.withTransaction(() => conn.execute('UPDATE x SET y=1')),
    );
    expect(r.rowsAffected).toBe(1);
    // Outside the callback no timeout applies: a slower statement is not canceled.
    attachFakePool(conn, new FakeDb(async () => { await sleep(200); return { rowsAffected: [0] }; }));
    await conn.withTransaction(() => conn.execute('UPDATE x SET y=2'));
    expect(canceled()).toBe(false);
  });

  it("does NOT arm another concurrent caller's statements", async () => {
    const conn = makeConn();
    attachFakePool(conn, new FakeDb(async (sqlText) => {
      if (sqlText.includes('SLOW')) await sleep(120);
      return { rowsAffected: [1] };
    }));
    // The timed caller's scope stays open while the other caller's slow
    // in-transaction statement runs.
    const timed = conn.withStatementTimeout(60, async () => { await sleep(250); });
    const untimed = (async () => {
      await sleep(5);
      return conn.withTransaction(() => conn.execute('UPDATE b SET y=1 SLOW'));
    })();
    await expect(Promise.all([timed, untimed])).resolves.toHaveLength(2);
  });

  it('does NOT cancel a POOLED (concurrent) statement even while a timeout is set', async () => {
    // A pooled read during another op's timeout window must not be canceled.
    const conn = makeConn();
    let canceled = false;
    const pooledReq = { input() { return this; }, query: async () => ({ recordset: [{ n: 1 }] }), cancel: () => { canceled = true; } };
    (conn as unknown as { pool: unknown }).pool = { connected: true, request: () => pooledReq, close: async () => {} };
    // No transaction -> pooled path; even with a short timeout set, no cancel.
    const rows = await conn.withStatementTimeout(10, () => conn.query('SELECT 1'));
    expect(rows).toEqual([{ n: 1 }]);
    expect(canceled).toBe(false);
  });
});
