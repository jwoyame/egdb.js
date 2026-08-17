import { describe, it, expect } from 'vitest';
import { classifyConnError, SqlServerConnection } from '../src/connections/sqlserver';

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

  it('does NOT retry a read while a transaction is open', async () => {
    const conn = makeConn();
    injectPool(conn, async () => ({ recordset: [] }));
    let calls = 0;
    (conn as unknown as { transaction: unknown }).transaction = {
      request: () => makeRequest(async () => { calls++; throw connErr; }),
    };
    await expect(conn.query('SELECT 1')).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('does NOT retry a read on a real SQL error', async () => {
    const conn = makeConn();
    let calls = 0;
    injectPool(conn, async () => { calls++; throw { name: 'RequestError', code: 'EREQUEST', message: 'Invalid column' }; });
    await expect(conn.query('SELECT bad')).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });
});
