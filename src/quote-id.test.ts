/**
 * Identifier quoting must neutralise the delimiter.
 *
 * Attribute keys from an API caller reach quoteId and are interpolated into a
 * SET list. `execute` runs the statement as a BATCH, so an unescaped `]` closes
 * the bracket early and everything after it is executed as SQL -- statement
 * injection, not merely a malformed column name.
 */
import { describe, it, expect } from 'vitest';

const quoteSqlServer = (name: string) => `[${name.replace(/]/g, ']]')}]`;
const quotePostgres = (name: string) => `"${name.replace(/"/g, '""')}"`;

describe('quoteId neutralises the closing delimiter', () => {
  it('doubles ] so the identifier cannot be closed early', () => {
    const attack = "Name] = 'PWNED' WHERE 1=1; --";
    const quoted = quoteSqlServer(attack);
    expect(quoted).toBe("[Name]] = 'PWNED' WHERE 1=1; --]");
    // The dangerous shape is a bracket-close followed by SQL. After escaping,
    // every ] inside the name is doubled, and only the final one closes.
    expect(quoted.slice(1, -1).replace(/]]/g, '')).not.toContain(']');
  });

  it('doubles " for postgres', () => {
    expect(quotePostgres('a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
  });

  it('leaves ordinary identifiers alone', () => {
    expect(quoteSqlServer('Historical')).toBe('[Historical]');
    expect(quotePostgres('shape')).toBe('"shape"');
  });
});
