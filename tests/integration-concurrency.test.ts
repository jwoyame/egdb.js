/**
 * Integration tests for the concurrency primitives:
 *  - EditSession state isolation (child state + lock)
 *  - save() compare-and-swap on the version state
 *  - postVersion serialization via version lock
 *  - cleanupStaleLocks
 *
 * These hit a live SDE-enabled SQL Server. They skip cleanly when the
 * EGDB_* env vars aren't set, so `yarn test:run` stays fast in CI without
 * a database.
 *
 * Each test creates its own version with a unique name and cleans up
 * after itself. Tests do not share state and can run in any order.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EnterpriseGeodatabase, EditSession } from '../src/index';

// SQL Server-only for now: synthetic-lock test uses GETDATE(), connect()
// hardcodes the sqlserver driver, etc. Postgres support is straightforward
// when needed but isn't covered by these assertions today.
const SKIP =
  !process.env.EGDB_HOST ||
  !process.env.EGDB_PASSWORD ||
  (process.env.EGDB_DRIVER !== undefined && process.env.EGDB_DRIVER !== 'sqlserver');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set`);
  return value;
}

async function connect(): Promise<EnterpriseGeodatabase> {
  return EnterpriseGeodatabase.connect({
    driver: 'sqlserver',
    server: requireEnv('EGDB_HOST'),
    port: parseInt(requireEnv('EGDB_PORT'), 10),
    database: requireEnv('EGDB_DATABASE'),
    user: requireEnv('EGDB_USER'),
    password: requireEnv('EGDB_PASSWORD'),
    options: { encrypt: false, trustServerCertificate: true },
  });
}

function uniqueVersionName(prefix: string): string {
  // Combine ms + random to avoid collisions across parallel test workers
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

const TEST_TABLE = process.env.EGDB_TEST_TABLE ?? 'PARCELFABRIC_PLANS';

describe.skipIf(SKIP)('Concurrency integration', () => {
  describe('cleanupStaleLocks', () => {
    let egdb: EnterpriseGeodatabase;

    beforeAll(async () => {
      egdb = await connect();
    });

    afterAll(async () => {
      // Best-effort: make sure we didn't leave the synthetic lock behind
      await egdb.query(`DELETE FROM sde.SDE_state_locks WHERE sde_id = 999999`).catch(() => {});
      await egdb.close();
    });

    it('removes a lock row whose sde_id has no live session', async () => {
      // Synthesize a stale lock against a state that already exists (state 0
      // is always present in a healthy SDE schema). The sde_id 999999 is far
      // outside the @@SPID range so no live session will collide.
      const syntheticSdeId = 999999;
      const syntheticStateId = 0;

      await egdb.query(
        `INSERT INTO sde.SDE_state_locks (sde_id, state_id, lock_type, lock_time)
         VALUES (@p0, @p1, 'E', GETDATE())`,
        [syntheticSdeId, syntheticStateId]
      );

      const result = await egdb.cleanupStaleLocks();
      expect(result.staleSdeIds).toContain(syntheticSdeId);
      expect(result.removedLocks).toBeGreaterThanOrEqual(1);

      const remaining = await egdb.query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM sde.SDE_state_locks WHERE sde_id = @p0`,
        [syntheticSdeId]
      );
      expect(remaining[0]?.cnt).toBe(0);
    });

    it('leaves the calling connection\'s own session lock alone', async () => {
      const versionName = uniqueVersionName('test_live_lock');
      const v = await egdb.createVersion(versionName, { parent: 'sde.DEFAULT' });
      const session = await EditSession.start(egdb, `${v.owner}.${v.name}`);
      try {
        const before = await egdb.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM sde.SDE_state_locks WHERE state_id = @p0`,
          [session.currentStateId]
        );
        expect(before[0]?.cnt).toBe(1);

        await egdb.cleanupStaleLocks();

        const after = await egdb.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM sde.SDE_state_locks WHERE state_id = @p0`,
          [session.currentStateId]
        );
        expect(after[0]?.cnt).toBe(1);
      } finally {
        await session.discard().catch(() => {});
        await session.close();
        await egdb.deleteVersion(`${v.owner}.${v.name}`).catch(() => {});
      }
    });

    it('leaves another live connection\'s lock alone (the dangerous case)', async () => {
      // The previous test only proves we don't kill our own SPID. The
      // real concern with sys.dm_exec_sessions is that without VIEW SERVER
      // STATE we'd see only ourselves and reap everyone else. Verify by
      // opening a SECOND connection, starting a session there, and running
      // cleanupStaleLocks from the FIRST connection.
      const otherEgdb = await connect();
      const versionName = uniqueVersionName('test_other_lock');
      const v = await otherEgdb.createVersion(versionName, { parent: 'sde.DEFAULT' });
      const fullName = `${v.owner}.${v.name}`;
      const otherSession = await EditSession.start(otherEgdb, fullName);

      try {
        const stateId = otherSession.currentStateId;
        // Run cleanup from the OTHER connection (egdb)
        await egdb.cleanupStaleLocks();

        const remaining = await egdb.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM sde.SDE_state_locks WHERE state_id = @p0`,
          [stateId]
        );
        expect(remaining[0]?.cnt).toBe(1);
      } finally {
        await otherSession.discard().catch(() => {});
        await otherSession.close();
        await otherEgdb.deleteVersion(fullName).catch(() => {});
        await otherEgdb.close();
      }
    });
  });

  describe('EditSession isolation and state lock', () => {
    let egdb: EnterpriseGeodatabase;

    beforeAll(async () => {
      egdb = await connect();
    });

    afterAll(async () => {
      await egdb.close();
    });

    it('records a row in SDE_state_locks for the duration of the session', async () => {
      const versionName = uniqueVersionName('test_isolation');
      const v = await egdb.createVersion(versionName, { parent: 'sde.DEFAULT' });
      const fullName = `${v.owner}.${v.name}`;

      const session = await EditSession.start(egdb, fullName);
      try {
        const stateId = session.currentStateId;
        const locked = await egdb.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM sde.SDE_state_locks WHERE state_id = @p0`,
          [stateId]
        );
        expect(locked[0]?.cnt).toBe(1);

        await session.close();

        const released = await egdb.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM sde.SDE_state_locks WHERE state_id = @p0`,
          [stateId]
        );
        expect(released[0]?.cnt).toBe(0);
      } finally {
        await egdb.deleteVersion(fullName).catch(() => {});
      }
    });

    it('discard() removes the child state and its lock atomically', async () => {
      const versionName = uniqueVersionName('test_discard');
      const v = await egdb.createVersion(versionName, { parent: 'sde.DEFAULT' });
      const fullName = `${v.owner}.${v.name}`;

      const session = await EditSession.start(egdb, fullName);
      const stateId = session.currentStateId;

      await session.discard();
      await session.close();

      const lockCount = await egdb.query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM sde.SDE_state_locks WHERE state_id = @p0`,
        [stateId]
      );
      expect(lockCount[0]?.cnt).toBe(0);

      const stateCount = await egdb.query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM sde.SDE_states WHERE state_id = @p0`,
        [stateId]
      );
      expect(stateCount[0]?.cnt).toBe(0);

      await egdb.deleteVersion(fullName).catch(() => {});
    });
  });

  describe('save() CAS', () => {
    // Two separate connections so the sessions truly run in parallel.
    let egdbA: EnterpriseGeodatabase;
    let egdbB: EnterpriseGeodatabase;

    beforeAll(async () => {
      egdbA = await connect();
      egdbB = await connect();
    });

    afterAll(async () => {
      await egdbA.close();
      await egdbB.close();
    });

    it('the second concurrent save against a shared version is rejected', async () => {
      const versionName = uniqueVersionName('test_cas');
      const v = await egdbA.createVersion(versionName, { parent: 'sde.DEFAULT' });
      const fullName = `${v.owner}.${v.name}`;

      try {
        const sessionA = await EditSession.start(egdbA, fullName);
        const sessionB = await EditSession.start(egdbB, fullName);

        // Touch each session's A table so save() has something to point at.
        // We don't care what the row contains — we care that save() succeeds
        // for the first and the CAS misses for the second.
        await sessionA.insert(TEST_TABLE, {
          attributes: { Name: `cas_a_${Date.now()}` },
        });
        await sessionB.insert(TEST_TABLE, {
          attributes: { Name: `cas_b_${Date.now()}` },
        });

        await sessionA.save();

        await expect(sessionB.save()).rejects.toThrow(
          /modified by another session/
        );

        // Cleanup: discard B's edits, close both
        // (B is still 'open' because save() threw before flipping state.)
        await sessionB.discard().catch(() => {});
        await sessionA.close();
        await sessionB.close();
      } finally {
        await egdbA.deleteVersion(fullName).catch(() => {});
      }
    });
  });
});
