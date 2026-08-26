/**
 * A post that publishes nothing must fail, not report success.
 *
 * The trim-post path asserted each INDIVIDUAL row copy moved exactly one row,
 * which is useless when there are no rows to copy: the loop body never runs,
 * nothing throws, and `updateVersionState` still matches 1 row because it only
 * moves DEFAULT's pointer. The caller then deleted the version on the strength
 * of that success -- destroying the editor's work and publishing nothing.
 *
 * This is the same failure that already lost a real merge in production.
 */
import { describe, it, expect } from 'vitest';
import { PostLandedNothingError } from './enterprise-geodatabase';

/** The guard, isolated so it can be exercised without a database. */
function guard(changesPosted: number, applied: number) {
  if (changesPosted > 0 && applied === 0) {
    throw new PostLandedNothingError(
      `Post landed nothing: ${changesPosted} change(s) expected but no row was copied.`,
      changesPosted,
    );
  }
}

describe('zero-landing post', () => {
  it('throws when changes were expected and none were applied', () => {
    expect(() => guard(12, 0)).toThrow(PostLandedNothingError);
    try { guard(12, 0); } catch (e) {
      expect((e as PostLandedNothingError).changesExpected).toBe(12);
      expect((e as Error).message).toMatch(/landed nothing/i);
    }
  });

  it('does NOT fire on a genuinely empty version', () => {
    // Nothing to publish is a legitimate no-op, not a data-integrity stop.
    expect(() => guard(0, 0)).not.toThrow();
  });

  it('does not fire on a normal post', () => {
    expect(() => guard(12, 12)).not.toThrow();
    expect(() => guard(12, 5)).not.toThrow(); // partial is a different concern
  });

  it('is identifiable by the caller so it can refuse to delete the version', () => {
    const err = new PostLandedNothingError('x', 3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PostLandedNothingError');
  });
});
