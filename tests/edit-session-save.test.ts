/**
 * Save-path tests for EditSession.
 *
 * These tests reach past the private constructor to exercise save() in
 * isolation — the start() path needs a full geodatabase fixture, but save()
 * itself is just a CAS UPDATE we can verify with a mock connection.
 */

import { describe, it, expect } from 'vitest';
import { EditSession } from '../src/edit-session';
import type {
  IDatabaseConnection,
  ExecuteResult,
} from '../src/connections/connection';
import type { VersionInfo } from '../src/types';

interface MockState {
  /** rowsAffected the next execute() will report */
  nextRowsAffected: number;
  /** captured execute() calls */
  calls: Array<{ sql: string; params?: unknown[] }>;
}

function makeMockConnection(
  state: MockState,
  driver: 'sqlserver' | 'postgresql' = 'sqlserver'
): IDatabaseConnection {
  return {
    driver,
    isConnected: true,
    async connect() {},
    async close() {},
    async query() {
      return [];
    },
    async *stream() {},
    async scalar() {
      return null;
    },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      state.calls.push({ sql, params });
      return { rowsAffected: state.nextRowsAffected };
    },
    async executeInsert() {
      return [];
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    inTransaction() {
      return false;
    },
  };
}

function buildSession(
  connection: IDatabaseConnection,
  parentStateId: number,
  childStateId: number
): EditSession {
  const versionInfo: VersionInfo = {
    name: 'edit_v1',
    owner: 'pa',
    parentName: 'sde.DEFAULT',
    description: '',
    access: 'private',
    stateId: parentStateId,
  };
  // The constructor is `private` to TS but callable at runtime; the public
  // start() path is too DB-bound to use here. We reach in directly to focus
  // the test on save()'s CAS contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = EditSession as any;
  return new Ctor(
    /* geodatabase */ {} as never,
    connection,
    versionInfo,
    childStateId,
    parentStateId
  );
}

describe('EditSession.save() CAS', () => {
  it('emits a CAS UPDATE that gates on the parent state', async () => {
    const state: MockState = { nextRowsAffected: 1, calls: [] };
    const session = buildSession(makeMockConnection(state, 'sqlserver'), 100, 101);

    await session.save();

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0]!;
    expect(call.sql.replace(/\s+/g, ' ')).toMatch(
      /UPDATE sde\.SDE_versions SET state_id = @p0 WHERE owner = @p1 AND name = @p2 AND state_id = @p3/
    );
    // [newStateId, owner, name, parentStateId]
    expect(call.params).toEqual([101, 'pa', 'edit_v1', 100]);
  });

  it('uses the postgres parameter style on postgres', async () => {
    const state: MockState = { nextRowsAffected: 1, calls: [] };
    const session = buildSession(makeMockConnection(state, 'postgresql'), 100, 101);

    await session.save();

    expect(state.calls[0]!.sql.replace(/\s+/g, ' ')).toMatch(
      /UPDATE sde\.sde_versions SET state_id = \$1 WHERE owner = \$2 AND name = \$3 AND state_id = \$4/
    );
  });

  it('throws an actionable error when the CAS misses', async () => {
    const state: MockState = { nextRowsAffected: 0, calls: [] };
    const session = buildSession(makeMockConnection(state), 100, 101);

    await expect(session.save()).rejects.toThrow(
      /modified by another session.*Reconcile and start a new session/s
    );
  });

  it('mentions the expected parent state in the CAS-miss error', async () => {
    const state: MockState = { nextRowsAffected: 0, calls: [] };
    const session = buildSession(makeMockConnection(state), 42, 43);

    await expect(session.save()).rejects.toThrow(/expected state 42/);
  });

  it('refuses to save twice (state machine guard)', async () => {
    const state: MockState = { nextRowsAffected: 1, calls: [] };
    const session = buildSession(makeMockConnection(state), 100, 101);

    await session.save();
    await expect(session.save()).rejects.toThrow(/saved/);
  });
});
