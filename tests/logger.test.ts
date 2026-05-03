/**
 * Tests for the pluggable Logger interface and the consoleLogger default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLogger } from '../src/logger';

describe('consoleLogger', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('writes warn to console.warn', () => {
    consoleLogger.warn('hello');
    expect(warnSpy).toHaveBeenCalledWith('hello');
  });

  it('passes error context when supplied', () => {
    const err = new Error('boom');
    consoleLogger.warn('something failed', err);
    expect(warnSpy).toHaveBeenCalledWith('something failed', err);
  });

  it('writes error to console.error', () => {
    consoleLogger.error('fatal');
    expect(errorSpy).toHaveBeenCalledWith('fatal');
  });

  it('omits the second arg when no error context is supplied', () => {
    consoleLogger.warn('plain message');
    // Should be called with exactly one argument, not (message, undefined)
    expect(warnSpy).toHaveBeenCalledWith('plain message');
    expect(warnSpy.mock.calls[0]).toHaveLength(1);
  });
});
