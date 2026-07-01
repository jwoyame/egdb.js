/**
 * Unit tests for findCommonAncestor — the reconcile/changes keystone.
 *
 * Regression guard for the bug where a version sharing DEFAULT's lineage_name
 * (the normal un-reconciled case) resolved its common ancestor to its own tip,
 * zeroing out the detected change set in Reconcile & Post + conflict detection.
 *
 * findCommonAncestor reuses getStatesInRange(state, 0) per side, which returns
 * the bounded, tip-inclusive ancestor closure. The mock returns those closures
 * (call 0 = child, call 1 = parent) so the JS intersection logic is exercised
 * over realistic state sets.
 */

import { describe, it, expect } from 'vitest';
import { findCommonAncestor, getStatesInRange } from '../src/reconcile/find-ancestor';
import type { IDatabaseConnection } from '../src/connections/connection';

function mockConn(closuresByCall: number[][]): IDatabaseConnection {
  let call = 0;
  return {
    driver: 'sqlserver',
    query: async () => {
      const rows = closuresByCall[call++] ?? [];
      return rows.map((s) => ({ state_id: s }));
    },
  } as unknown as IDatabaseConnection;
}

describe('findCommonAncestor', () => {
  it('returns the parent state when the version shares DEFAULT lineage (the bug case)', async () => {
    // Putnam shape: child tip 25070, DEFAULT 25066, all on lineage_name 24542.
    // The old impl returned 25070 (the child's own tip); correct is 25066.
    const child = [24814, 25008, 25066, 25067, 25068, 25069, 25070];
    const parent = [24814, 25008, 25066];
    expect(await findCommonAncestor(mockConn([child, parent]), 25070, 25066)).toBe(25066);
  });

  it('handles the ArcGIS self-row-absent shape (tip present via getStatesInRange UNION)', async () => {
    // getStatesInRange unions the tip even when the closure table lacks a
    // self-row, so its result is tip-inclusive; the parent tip is the ancestor.
    const child = [10, 20, 30, 40];
    const parent = [10, 20, 30];
    expect(await findCommonAncestor(mockConn([child, parent]), 40, 30)).toBe(30);
  });

  it('returns the divergence point for branched lineages (DEFAULT moved on)', async () => {
    const child = [10, 20, 40];
    const parent = [10, 20, 50];
    expect(await findCommonAncestor(mockConn([child, parent]), 40, 50)).toBe(20);
  });

  it('throws when the two states share no ancestor', async () => {
    await expect(
      findCommonAncestor(mockConn([[40], [50]]), 40, 50),
    ).rejects.toThrow(/common ancestor/);
  });
});

describe('getStatesInRange', () => {
  // Capture the SQL + params the function issues, and return canned rows.
  function spyConn(
    rows: unknown[],
    driver: 'sqlserver' | 'postgresql' = 'sqlserver',
  ): { conn: IDatabaseConnection; sql: () => string; params: () => unknown[] } {
    let lastSql = '';
    let lastParams: unknown[] = [];
    const conn = {
      driver,
      query: async (sql: string, params: unknown[]) => {
        lastSql = sql;
        lastParams = params;
        return rows.map((s) => ({ state_id: s }));
      },
    } as unknown as IDatabaseConnection;
    return { conn, sql: () => lastSql, params: () => lastParams };
  }

  it('derives ancestry from the parent_state_id tree, NOT the SDE_state_lineages closure', async () => {
    // Regression guard: reading the sparse closure dropped ArcMap-authored edit
    // states (Putnam atom_0329cloud: closure listed 6 states, real chain 148).
    const s = spyConn([]);
    await getStatesInRange(s.conn, 25066, 0);
    expect(s.sql()).toMatch(/parent_state_id/i);
    expect(s.sql()).not.toMatch(/state_lineages/i);
    expect(s.params()).toEqual([25066, 0]);
  });

  it('uses a recursive parent_state_id walk on Postgres too (not the closure)', async () => {
    const s = spyConn([], 'postgresql');
    await getStatesInRange(s.conn, 25066, 0);
    expect(s.sql()).toMatch(/WITH RECURSIVE/i);
    expect(s.sql()).toMatch(/parent_state_id/i);
    expect(s.sql()).not.toMatch(/state_lineages/i);
    expect(s.params()).toEqual([25066, 0]);
  });

  it('returns the ancestor states the query yields (numeric-coerced)', async () => {
    // SQL Server can hand back BIGINT state_id as a string; result must be numbers.
    const s = spyConn([24329, '24825', 25066]);
    const out = await getStatesInRange(s.conn, 25066, 24328);
    expect(out).toEqual([24329, 24825, 25066]);
  });

  it('throws on an invalid (non-integer/precision-lost) state_id from the DB', async () => {
    // toStateId coercion must fail loud: a bad state id must never silently
    // become NaN and mis-query the delta tables downstream.
    const s = spyConn(['not-a-number']);
    await expect(getStatesInRange(s.conn, 25066, 0)).rejects.toThrow();
  });
});
