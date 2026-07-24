/**
 * Verifies the compress applock PRIMITIVE (N9) with two independent sessions
 * contending for the same fabric-wide lock: exclusive blocks shared and vice
 * versa, shared coexists with shared, timeouts throw ApplockTimeoutError, and the
 * lock auto-releases on transaction end. This is the foundation the compress
 * exclusive hold and the editor shared locks are built on.
 *
 * Gated on EGDB_COMPRESS_DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { acquireCompressLock, ApplockTimeoutError } from '../../src/reconcile/applock';
import { connectScratch, connectRaw, HAVE_DB } from './db';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;
const DB = 'egdb_compress_lock';

d('compress applock primitive (DB-backed, two sessions)', () => {
  let a: SqlServerConnection;
  let b: SqlServerConnection;
  beforeAll(async () => { a = await connectScratch(DB); b = await connectRaw(DB); });
  afterAll(async () => { if (a) await a.close(); if (b) await b.close(); });

  it('requires a transaction', async () => {
    await expect(acquireCompressLock(a, 'Exclusive', 100)).rejects.toThrow(/inside a transaction/);
  });

  it('EXCLUSIVE blocks a concurrent SHARED (editor bounces with a timeout)', async () => {
    await a.beginTransaction();
    await acquireCompressLock(a, 'Exclusive', 5000);
    try {
      await b.beginTransaction();
      // b (editor) can't get shared while a (compress) holds exclusive → bounces.
      await expect(acquireCompressLock(b, 'Shared', 300)).rejects.toThrow(ApplockTimeoutError);
      await b.rollbackTransaction();
    } finally {
      await a.rollbackTransaction();
    }
    // Once a released, b can acquire shared.
    await b.beginTransaction();
    await expect(acquireCompressLock(b, 'Shared', 2000)).resolves.toBeUndefined();
    await b.rollbackTransaction();
  });

  it('SHARED blocks a concurrent EXCLUSIVE (compress waits/defers on active editor)', async () => {
    await b.beginTransaction();
    await acquireCompressLock(b, 'Shared', 5000);
    try {
      await a.beginTransaction();
      await expect(acquireCompressLock(a, 'Exclusive', 300)).rejects.toThrow(ApplockTimeoutError);
      await a.rollbackTransaction();
    } finally {
      await b.rollbackTransaction();
    }
  });

  it('SHARED and SHARED coexist (normal multi-editor editing is unaffected)', async () => {
    await a.beginTransaction();
    await b.beginTransaction();
    await acquireCompressLock(a, 'Shared', 2000);
    await expect(acquireCompressLock(b, 'Shared', 2000)).resolves.toBeUndefined();
    await a.rollbackTransaction();
    await b.rollbackTransaction();
  });

  it('auto-releases on transaction rollback/commit', async () => {
    await a.beginTransaction();
    await acquireCompressLock(a, 'Exclusive', 2000);
    await a.rollbackTransaction(); // releases
    // b immediately gets exclusive — proves a's lock is gone.
    await b.beginTransaction();
    await expect(acquireCompressLock(b, 'Exclusive', 2000)).resolves.toBeUndefined();
    await b.rollbackTransaction();
  });
});
