/**
 * Pluggable logger for library code.
 *
 * Library code should never write directly to `console.*` because consumers
 * may want to silence warnings, route them to a structured logger, or treat
 * them as fatal in tests. Pass a `logger` on `ConnectionConfig` to override
 * the default (which writes to `console.warn` / `console.error`).
 */

export interface Logger {
  /**
   * Recoverable problem the operator should know about.
   * Example: a state-lock release failed; the lock will linger until cleaned up.
   */
  warn(message: string, error?: unknown): void;

  /**
   * Unrecoverable problem; the caller will typically also throw.
   */
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  warn(message, error) {
    if (error !== undefined) console.warn(message, error);
    else console.warn(message);
  },
  error(message, error) {
    if (error !== undefined) console.error(message, error);
    else console.error(message);
  },
};
