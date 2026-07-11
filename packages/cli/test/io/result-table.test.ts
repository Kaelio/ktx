import { describe, expect, it } from 'vitest';
import { formatValue, printResultTable } from '../../src/io/result-table.js';
import type { KtxCliIo } from '../../src/cli-runtime.js';

function captureIo(): { io: KtxCliIo; out: () => string } {
  let buffer = '';
  const io = {
    stdout: { write: (s: string) => { buffer += s; return true; } },
    stderr: { write: () => true },
  } as unknown as KtxCliIo;
  return { io, out: () => buffer };
}

describe('formatValue', () => {
  it('renders null/undefined as empty, scalars as strings, objects as JSON', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
    expect(formatValue('x')).toBe('x');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(10n)).toBe('10');
    expect(formatValue({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });
});

describe('printResultTable', () => {
  const table = { connectionId: 'mongo', headers: ['_id', 'city'], rows: [['a1', 'NY']], rowCount: 1 };

  it('json mode prints the structured payload', () => {
    const { io, out } = captureIo();
    printResultTable(table, 'json', io);
    expect(JSON.parse(out())).toEqual(table);
  });

  it('plain mode prints tab-separated headers and rows', () => {
    const { io, out } = captureIo();
    printResultTable(table, 'plain', io);
    expect(out()).toBe('_id\tcity\na1\tNY\n');
  });

  it('pretty mode prints a header rule and a singular row count', () => {
    const { io, out } = captureIo();
    printResultTable(table, 'pretty', io);
    expect(out()).toContain('_id');
    expect(out()).toContain('1 row\n');
  });

  it('pretty mode aligns multiple rows and pluralizes the row count', () => {
    const { io, out } = captureIo();
    const multi = {
      connectionId: 'mongo',
      headers: ['id', 'city'],
      rows: [
        ['1', 'NY'],
        ['1000', 'Indianapolis'],
      ],
      rowCount: 2,
    };
    printResultTable(multi, 'pretty', io);
    // Column widened to the longest cell ("1000"), so "1" is right-padded to 4 chars.
    expect(out()).toContain('1     NY');
    expect(out()).toContain('2 rows\n');
  });

  it('pretty mode omits the header rule when there are no headers', () => {
    const { io, out } = captureIo();
    printResultTable({ connectionId: 'mongo', headers: [], rows: [], rowCount: 0 }, 'pretty', io);
    expect(out()).toBe('\n0 rows\n');
  });
});
