/**
 * Transaction ownership on a shared PostgreSQLConnection, driven from
 * concurrent call chains against a fake pg pool that records which client
 * (transaction) or the pool each statement ran on.
 */
import { describe, it, expect } from 'vitest';
import { PostgreSQLConnection } from '../src/connections/postgresql';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakePg {
  log: Array<{ sql: string; client: number | null }>;
  clients: Array<{ id: number; statements: string[]; released: boolean; destroyed: boolean }>;
}

function makeConn(opts: { failCommit?: boolean } = {}): { conn: PostgreSQLConnection; pg: FakePg } {
  const pg: FakePg = { log: [], clients: [] };
  const run = async (sqlText: string) => {
    const wait = /WAIT (\d+)/.exec(sqlText);
    if (wait) await sleep(Number(wait[1]));
    return { rows: [{ sql: sqlText }], rowCount: 1 };
  };
  const pool = {
    query: async (sqlText: string) => {
      pg.log.push({ sql: sqlText, client: null });
      return run(sqlText);
    },
    connect: async () => {
      const rec = { id: pg.clients.length + 1, statements: [] as string[], released: false, destroyed: false };
      pg.clients.push(rec);
      return {
        query: async (sqlText: string) => {
          pg.log.push({ sql: sqlText, client: rec.id });
          rec.statements.push(sqlText);
          if (opts.failCommit && sqlText === 'COMMIT') throw new Error('commit failed');
          return run(sqlText);
        },
        release: (destroy?: boolean) => { rec.released = true; rec.destroyed = !!destroy; },
      };
    },
    end: async () => {},
  };
  const conn = new PostgreSQLConnection({ driver: 'postgresql', server: 's', database: 'd', user: 'u', password: 'p' } as never);
  (conn as unknown as { pool: unknown }).pool = pool;
  return { conn, pg };
}

function routes(pg: FakePg, tag: string): (number | null)[] {
  return pg.log.filter((e) => e.sql.includes(tag)).map((e) => e.client);
}

describe('PostgreSQLConnection transaction ownership (concurrent call chains)', () => {
  it('runs the owner on its client and a concurrent non-owner on the pool', async () => {
    const { conn, pg } = makeConn();
    let readerSawTx: boolean | undefined;
    const owner = conn.withTransaction(async () => {
      await conn.query(`SELECT 'OWN-1' WAIT 15`);
      await sleep(15);
      await conn.execute(`UPDATE t SET x = 'OWN-2'`);
    });
    const reader = (async () => {
      await sleep(5);
      readerSawTx = conn.inTransaction();
      await conn.query(`SELECT 'READ-1' WAIT 5`);
      await conn.executeInsert(`INSERT INTO t VALUES ('READ-2') RETURNING objectid`);
    })();
    await Promise.all([owner, reader]);

    expect(readerSawTx).toBe(false);
    expect(routes(pg, 'OWN-')).toEqual([1, 1]);
    expect(routes(pg, 'READ-')).toEqual([null, null]);
    expect(pg.clients[0]!.statements[0]).toBe('BEGIN');
    expect(pg.clients[0]!.statements.at(-1)).toBe('COMMIT');
    expect(pg.clients[0]!.released).toBe(true);
  });

  it('serializes two transactions, each on its own client, and keeps siblings out', async () => {
    const { conn, pg } = makeConn();
    const chain = (tag: string) => conn.withTransaction(async () => {
      await conn.query(`SELECT '${tag}-1' WAIT 10`);
      await sleep(5);
      await conn.query(`SELECT '${tag}-2'`);
    }, { isolation: 'serializable' });
    const sibling = async () => {
      await sleep(3);
      await conn.query(`SELECT 'SIB-1'`);
    };
    await Promise.all([chain('A'), chain('B'), sibling()]);

    expect(routes(pg, "'A-")).toEqual([1, 1]);
    expect(routes(pg, "'B-")).toEqual([2, 2]);
    expect(routes(pg, 'SIB-')).toEqual([null]);
    expect(pg.clients.map((c) => c.statements[0])).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'BEGIN ISOLATION LEVEL SERIALIZABLE']);
    // B began only after A committed.
    const aCommit = pg.log.findIndex((e) => e.client === 1 && e.sql === 'COMMIT');
    const bBegin = pg.log.findIndex((e) => e.client === 2 && e.sql.startsWith('BEGIN'));
    expect(bBegin).toBeGreaterThan(aCommit);
  });

  it('rolls back on a rejection and destroys a client whose COMMIT failed', async () => {
    const { conn, pg } = makeConn();
    await expect(conn.withTransaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(pg.clients[0]!.statements.at(-1)).toBe('ROLLBACK');
    expect(pg.clients[0]!.destroyed).toBe(false);

    const failing = makeConn({ failCommit: true });
    await expect(failing.conn.withTransaction(async () => {})).rejects.toThrow('commit failed');
    expect(failing.pg.clients[0]!.destroyed).toBe(true);
    expect(failing.conn.inTransaction()).toBe(false);
    // The slot is free again.
    await expect(failing.conn.query(`SELECT 'AFTER'`)).resolves.toHaveLength(1);
  });
});
