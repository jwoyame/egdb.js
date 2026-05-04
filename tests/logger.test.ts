/**
 * Tests for the pluggable Logger interface and the consoleLogger default,
 * plus the parser-logger plumbing routed via setParserLogger.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLogger, type Logger } from '../src/logger';
import { parseWkb, setParserLogger } from '../src/parsers/geometry-parser';

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

describe('setParserLogger', () => {
  function captureLogger(): Logger & { calls: Array<{ level: string; message: string }> } {
    const calls: Array<{ level: string; message: string }> = [];
    return {
      calls,
      warn(message) {
        calls.push({ level: 'warn', message });
      },
      error(message) {
        calls.push({ level: 'error', message });
      },
    };
  }

  // Build minimal valid WKB header for an "unsupported" geometry type:
  //   byte 0: byte-order (1 = little-endian)
  //   bytes 1-4: type (uint32 LE) — value 99 is not a known WKB type
  function unsupportedWkb(): Buffer {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(1, 0);
    buf.writeUInt32LE(99, 1);
    return buf;
  }

  // Restore default after each test so other tests aren't affected by global state
  afterEach(() => {
    setParserLogger(consoleLogger);
  });

  it('routes parser warnings through the configured logger instead of console', () => {
    const logger = captureLogger();
    setParserLogger(logger);

    const result = parseWkb(unsupportedWkb());
    expect(result).toBeNull();

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.level).toBe('warn');
    expect(logger.calls[0]!.message).toMatch(/Unsupported geometry type: 99/);
  });

  it('reverts to consoleLogger when reset', () => {
    const logger = captureLogger();
    setParserLogger(logger);
    parseWkb(unsupportedWkb());
    expect(logger.calls).toHaveLength(1);

    // Reset to default; subsequent calls should not reach the captured logger
    setParserLogger(consoleLogger);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseWkb(unsupportedWkb());
      expect(logger.calls).toHaveLength(1); // unchanged
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
