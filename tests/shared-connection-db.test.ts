/**
 * One connection object shared by concurrent callers, against a real server.
 *
 * An app serves every user through one cached connection per database. A long
 * transaction (a post, an edit save) runs on it while other requests (map tile
 * reads) keep using the same object. These tests drive that shape with
 * genuinely concurrent async chains and ask the server itself which session and
 * transaction each statement ran in.
 *
 * SQL Server: gated on EGDB_COMPRESS_DB (same scratch server as tests/compress,
 * see tests/compress/db.ts). PostgreSQL: gated on EGDB_PG_HOST, with
 * EGDB_PG_PORT / EGDB_PG_USER / EGDB_PG_PASSWORD / EGDB_PG_DATABASE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqlServerConnection } from '../src/connections/sqlserver';
import { PostgreSQLConnection } from '../src/connections/postgresql';
import { CFG, HAVE_DB } from './compress/db';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (e: unknown): string =>
  (e as { code?: string })?.code ?? String((e as Error)?.message ?? e).slice(0, 40);

const MSSQL_DB = 'egdb_shared_connection_test';

interface ReadStats { ok: number; insideOwnerTx: number; errors: Record<string, number> }

/**
 * Keep reading from `read` on several chains, each starting at a random time,
 * until `done()`. A read counts as inside the owner's transaction when the
 * server reports an open transaction for it.
 */
async function tileTraffic(
  chains: number,
  done: () => boolean,
  read: () => Promise<{ inTx: boolean }>,
): Promise<ReadStats> {
  const stats: ReadStats = { ok: 0, insideOwnerTx: 0, errors: {} };
  const chain = async () => {
    await sleep(20 + Math.random() * 300);
    while (!done()) {
      try {
        const r = await read();
        stats.ok++;
        if (r.inTx) stats.insideOwnerTx++;
      } catch (e) {
        const c = codeOf(e);
        stats.errors[c] = (stats.errors[c] ?? 0) + 1;
      }
      await sleep(Math.random() * 3);
    }
  };
  await Promise.all(Array.from({ length: chains }, chain));
  return stats;
}

describe.skipIf(!HAVE_DB)('SqlServerConnection shared by concurrent callers (real server)', () => {
  let conn: SqlServerConnection;
  let other: SqlServerConnection;

  beforeAll(async () => {
    const master = new SqlServerConnection({ ...CFG, database: 'master' });
    await master.connect();
    await master.execute(`IF DB_ID('${MSSQL_DB}') IS NULL CREATE DATABASE ${MSSQL_DB};`);
    await master.close();
    conn = new SqlServerConnection({ ...CFG, database: MSSQL_DB, options: { ...CFG.options, dedicatedPool: true } });
    await conn.connect();
    other = new SqlServerConnection({ ...CFG, database: MSSQL_DB, options: { ...CFG.options, dedicatedPool: true } });
    await other.connect();
    await conn.execute(`IF OBJECT_ID('dbo.edits') IS NULL CREATE TABLE dbo.edits (id int IDENTITY PRIMARY KEY, who varchar(20))`);
    await conn.execute(`IF OBJECT_ID('dbo.versions') IS NULL CREATE TABLE dbo.versions (name varchar(20))`);
    await conn.execute(`DELETE FROM dbo.versions; INSERT INTO dbo.versions VALUES ('DEFAULT')`);
  });
  afterAll(async () => {
    await conn?.close();
    await other?.close();
  });

  const reset = () => conn.execute(`DELETE FROM dbo.edits`);
  const count = async (c: SqlServerConnection = conn) =>
    (await c.query<{ n: number }>(`SELECT COUNT(*) AS n FROM dbo.edits`))[0]!.n;

  for (let run = 1; run <= 3; run++) {
    it(`a post-like transaction commits while tile reads hit the same connection (run ${run})`, async () => {
      await reset();
      let done = false;
      let ownerSpid = -1;
      const spidsDuringPost = new Set<number>();

      // About 80 sequential, awaited statements with a few ms of server time
      // each, like postVersion's statements against a remote server.
      const post = conn.withTransaction(async () => {
        ownerSpid = (await conn.query<{ s: number }>('SELECT @@SPID AS s'))[0]!.s;
        for (let i = 0; i < 80; i++) {
          if (i % 2) await conn.execute(`WAITFOR DELAY '00:00:00.004'; INSERT INTO dbo.edits (who) VALUES ('post')`);
          else await conn.query(`WAITFOR DELAY '00:00:00.004'; SELECT COUNT(*) AS n FROM dbo.edits`);
        }
      }).finally(() => { done = true; });

      const tiles = tileTraffic(8, () => done, async () => {
        const r = await conn.query<{ s: number; tc: number }>(
          `SELECT @@SPID AS s, @@TRANCOUNT AS tc, (SELECT COUNT(*) FROM dbo.versions) AS n`);
        if (!done) spidsDuringPost.add(r[0]!.s);
        return { inTx: r[0]!.tc > 0 };
      });

      const [postResult, stats] = await Promise.allSettled([post, tiles]);
      expect(postResult.status).toBe('fulfilled');
      const s = (stats as PromiseFulfilledResult<ReadStats>).value;
      expect(s.errors).toEqual({});
      expect(s.ok).toBeGreaterThan(20); // tile reads really did overlap the post
      expect(s.insideOwnerTx).toBe(0);
      expect(spidsDuringPost.has(ownerSpid)).toBe(false);
      expect(await count()).toBe(40);
    }, 60000);
  }

  it('a second caller does not join a transaction it did not open', async () => {
    // EditSession.start / geodatabase.transaction open their own transaction
    // unless inTransaction() says the caller already has one. Another user's
    // open transaction must not count, or that user's save would be written
    // inside it and rolled back with it.
    await reset();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = conn.withTransaction(async () => {
      await conn.execute(`INSERT INTO dbo.edits (who) VALUES ('owner')`);
      await gate;
      throw new Error('owner failed');
    }).catch((e: Error) => e.message);
    await sleep(50);

    expect(conn.inTransaction()).toBe(false);
    const saving = conn.withTransaction(async () => {
      await conn.execute(`INSERT INTO dbo.edits (who) VALUES ('other-user')`);
    });
    await sleep(50);
    release();

    expect(await owner).toBe('owner failed');
    await saving;
    const rows = await conn.query<{ who: string }>(`SELECT who FROM dbo.edits`);
    expect(rows.map((r) => r.who)).toEqual(['other-user']);
  }, 30000);

  it('runs the owner\'s own concurrent statements one at a time', async () => {
    await reset();
    await conn.withTransaction(async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) =>
        conn.execute(`WAITFOR DELAY '00:00:00.002'; INSERT INTO dbo.edits (who) VALUES ('p${i}')`)));
    });
    expect(await count()).toBe(20);
  }, 30000);

  it('does not hand ownership to a sibling started next to withTransaction', async () => {
    let siblingInTx: boolean | null = null;
    let siblingTranCount = -1;
    await Promise.all([
      conn.withTransaction(async () => { await sleep(100); }),
      (async () => {
        await sleep(30);
        siblingInTx = conn.inTransaction();
        siblingTranCount = (await conn.query<{ tc: number }>('SELECT @@TRANCOUNT AS tc'))[0]!.tc;
      })(),
    ]);
    expect(siblingInTx).toBe(false);
    expect(siblingTranCount).toBe(0);
    expect(conn.inTransaction()).toBe(false);
  }, 30000);

  it('lets an owner await work that a non-owner started', async () => {
    // A shared in-flight load (e.g. openTable) started by a tile read and
    // awaited by the owner must not wait for the owner's transaction to end.
    let shared: Promise<unknown> | null = null;
    const load = () => (shared ??= conn.query(`WAITFOR DELAY '00:00:00.050'; SELECT COUNT(*) AS n FROM dbo.versions`));
    const tile = (async () => { await sleep(5); return load(); })();
    const owner = conn.withTransaction(async () => {
      await sleep(10);
      return load();
    });
    const res = await Promise.race([
      Promise.all([tile, owner]).then(() => 'done'),
      sleep(5000).then(() => 'stuck'),
    ]);
    expect(res).toBe('done');
  }, 30000);

  it('owns transactions on two connections at once', async () => {
    await reset();
    await conn.withTransaction(async () => {
      await conn.execute(`INSERT INTO dbo.edits (who) VALUES ('a')`);
      await other.withTransaction(async () => {
        expect(conn.inTransaction()).toBe(true);
        expect(other.inTransaction()).toBe(true);
        await other.execute(`INSERT INTO dbo.versions (name) VALUES ('nested')`);
        await conn.execute(`INSERT INTO dbo.edits (who) VALUES ('b')`);
      });
    });
    expect(await count()).toBe(2);
    await conn.execute(`DELETE FROM dbo.versions WHERE name = 'nested'`);
  }, 30000);

  it('a statement timeout inside a transaction rolls back cleanly and frees the locks', async () => {
    // The canceled statement must unwind before the rollback is sent, or the
    // driver refuses the rollback and the transaction stays open on the server.
    await reset();
    await conn.execute(`INSERT INTO dbo.edits (who) VALUES ('seed')`);
    const err = await conn.withTransaction(() =>
      conn.withStatementTimeout(200, async () => {
        await conn.execute(`UPDATE dbo.edits SET who = 'locked'`);
        await conn.execute(`WAITFOR DELAY '00:00:05'`);
      }),
    ).catch((e) => e);
    expect(codeOf(err)).toBe('ETIMEOUT');
    expect(conn.inTransaction()).toBe(false);

    // Another session can take the row lock right away: nothing is left open.
    await other.execute(`SET LOCK_TIMEOUT 2000; UPDATE dbo.edits SET who = 'free'`);
    const open = await other.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sys.dm_tran_session_transactions t
         JOIN sys.dm_exec_sessions s ON s.session_id = t.session_id
        WHERE s.database_id = DB_ID()`);
    expect(open[0]!.n).toBe(0);
    expect((await other.query<{ who: string }>(`SELECT who FROM dbo.edits`))[0]!.who).toBe('free');
  }, 30000);

  it('serializes two transactions on the same connection', async () => {
    await reset();
    const order: string[] = [];
    await Promise.all(['a', 'b', 'c'].map((who) =>
      conn.withTransaction(async () => {
        order.push(`${who}+`);
        await conn.execute(`WAITFOR DELAY '00:00:00.020'; INSERT INTO dbo.edits (who) VALUES ('${who}')`);
        order.push(`${who}-`);
      })));
    // Each one finishes before the next begins.
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.slice(0, 1)).toBe(order[i + 1]!.slice(0, 1));
    expect(await count()).toBe(3);
  }, 30000);
});

const HAVE_PG = !!process.env.EGDB_PG_HOST;

describe.skipIf(!HAVE_PG)('PostgreSQLConnection shared by concurrent callers (real server)', () => {
  let conn: PostgreSQLConnection;

  beforeAll(async () => {
    conn = new PostgreSQLConnection({
      driver: 'postgresql',
      server: process.env.EGDB_PG_HOST!,
      port: Number(process.env.EGDB_PG_PORT ?? 5432),
      user: process.env.EGDB_PG_USER ?? 'postgres',
      password: process.env.EGDB_PG_PASSWORD ?? '',
      database: process.env.EGDB_PG_DATABASE ?? 'postgres',
    });
    await conn.connect();
    await conn.execute(`CREATE TABLE IF NOT EXISTS egdb_shared_edits (id serial PRIMARY KEY, who text)`);
  });
  afterAll(async () => {
    await conn?.execute(`DROP TABLE IF EXISTS egdb_shared_edits`).catch(() => {});
    await conn?.close();
  });

  const reset = () => conn.execute(`DELETE FROM egdb_shared_edits`);

  it('a post-like transaction commits while tile reads hit the same connection', async () => {
    await reset();
    let done = false;
    let ownerTxid = '';
    const post = conn.withTransaction(async () => {
      ownerTxid = (await conn.query<{ t: string }>('SELECT txid_current()::text AS t'))[0]!.t;
      for (let i = 0; i < 80; i++) {
        if (i % 2) await conn.execute(`INSERT INTO egdb_shared_edits (who) SELECT 'post' FROM pg_sleep(0.004)`);
        else await conn.query(`SELECT COUNT(*) AS n FROM egdb_shared_edits, pg_sleep(0.004)`);
      }
    }).finally(() => { done = true; });

    const tiles = tileTraffic(8, () => done, async () => {
      // A read is inside the owner's transaction exactly when it shares the
      // owner's transaction id. txid_current_if_assigned() is null for a
      // read that is not inside any transaction that has written yet, so a
      // match here can only mean it landed on the owner's open transaction.
      const r = await conn.query<{ t: string | null; n: string }>(
        `SELECT txid_current_if_assigned()::text AS t, (SELECT COUNT(*) FROM egdb_shared_edits) AS n`);
      return { inTx: r[0]!.t === ownerTxid };
    });

    const [postResult, stats] = await Promise.allSettled([post, tiles]);
    expect(postResult.status).toBe('fulfilled');
    const s = (stats as PromiseFulfilledResult<ReadStats>).value;
    expect(s.errors).toEqual({});
    expect(s.ok).toBeGreaterThan(20);
    expect(s.insideOwnerTx).toBe(0);
    const n = await conn.query<{ n: string }>(`SELECT COUNT(*) AS n FROM egdb_shared_edits`);
    expect(Number(n[0]!.n)).toBe(40);
  }, 60000);

  it('a second caller does not join a transaction it did not open', async () => {
    await reset();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = conn.withTransaction(async () => {
      await conn.execute(`INSERT INTO egdb_shared_edits (who) VALUES ('owner')`);
      await gate;
      throw new Error('owner failed');
    }).catch((e: Error) => e.message);
    await sleep(50);

    expect(conn.inTransaction()).toBe(false);
    const saving = conn.withTransaction(async () => {
      await conn.execute(`INSERT INTO egdb_shared_edits (who) VALUES ('other-user')`);
    });
    await sleep(50);
    release();

    expect(await owner).toBe('owner failed');
    await saving;
    const rows = await conn.query<{ who: string }>(`SELECT who FROM egdb_shared_edits`);
    expect(rows.map((r) => r.who)).toEqual(['other-user']);
  }, 30000);
});
