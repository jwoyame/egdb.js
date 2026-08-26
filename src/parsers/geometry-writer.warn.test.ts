/**
 * The write path used to discard unwritable geometry in silence. It must not
 * do that any more: the drop still happens (turning it into a throw is a
 * separate, measured decision) but it has to leave a trace.
 */
import { describe, it, expect, vi } from 'vitest';
import { isWritableGeometry, setWriterLogger } from './geometry-writer';

const capture = () => {
  const warn = vi.fn();
  setWriterLogger({ warn, error: vi.fn() });
  return warn;
};

describe('isWritableGeometry', () => {
  it('passes writable geometry through without noise', () => {
    const warn = capture();
    const ok = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]], srid: 2236 };
    expect(isWritableGeometry(ok as never, 'test')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, naming the type and the call site, for every shape it drops', () => {
    // Well-formed curves ARE writable now, so the unwritable cases here are
    // malformed ones plus the degenerate coordinate shapes.
    const cases: Array<[string, unknown]> = [
      ['CurvePolygon', { type: 'CurvePolygon', rings: [] }],
      ['CircularString', { type: 'CircularString', coordinates: [[0, 0], [5, 5]] }],
      ['Polygon', { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] }],
      ['LineString', { type: 'LineString', coordinates: [[0, 0]] }],
    ];
    for (const [type, g] of cases) {
      const warn = capture();
      expect(isWritableGeometry(g as never, 'EditSession.insert')).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0]);
      expect(msg).toContain(type);
      expect(msg).toContain('EditSession.insert');
      expect(msg).toMatch(/no geometry|SHAPE column will be omitted/);
    }
  });
});

describe('the known legacy empty-Shape case stays quiet', () => {
  // ~9% of Putnam's legacy ArcMap lines carry no Shape. They pass through here
  // on every copy-forward during a post or reconcile. Warning on each would bury
  // the warnings that actually mean something.
  it('drops an empty-coordinates geometry without warning', () => {
    const warn = capture();
    expect(isWritableGeometry({ type: 'LineString', coordinates: [] } as never, 'post')).toBe(false);
    expect(isWritableGeometry({ type: 'Polygon', coordinates: [] } as never, 'post')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
