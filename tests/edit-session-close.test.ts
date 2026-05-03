/**
 * Tests for EditSession.close().
 *
 * close() must release the state lock through the geodatabase's logger when
 * the release fails — a swallowed unlock leaves a row in SDE_state_locks
 * that compress will respect indefinitely, so consumers need to see it.
 */

import { describe, it, expect } from 'vitest';
import { EditSession } from '../src/edit-session';
import type { Logger } from '../src/logger';
import type {
  IDatabaseConnection,
  ExecuteResult,
} from '../src/connections/connection';
import type { VersionInfo } from '../src/types';

function captureLogger(): Logger & {
  calls: Array<{ level: 'warn' | 'error'; message: string; error?: unknown }>;
} {
  const calls: Array<{ level: 'warn' | 'error'; message: string; error?: unknown }> = [];
  return {
    calls,
    warn(message, error) {
      calls.push({ level: 'warn', message, error });
    },
    error(message, error) {
      calls.push({ level: 'error', message, error });
    },
  };
}

function makeMockConnection(opts: {
  failReleaseLock?: boolean;
}): IDatabaseConnection {
  return {
    driver: 'sqlserver',
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
    async execute(sql: string): Promise<ExecuteResult> {
      if (opts.failReleaseLock && /SDE_state_locks/.test(sql)) {
        throw new Error('connection reset');
      }
      return { rowsAffected: 1 };
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
  geodatabase: { logger: Logger }
): EditSession {
  const versionInfo: VersionInfo = {
    name: 'edit_v1',
    owner: 'pa',
    parentName: 'sde.DEFAULT',
    description: '',
    access: 'private',
    stateId: 100,
  };
  // Reach past the private constructor; start() needs a full geodatabase.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = EditSession as any;
  const session = new Ctor(geodatabase, connection, versionInfo, 101, 100);
  // Pretend a lock was acquired so close() exercises the release path.
  session.stateLockSdeId = 73;
  return session;
}

describe('EditSession.close() lock-release failure', () => {
  it('routes the warning through the geodatabase logger, not console', async () => {
    const logger = captureLogger();
    const connection = makeMockConnection({ failReleaseLock: true });
    const session = buildSession(connection, { logger });

    await session.close();

    const releaseWarn = logger.calls.find((c) =>
      /Failed to release state lock/.test(c.message)
    );
    expect(releaseWarn).toBeDefined();
    expect(releaseWarn!.level).toBe('warn');
    expect(releaseWarn!.error).toBeInstanceOf(Error);
    expect((releaseWarn!.error as Error).message).toBe('connection reset');
  });

  it('does not log on the success path', async () => {
    const logger = captureLogger();
    const connection = makeMockConnection({ failReleaseLock: false });
    const session = buildSession(connection, { logger });

    await session.close();

    expect(logger.calls).toEqual([]);
  });
});
