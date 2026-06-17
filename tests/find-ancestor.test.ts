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
import { findCommonAncestor } from '../src/reconcile/find-ancestor';
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
