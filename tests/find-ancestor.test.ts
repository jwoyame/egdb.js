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
import { findCommonAncestor, getStatesInRange, BrokenLineageError } from '../src/reconcile/find-ancestor';
import type { IDatabaseConnection } from '../src/connections/connection';

// Mock: getStatesInRange issues a recursive CTE (contains "WITH"); isBaseRooted
// issues a plain `SELECT parent_state_id ... WHERE state_id = @p0`. We return the
// two closures for the CTE calls (child then parent) and, for the plain query,
// the parent_state_id of the requested state from `parentOf` ([] = row missing).
function mockConn(
  child: number[],
  parent: number[],
  parentOf: Record<number, number> = {},
): IDatabaseConnection {
  let closureCall = 0;
  return {
    driver: 'sqlserver',
    query: async (sql: string, params?: unknown[]) => {
      if (!/WITH/i.test(sql)) {
        const sid = (params as number[])[0]!;
        return sid in parentOf ? [{ parent_state_id: parentOf[sid] }] : [];
      }
      const rows = closureCall++ === 0 ? child : parent;
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
    expect(await findCommonAncestor(mockConn(child, parent), 25070, 25066)).toBe(25066);
  });

  it('handles the ArcGIS self-row-absent shape (tip present via getStatesInRange UNION)', async () => {
    // getStatesInRange unions the tip even when the closure table lacks a
    // self-row, so its result is tip-inclusive; the parent tip is the ancestor.
    const child = [10, 20, 30, 40];
    const parent = [10, 20, 30];
    expect(await findCommonAncestor(mockConn(child, parent), 40, 30)).toBe(30);
  });

  it('returns the divergence point for branched lineages (DEFAULT moved on)', async () => {
    const child = [10, 20, 40];
    const parent = [10, 20, 50];
    expect(await findCommonAncestor(mockConn(child, parent), 40, 50)).toBe(20);
  });

  it('returns base state 0 when both versions diverged at the base (compress-orphaned)', async () => {
    // Putnam Alex shape: child tip 21931 (parent_state_id 0), DEFAULT rooted at
    // 22052 (parent_state_id 0); they share nothing above the base. ArcMap
    // reconciles such a version against the base, so 0 is the common ancestor.
    const child = [21931];
    const parent = [22052, 23000, 25169];
    const conn = mockConn(child, parent, { 21931: 0, 22052: 0 });
    expect(await findCommonAncestor(conn, 21931, 25169)).toBe(0);
  });

  it('throws BrokenLineageError when a lineage does not reach the base (dangling parent)', async () => {
    // child's oldest state 40 claims parent 99, which is absent from the walk:
    // a damaged tree with no path to base. Must NOT silently diff against base.
    const conn = mockConn([40], [50], { 40: 99, 50: 0 });
    await expect(findCommonAncestor(conn, 40, 50)).rejects.toBeInstanceOf(BrokenLineageError);
  });

  it('throws BrokenLineageError on an empty closure (missing tip row)', async () => {
    const conn = mockConn([], [50], { 50: 0 });
    await expect(findCommonAncestor(conn, 40, 50)).rejects.toBeInstanceOf(BrokenLineageError);
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
