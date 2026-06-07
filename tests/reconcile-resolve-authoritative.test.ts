/**
 * Tests for the resolveConflictAuthoritative option on applyParentChanges.
 *
 * The flag changes which decision wins:
 *   - default (false): auto-mergeable rows short-circuit to a merge using
 *     `suggestedMerge`. `resolveConflict` is only consulted for
 *     non-auto-mergeable conflicts. `getMergedValues` only runs when no
 *     `suggestedMerge` is present.
 *   - true: the `resolveConflict` callback is consulted for every conflict
 *     (auto-mergeable or not) and `getMergedValues` wins over
 *     `suggestedMerge` when both are present.
 *
 * These tests exercise the resolution branch by feeding applyParentChanges
 * one parent change and one matching conflict, then checking which SQL
 * statements ended up running.
 */

import { describe, it, expect } from 'vitest';
import { applyParentChanges } from '../src/reconcile/apply-changes';
import type {
  IDatabaseConnection,
  ExecuteResult,
} from '../src/connections/connection';
import type {
  DetailedConflict,
  TableInfo,
  VersionChanges,
} from '../src/types';

interface SqlCall {
  sql: string;
  params?: unknown[];
}

function makeMockConnection(): {
  conn: IDatabaseConnection;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const conn: IDatabaseConnection = {
    driver: 'sqlserver',
    isConnected: true,
    async connect() {},
    async close() {},
    async query() { return []; },
    async *stream() {},
    async scalar() { return null; },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      calls.push({ sql, params });
      return { rowsAffected: 0 };
    },
    async executeInsert() { return []; },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    inTransaction() { return false; },
  };
  return { conn, calls };
}

function makeTable(name: string): TableInfo {
  return {
    name,
    physicalName: name,
    schema: 'sde',
    isFeatureClass: false,
    isVersioned: true,
    registrationId: 42,
  };
}

const TABLE_NAME = 'TestTable';

function makeConflict(opts: {
  autoMergeable: boolean;
  suggestedMerge?: Record<string, unknown>;
}): DetailedConflict {
  return {
    table: TABLE_NAME,
    registrationId: 42,
    objectId: 100,
    childChangeType: 'update',
    parentChangeType: 'update',
    childStateId: 10,
    parentStateId: 5,
    fieldConflicts: opts.autoMergeable
      ? []
      : [{ field: 'Name', childValue: 'A', parentValue: 'B', baseValue: 'X' }],
    childOnlyChanges: opts.autoMergeable ? ['Name'] : [],
    parentOnlyChanges: opts.autoMergeable ? ['StatedArea'] : [],
    autoMergeable: opts.autoMergeable,
    suggestedMerge: opts.suggestedMerge,
  };
}

const ONE_PARENT_UPDATE: VersionChanges = {
  inserts: [],
  updates: [
    {
      table: TABLE_NAME,
      registrationId: 42,
      objectId: 100,
      stateId: 5,
      changeType: 'update',
    },
  ],
  deletes: [],
};

describe('applyParentChanges resolveConflictAuthoritative', () => {
  it('default mode: auto-mergeable short-circuits to a merge using suggestedMerge', async () => {
    const { conn, calls } = makeMockConnection();
    const callbackCalls: DetailedConflict[] = [];

    const result = await applyParentChanges(
      conn,
      [makeTable(TABLE_NAME)],
      ONE_PARENT_UPDATE,
      [makeConflict({ autoMergeable: true, suggestedMerge: { Name: 'A', StatedArea: '1 ac' } })],
      10,
      {
        autoMerge: true,
        resolveConflict: async (c) => {
          callbackCalls.push(c);
          // Pretend the caller wants Keep yours, but autoMerge should short-
          // circuit before the callback runs in default mode.
          return 'favor_edit';
        },
      },
    );

    expect(callbackCalls).toHaveLength(0);
    expect(result.mergedCount).toBe(1);
    expect(result.appliedCount).toBe(0);
    // applyMergedRow runs an UPDATE on the a-table.
    expect(calls.some(c => /UPDATE\s+\[sde\]\.\[a42\]/i.test(c.sql))).toBe(true);
  });

  it('authoritative mode: callback is consulted for auto-mergeable rows and can override', async () => {
    const { conn, calls } = makeMockConnection();
    const seen: string[] = [];

    const result = await applyParentChanges(
      conn,
      [makeTable(TABLE_NAME)],
      ONE_PARENT_UPDATE,
      [makeConflict({ autoMergeable: true, suggestedMerge: { Name: 'A', StatedArea: '1 ac' } })],
      10,
      {
        autoMerge: true,
        resolveConflictAuthoritative: true,
        resolveConflict: async (c) => {
          seen.push(`${c.table}:${c.objectId}`);
          return 'favor_edit';
        },
      },
    );

    expect(seen).toEqual([`${TABLE_NAME}:100`]);
    expect(result.mergedCount).toBe(0);
    expect(result.appliedCount).toBe(0);
    // favor_edit skips the parent change. No UPDATE / DELETE / INSERT on
    // the a-table.
    expect(calls.length).toBe(0);
  });

  it('authoritative mode: getMergedValues wins over suggestedMerge', async () => {
    const { conn, calls } = makeMockConnection();
    const customMerge = { Name: 'CUSTOM', StatedArea: '99 ac' };

    await applyParentChanges(
      conn,
      [makeTable(TABLE_NAME)],
      ONE_PARENT_UPDATE,
      [makeConflict({ autoMergeable: true, suggestedMerge: { Name: 'A', StatedArea: '1 ac' } })],
      10,
      {
        resolveConflictAuthoritative: true,
        resolveConflict: async () => 'merge',
        getMergedValues: async () => customMerge,
      },
    );

    // The applyMergedRow UPDATE should carry CUSTOM and 99 ac, not A / 1 ac.
    const updateCall = calls.find(c => /UPDATE\s+\[sde\]\.\[a42\]/i.test(c.sql));
    expect(updateCall).toBeDefined();
    const params = updateCall!.params ?? [];
    expect(params).toContain('CUSTOM');
    expect(params).toContain('99 ac');
    expect(params).not.toContain('A');
    expect(params).not.toContain('1 ac');
  });

  it('default mode (no flag): suggestedMerge still wins over getMergedValues for backwards compatibility', async () => {
    const { conn, calls } = makeMockConnection();
    const customMerge = { Name: 'CUSTOM', StatedArea: '99 ac' };

    await applyParentChanges(
      conn,
      [makeTable(TABLE_NAME)],
      ONE_PARENT_UPDATE,
      [makeConflict({ autoMergeable: true, suggestedMerge: { Name: 'A', StatedArea: '1 ac' } })],
      10,
      {
        autoMerge: true,
        getMergedValues: async () => customMerge,
      },
    );

    const updateCall = calls.find(c => /UPDATE\s+\[sde\]\.\[a42\]/i.test(c.sql));
    expect(updateCall).toBeDefined();
    const params = updateCall!.params ?? [];
    expect(params).toContain('A');
    expect(params).toContain('1 ac');
    expect(params).not.toContain('CUSTOM');
  });

  it('authoritative mode: throws when no resolveConflict callback is supplied', async () => {
    const { conn } = makeMockConnection();

    await expect(
      applyParentChanges(
        conn,
        [makeTable(TABLE_NAME)],
        ONE_PARENT_UPDATE,
        [makeConflict({ autoMergeable: true, suggestedMerge: { Name: 'A' } })],
        10,
        {
          resolveConflictAuthoritative: true,
        },
      ),
    ).rejects.toThrow(/resolveConflictAuthoritative requires a resolveConflict callback/);
  });
});
