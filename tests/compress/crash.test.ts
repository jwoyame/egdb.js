/**
 * Deterministic crash-injection: prove compress is CRASH-SAFE — a process death
 * at any point leaves a state from which a clean re-run recovers with no version
 * losing or gaining a single row (COMPRESS_HARDENING_PLAN.md §6, defect C7).
 *
 * For a fixture rich enough to exercise all three phases, we first count the
 * mutating statements N of a clean compress, then for k = 1..N: reset, rebuild,
 * crash after statement k, roll back any transaction the "dead" client left open,
 * re-run compress to completion, and assert every version resolves exactly the
 * pre-compress data with all structural invariants intact.
 *
 * Gated on EGDB_COMPRESS_DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeGraduablePrefix, graduateTable, pruneStates, collapseLineages } from '../../src/reconcile/compress-impl';
import { connectScratch, resetFabric, HAVE_DB, PARCELS } from './db';
import { materialize } from './fabric-builder';
import { snapshotVisible, assertVisibleDataUnchanged, assertStructuralInvariants, type VisibleSnapshot } from './invariants';
import { generate } from './op-model';
import { CrashConnection, CrashInjected } from './crash-proxy';
import type { SqlServerConnection } from '../../src/connections/sqlserver';
import type { IDatabaseConnection } from '../../src/connections/connection';

const d = HAVE_DB ? describe : describe.skip;

async function dbCompress(conn: IDatabaseConnection): Promise<void> {
  const prefix = await computeGraduablePrefix(conn);
  await graduateTable(conn, PARCELS, prefix);
  await pruneStates(conn, [PARCELS]);
  await collapseLineages(conn, [PARCELS]);
}

d('compress crash-safety (DB-backed)', () => {
  let conn: SqlServerConnection;
  beforeAll(async () => { conn = await connectScratch('egdb_compress_crash'); });
  afterAll(async () => { if (conn) await conn.close(); });

  // Seed 72 grows a fabric exercising graduate (shared prefix), prune (abandoned
  // version) and a multi-pair collapse with an add-then-delete — all three phases.
  const seed = 72;

  async function rebuild(): Promise<VisibleSnapshot> {
    await resetFabric(conn);
    await materialize(conn, generate(seed, 18).fabric);
    return snapshotVisible(conn);
  }

  it('a clean compress establishes the baseline and a statement count', async () => {
    const before = await rebuild();
    const counter = new CrashConnection(conn); // target Infinity → never throws, just counts
    await dbCompress(counter);
    const after = await snapshotVisible(conn);
    assertVisibleDataUnchanged(before, after);
    await assertStructuralInvariants(conn);
    expect(counter.stepsExecuted).toBeGreaterThan(10); // fixture really does work
  });

  it('crashing after every mutating statement still recovers with no data loss', async () => {
    // Discover N (mutating-statement count) from a clean run.
    await rebuild();
    const probe = new CrashConnection(conn);
    await dbCompress(probe);
    const N = probe.stepsExecuted;
    const commitSteps = probe.trace.map((k, i) => (k === 'commit' ? i + 1 : 0)).filter(Boolean);

    let recoveries = 0;
    for (let k = 1; k <= N; k++) {
      const before = await rebuild();
      const crash = new CrashConnection(conn, k);
      let threw = false;
      try { await dbCompress(crash); } catch (e) {
        if (!(e instanceof CrashInjected)) throw e;
        threw = true;
      }
      expect(threw, `expected an injected crash at step ${k}`).toBe(true);
      // The client "died": abort whatever transaction it left open (the DB would).
      if (conn.inTransaction()) await conn.rollbackTransaction();

      // Recovery: a fresh compress run must complete and lose/gain nothing.
      await dbCompress(conn);
      const after = await snapshotVisible(conn);
      try {
        assertVisibleDataUnchanged(before, after);
        await assertStructuralInvariants(conn);
      } catch (e) {
        throw new Error(`recovery FAILED after crash at step ${k}/${N} (commit steps: ${commitSteps.join(',')}): ${(e as Error).message}`);
      }
      recoveries++;
    }
    expect(recoveries).toBe(N);
  }, 180_000);
});
