/**
 * Which open transactions the current async call tree owns.
 *
 * A connection object is shared by many concurrent callers (one SDE login for
 * every app user), but it has one transaction slot. Only the code that opened
 * the transaction may run statements on it; everyone else must use the pool.
 * "The code that opened it" is the call tree of the callback passed to
 * withTransaction(): runAsOwner() binds a fresh token to exactly that callback
 * with AsyncLocalStorage.run(), so the token is visible to everything the
 * callback awaits or starts, and to nothing else.
 *
 * Do not replace run() with enterWith(). enterWith() changes the context of the
 * CALLER's current async resource, so the token leaks to the caller's later
 * code and to siblings started from the same synchronous frame (for example the
 * other branch of a Promise.all). run() has no such leak.
 *
 * The store is a set so ownership nests across connections: a callback that
 * owns a transaction on connection A and opens one on connection B owns both
 * inside B's callback. Tokens are per transaction, so a token captured by a
 * timer or a detached promise stops matching once its transaction ends.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const ownedTokens = new AsyncLocalStorage<ReadonlySet<object>>();

/** True when `token` is non-null and the current call tree owns it. */
export function ownsToken(token: object | null): boolean {
  if (token === null) return false;
  return ownedTokens.getStore()?.has(token) ?? false;
}

/** Run `fn` as the owner of `token`, keeping any tokens the caller already owns. */
export function runAsOwner<T>(token: object, fn: () => Promise<T>): Promise<T> {
  const next = new Set(ownedTokens.getStore());
  next.add(token);
  return ownedTokens.run(next, fn);
}
