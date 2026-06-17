/**
 * Unit tests for the async readers-writer lock used to serialise a shared
 * connection's transactions against concurrent statements.
 */

import { describe, it, expect } from 'vitest';
import { RwLock } from '../src/utils/rw-lock';

/** A deferred that lets a test hold a lock open until it decides to release. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('RwLock', () => {
  it('lets multiple readers run concurrently', async () => {
    const lock = new RwLock();
    const a = deferred();
    const b = deferred();
    let active = 0;
    let maxActive = 0;

    const reader = (gate: Promise<void>) =>
      lock.read(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        active--;
      });

    const r1 = reader(a.promise);
    const r2 = reader(b.promise);
    // Both should have entered before either releases.
    await Promise.resolve();
    await Promise.resolve();
    expect(maxActive).toBe(2);
    a.resolve();
    b.resolve();
    await Promise.all([r1, r2]);
  });

  it('gives a writer exclusive access (no reader or other writer overlaps)', async () => {
    const lock = new RwLock();
    const order: string[] = [];
    let inWrite = false;

    const writer = (tag: string, gate: Promise<void>) =>
      lock.write(async () => {
        expect(inWrite).toBe(false);
        inWrite = true;
        order.push(`w${tag}:enter`);
        await gate;
        order.push(`w${tag}:exit`);
        inWrite = false;
      });

    const g1 = deferred();
    const g2 = deferred();
    const w1 = writer('1', g1.promise);
    const w2 = writer('2', g2.promise);
    await Promise.resolve();
    // Only the first writer is in.
    expect(order).toEqual(['w1:enter']);
    g1.resolve();
    await Promise.resolve();
    await Promise.resolve();
    g2.resolve();
    await Promise.all([w1, w2]);
    expect(order).toEqual(['w1:enter', 'w1:exit', 'w2:enter', 'w2:exit']);
  });

  it('blocks a writer until in-flight readers drain', async () => {
    const lock = new RwLock();
    const events: string[] = [];
    const readGate = deferred();

    const r = lock.read(async () => {
      events.push('read:enter');
      await readGate.promise;
      events.push('read:exit');
    });
    // Writer queues behind the active reader.
    const w = lock.write(async () => {
      events.push('write:enter');
    });

    await Promise.resolve();
    expect(events).toEqual(['read:enter']);
    readGate.resolve();
    await Promise.all([r, w]);
    expect(events).toEqual(['read:enter', 'read:exit', 'write:enter']);
  });

  it('does not starve a waiting writer: a reader arriving after it waits', async () => {
    const lock = new RwLock();
    const events: string[] = [];
    const firstReadGate = deferred();

    const r1 = lock.read(async () => {
      events.push('r1:enter');
      await firstReadGate.promise;
      events.push('r1:exit');
    });
    await Promise.resolve();
    // Writer queues while r1 holds the shared lock.
    const w = lock.write(async () => { events.push('w:enter'); });
    // A second reader arrives AFTER the writer — it must wait behind the writer.
    const r2 = lock.read(async () => { events.push('r2:enter'); });

    await Promise.resolve();
    expect(events).toEqual(['r1:enter']);
    firstReadGate.resolve();
    await Promise.all([r1, w, r2]);
    // Writer runs before the later reader.
    expect(events).toEqual(['r1:enter', 'r1:exit', 'w:enter', 'r2:enter']);
  });

  it('releases the lock even when the body throws', async () => {
    const lock = new RwLock();
    await expect(lock.write(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Lock must be free for the next acquirer.
    let ran = false;
    await lock.write(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('throws on unbalanced release', () => {
    const lock = new RwLock();
    expect(() => lock.releaseRead()).toThrow(/no active reader/);
    expect(() => lock.releaseWrite()).toThrow(/no active writer/);
  });
});
