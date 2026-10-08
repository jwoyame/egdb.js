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
    await a.withTransaction(async () => {
      await acquireCompressLock(a, 'Exclusive', 5000);
      await b.withTransaction(async () => {
        // b (editor) can't get shared while a (compress) holds exclusive → bounces.
        await expect(acquireCompressLock(b, 'Shared', 300)).rejects.toThrow(ApplockTimeoutError);
      });
    });
    // Once a released, b can acquire shared.
    await b.withTransaction(async () => {
      await expect(acquireCompressLock(b, 'Shared', 2000)).resolves.toBeUndefined();
    });
  });

  it('SHARED blocks a concurrent EXCLUSIVE (compress waits/defers on active editor)', async () => {
    await b.withTransaction(async () => {
      await acquireCompressLock(b, 'Shared', 5000);
      await a.withTransaction(async () => {
        await expect(acquireCompressLock(a, 'Exclusive', 300)).rejects.toThrow(ApplockTimeoutError);
      });
    });
  });

  it('SHARED and SHARED coexist (normal multi-editor editing is unaffected)', async () => {
    await a.withTransaction(async () => {
      await b.withTransaction(async () => {
        await acquireCompressLock(a, 'Shared', 2000);
        await expect(acquireCompressLock(b, 'Shared', 2000)).resolves.toBeUndefined();
      });
    });
  });

  it('auto-releases on transaction end', async () => {
    await a.withTransaction(async () => {
      await acquireCompressLock(a, 'Exclusive', 2000);
    }); // releases
    // b immediately gets exclusive — proves a's lock is gone.
    await b.withTransaction(async () => {
      await expect(acquireCompressLock(b, 'Exclusive', 2000)).resolves.toBeUndefined();
    });
  });
});
